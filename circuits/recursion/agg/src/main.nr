//! Hardened aggregator circuit for recursive proof aggregation.
//!
//! Recursively verifies NUM_BATCHES_K inner batch proofs and binds their
//! public outputs into a single on-chain proof. Four hardening constraints,
//! each negative-tested by the end-to-end soundness gate:
//!
//!   1. Inner-VK pin. The witnessed inner_vk is hashed in-circuit (Poseidon2
//!      binary tree over the vk fields, zero-padded to a power of two) and
//!      asserted equal to PINNED_INNER_VK_HASH. The hash is also passed as
//!      key_hash and exposed as the public inner_key_hash output.
//!   2. Per-batch range checks live in the pinned inner circuit (u64 balances).
//!   3. One shared binding root. Each proof's (subroot, subtotal) come from its
//!      public-input vector and are summed (u128) into L and composed into one
//!      final_root; both are outputs, not claimable inputs.
//!   4. Anti-reuse. Each proof's public inputs carry its slot; the aggregator
//!      asserts the verified slot equals the loop index k, so one batch proof
//!      cannot be replayed into two slots.
//!
//! PAIRING COMPLETION (load-bearing cross-component invariant): in-circuit
//! verify_ultrahonk_proof DEFERS its final pairing into the proof's 16-limb
//! pairing-point accumulator rather than checking it here. That deferred pairing
//! is COMPLETED on-chain by the host-accelerated verifier, which runs the
//! pairing check over the accumulator after the proof verifies. With that
//! completion the inner-VK binding (constraints 1+2) is enforced end-to-end: a
//! valid proof of a DIFFERENT inner circuit (e.g. one with no range check,
//! deflating its subtotal) folds and passes nargo execute, but the completed
//! pairing rejects it at the verifier. All four constraints hold.
//!
//! THEREFORE this aggregator is sound ONLY when its terminal proof is verified
//! by a verifier that completes the pairing-point accumulator. It must never be
//! paired with a verifier that skips that pairing -- such a verifier would
//! accept a foreign inner proof under the pinned vk array, silently breaking
//! constraints 1+2.
//!
//! CONTEXT BINDING: context_hash is a public parameter and the circuit does not
//! constrain it. Its only job is to enter the proof transcript, so a proof that
//! carries one context cannot verify as a proof that carries another. The
//! registry recomputes the expected value from its own state and builds the
//! public input bytes itself, so a prover cannot substitute a foreign context.
//! The circuit holds no witness for the authority, the asset, the reserve set,
//! or the snapshot, so there is nothing here to prove the value against.
//!
//! Public inputs : (context_hash, inner_key_hash, final_root, L).
//!                 context_hash is a parameter; the other three are outputs.
//! Private inputs: inner_vk, the K (proof, public_inputs).
//!
//! The outer proof is generated with the keccak oracle for the Soroban
//! host-accelerated verifier.

use dep::bb_proof_verification::verify_ultrahonk_proof;
use dep::recursion_common::subtree_root;

mod params;
use params::{
    INNER_PUB_LEN, NUM_BATCHES_K, PINNED_INNER_VK_HASH, PROOF_LEN, SLOT_IDX, SUBROOT_IDX,
    SUBTOTAL_IDX, VK_COMMIT_WIDTH, VK_LEN,
};

fn main(
    context_hash: pub Field,
    inner_vk: [Field; VK_LEN],
    proofs: [[Field; PROOF_LEN]; NUM_BATCHES_K],
    pub_inputs: [[Field; INNER_PUB_LEN]; NUM_BATCHES_K],
) -> pub (Field, Field, Field) {
    let _ = context_hash; // bound as a public input (context binding); see header
    // Constraint 1: pin the inner circuit. The vk is a witness, so hash it and
    // bind the hash to the pinned commitment; verify then uses this exact vk.
    let mut padded = [0; VK_COMMIT_WIDTH];
    for i in 0..VK_LEN {
        padded[i] = inner_vk[i];
    }
    let vk_hash = subtree_root(padded);
    assert(vk_hash == PINNED_INNER_VK_HASH);

    let mut subroots = [0; NUM_BATCHES_K];
    let mut total: u128 = 0;
    for k in 0..NUM_BATCHES_K {
        // Constraint 4: the verified proof must attest this slot, so the same
        // proof cannot be replayed into another slot (double-count / gap-fill).
        assert(pub_inputs[k][SLOT_IDX] == k as Field);
        // Constraints 1+2+3: verify binds (slot, subroot, subtotal) to this vk's
        // proof. Only the pinned (range-checking) inner circuit can satisfy it.
        verify_ultrahonk_proof(inner_vk, proofs[k], pub_inputs[k], vk_hash);
        subroots[k] = pub_inputs[k][SUBROOT_IDX];
        // The pinned inner circuit binds its subtotal to a u128 sum in the
        // field, so this cast reads the same value and cannot truncate.
        total += pub_inputs[k][SUBTOTAL_IDX] as u128;
    }
    // Constraint 3: deterministic single root + summed total, both as outputs.
    (vk_hash, subtree_root(subroots), total as Field)
}
