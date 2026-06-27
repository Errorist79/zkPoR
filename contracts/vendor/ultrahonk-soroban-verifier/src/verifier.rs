//! Top-level UltraHonk verifier orchestration.
//!
//! Implements the verifier flow that BB splits across `ultra_verifier.cpp`,
//! `oink_verifier.cpp`, and `decider_verifier.cpp`.  The Rust code inlines the
//! Oink and Decider steps into a single `verify` method.
//!
//! BB reference (v0.82.2):
//!   - `ultra_honk/ultra_verifier.cpp::UltraVerifier_::verify_proof`
//!   - `ultra_honk/oink_verifier.cpp::OinkVerifier::verify`
//!   - `ultra_honk/decider_verifier.cpp::DeciderVerifier_::verify`

use crate::{
    field::Fr,
    shplemini::verify_shplemini,
    sumcheck::verify_sumcheck,
    transcript::generate_transcript,
    types::PAIRING_POINTS_SIZE,
    utils::{load_proof, load_vk_from_bytes},
};
use soroban_sdk::{Bytes, Env};

/// Error type describing why a verification key could not be loaded from bytes.
///
/// Intentionally minimal: the VK is public data, so callers do not need a
/// fine-grained oracle. The two variants separate deployer mistakes (wrong
/// byte count) from invalid structural parameters that could indicate
/// corruption or an adversarially crafted VK.
#[derive(Debug, Copy, Clone, Eq, PartialEq)]
pub enum VkLoadError {
    /// Byte slice length does not match the exact expected VK size (1760 bytes).
    WrongLength,
    /// Header parsed successfully but contains out-of-range values.
    InvalidParameters,
}

/// Error type describing the specific reason verification failed.
#[derive(Debug)]
pub enum VerifyError {
    InvalidInput,
    SumcheckFailed,
    ShplonkFailed,
}

pub struct UltraHonkVerifier {
    env: Env,
    vk: crate::types::VerificationKey,
}

impl UltraHonkVerifier {
    pub fn new_with_vk(env: &Env, vk: crate::types::VerificationKey) -> Self {
        Self {
            env: env.clone(),
            vk,
        }
    }

    pub fn new(env: &Env, vk_bytes: &Bytes) -> Result<Self, VkLoadError> {
        load_vk_from_bytes(env, vk_bytes).map(|vk| Self::new_with_vk(env, vk))
    }

    /// Expose a reference to the parsed VK for debugging/inspection.
    pub fn get_vk(&self) -> &crate::types::VerificationKey {
        &self.vk
    }

    /// Verify an UltraHonk proof against the loaded VK.
    ///
    /// Steps (matching BB verifier flow):
    /// 1. Parse proof bytes.
    /// 2. Validate public-input length against VK metadata.
    /// 3. Generate Fiat–Shamir challenges (Oink rounds).
    /// 4. Compute `public_inputs_delta` (grand-product permutation argument).
    /// 5. Run sumcheck verification.
    /// 6. Run Shplemini batch-opening (Gemini + Shplonk + KZG pairing check).
    ///
    /// BB: `ultra_verifier.cpp::UltraVerifier_::verify_proof`
    pub fn verify(
        &self,
        env: &Env,
        proof_bytes: &Bytes,
        public_inputs_bytes: &Bytes,
    ) -> Result<(), VerifyError> {
        // 1) parse proof
        let proof = load_proof(env, proof_bytes).map_err(|_| VerifyError::InvalidInput)?;

        // 2) sanity on public inputs (length and VK metadata if present)
        if !public_inputs_bytes.len().is_multiple_of(32) {
            return Err(VerifyError::InvalidInput);
        }
        let provided = (public_inputs_bytes.len() / 32) as u64;
        let expected = self
            .vk
            .public_inputs_size
            .checked_sub(PAIRING_POINTS_SIZE as u64)
            .ok_or(VerifyError::InvalidInput)?;
        if expected != provided {
            return Err(VerifyError::InvalidInput);
        }

        // 3) Fiat–Shamir transcript
        let pis_total = provided + PAIRING_POINTS_SIZE as u64;
        let pub_inputs_offset = self.vk.pub_inputs_offset;
        let mut t = generate_transcript(
            &self.env,
            &proof,
            public_inputs_bytes,
            self.vk.circuit_size,
            pis_total,
            pub_inputs_offset,
        )
        .map_err(|_| VerifyError::InvalidInput)?;

        // 4) Public delta
        t.rel_params.public_inputs_delta = Self::compute_public_input_delta(
            env,
            public_inputs_bytes,
            &proof.pairing_point_object,
            &t.rel_params.beta,
            &t.rel_params.gamma,
            pub_inputs_offset,
            self.vk.circuit_size,
        )
        .map_err(|_| VerifyError::InvalidInput)?;

        // 5) Sum-check
        verify_sumcheck(env, &proof, &t, &self.vk).map_err(|_| VerifyError::SumcheckFailed)?;

        // 6) Shplonk
        verify_shplemini(&self.env, &proof, &self.vk, &t)
            .map_err(|_| VerifyError::ShplonkFailed)?;

        // RECOVERY FIX: complete the deferred recursive pairing (the 16-limb
        // pairing-point accumulator carried in the proof's public inputs).
        complete_pairing_point_accumulator(env, &proof.pairing_point_object)
            .map_err(|_| VerifyError::ShplonkFailed)?;

        Ok(())
    }

    /// Compute the public-input delta factor for the permutation grand-product argument.
    ///
    /// Formula (matching BB):
    ///   numerator   = ∏ᵢ (γ + xᵢ + β·(n + i + offset))
    ///   denominator = ∏ᵢ (γ + xᵢ − β·(1 + i + offset))
    ///   delta       = numerator · denominator⁻¹
    ///
    /// The pairing-point object values are appended after the user-supplied public inputs.
    ///
    /// BB: `honk/library/grand_product_delta.hpp::compute_public_input_delta`
    fn compute_public_input_delta(
        env: &Env,
        public_inputs: &Bytes,
        pairing_point_object: &[Fr],
        beta: &Fr,
        gamma: &Fr,
        offset: u64,
        n: u64,
    ) -> Result<Fr, &'static str> {
        let mut numerator = Fr::one(env);
        let mut denominator = Fr::one(env);

        let beta_n = beta * &Fr::from_u64(env, n + offset);
        let beta_off = beta * &Fr::from_u64(env, offset + 1);
        let mut numerator_acc = gamma + beta_n;
        let mut denominator_acc = gamma - &beta_off;

        let mut idx = 0u32;
        while idx < public_inputs.len() {
            let mut arr = [0u8; 32];
            public_inputs.slice(idx..idx + 32).copy_into_slice(&mut arr);
            let public_input = Fr::from_array(env, &arr);
            numerator = numerator * (&numerator_acc + &public_input);
            denominator = denominator * (&denominator_acc + &public_input);
            numerator_acc = &numerator_acc + beta;
            denominator_acc = &denominator_acc - beta;
            idx += 32;
        }
        for public_input in pairing_point_object {
            numerator = &numerator * &(&numerator_acc + public_input);
            denominator = &denominator * &(&denominator_acc + public_input);
            numerator_acc = &numerator_acc + beta;
            denominator_acc = &denominator_acc - beta;
        }
        if denominator.is_zero() {
            return Err("denominator is zero in public_input_delta");
        }
        let denominator_inv = denominator.inverse();
        Ok(numerator * denominator_inv)
    }
}


fn limb_u128(fr: &crate::field::Fr) -> u128 {
    let b = fr.to_bytes(); // 32-byte big-endian
    let mut a = [0u8; 16];
    a.copy_from_slice(&b[16..32]);
    u128::from_be_bytes(a)
}

// Compose four 68-bit limbs (little-endian order) into a 32-byte big-endian Fq coordinate.
fn coord_be(limbs: [u128; 4]) -> [u8; 32] {
    let mut le = [0u8; 32];
    let shifts = [0usize, 68, 136, 204];
    for k in 0..4 {
        let shift = shifts[k];
        let byte_off = shift / 8;
        let bit_off = (shift % 8) as u32;
        let shifted: u128 = if bit_off == 0 { limbs[k] } else { limbs[k] << bit_off };
        let bytes = shifted.to_le_bytes();
        let mut carry: u16 = 0;
        let mut i = 0;
        while i < bytes.len() && byte_off + i < 32 {
            let sm = le[byte_off + i] as u16 + bytes[i] as u16 + carry;
            le[byte_off + i] = (sm & 0xff) as u8;
            carry = sm >> 8;
            i += 1;
        }
        let mut j = byte_off + bytes.len();
        while carry > 0 && j < 32 {
            let sm = le[j] as u16 + carry;
            le[j] = (sm & 0xff) as u8;
            carry = sm >> 8;
            j += 1;
        }
    }
    let mut be = [0u8; 32];
    for i in 0..32 { be[i] = le[31 - i]; }
    be
}

fn point_from(pp: &[crate::field::Fr; 16], o: usize, env: &Env) -> crate::types::G1Point {
    let x = coord_be([limb_u128(&pp[o]), limb_u128(&pp[o + 1]), limb_u128(&pp[o + 2]), limb_u128(&pp[o + 3])]);
    let y = coord_be([limb_u128(&pp[o + 4]), limb_u128(&pp[o + 5]), limb_u128(&pp[o + 6]), limb_u128(&pp[o + 7])]);
    crate::types::G1Point::from_xy(env, &x, &y)
}

// Complete the deferred recursive KZG pairing carried in the aggregation object:
//   e(P0, [1]_2) * e(P1, [x]_2) == 1   (same convention as the shplemini pairing_check).
// P0 = limbs[0..8], P1 = limbs[8..16] (each coordinate = 4 x 68-bit limbs).
pub fn complete_pairing_point_accumulator(env: &Env, pp: &[crate::field::Fr; 16]) -> Result<(), &'static str> {
    let p0 = point_from(pp, 0, env);
    let p1 = point_from(pp, 8, env);
    if crate::ec::pairing_check(env, p0.as_bn254(), p1.as_bn254()) {
        Ok(())
    } else {
        Err("recursive pairing-point accumulator check failed")
    }
}
