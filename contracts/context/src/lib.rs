//! Shared encoding of the proof of reserves context.
//!
//! This crate is the one Rust definition of the address encoding, the reserve
//! set hash, the context hash, the leaf hash, and the salt derivation. The
//! registry contract, the witness generator, and the test vectors all use
//! these functions, so a value that one component computes always equals the
//! value another component computes.
#![no_std]

use soroban_poseidon::{poseidon2_hash, Field};
use soroban_sdk::{
    address_payload::AddressPayload, contracterror, crypto::bn254::Bn254Fr, Address, Bytes, Env,
    Vec, U256,
};

/// Byte length of a serialized field element.
pub const FR_BYTES: usize = 32;
/// Byte length of the payload of an accepted address.
pub const ADDRESS_PAYLOAD_BYTES: usize = 32;
/// Byte length of one address limb. The payload needs two limbs, because one
/// field element holds about 254 bits and a one-limb encoding would drop bits.
pub const ADDRESS_LIMB_BYTES: usize = 16;
/// Tag of an account address. The value is the XDR discriminant of the type.
pub const ADDRESS_TAG_ACCOUNT: u32 = 0;
/// Tag of a contract address. The value is the XDR discriminant of the type.
pub const ADDRESS_TAG_CONTRACT: u32 = 1;
/// Largest accepted reserve address count.
pub const MAX_RESERVE_ADDRESSES: u32 = 16;
/// Age window of an attestation, in ledgers. The registry enforces it.
pub const ATTESTATION_MAX_AGE_LEDGERS: u32 = 720;
/// The ASCII string of the context domain tag. The tag versions the preimage
/// layout, so a change of the field list or the order changes this string.
pub const CTX_DOMAIN_TAG_ASCII: &[u8; 16] = b"zkpor-context-v1";
/// The ASCII string of the salt domain tag. The input count does not separate
/// the salt derivation from the reserve set hash of two addresses, because
/// both hash four inputs, so the salt derivation carries this tag.
pub const SALT_DOMAIN_TAG_ASCII: &[u8; 13] = b"zkpor-salt-v1";
/// State width of the Poseidon2 sponge. The rate is the width minus one.
pub const POSEIDON2_STATE_WIDTH: u32 = 4;
/// Identifier of a padding leaf.
pub const PADDING_LEAF_ID: u32 = 0;
/// Balance of a padding leaf. A padding leaf adds nothing to the total.
pub const PADDING_LEAF_BALANCE: u64 = 0;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum ContextError {
    UnsupportedAddressType = 1,
    EmptyReserveSet = 2,
    TooManyReserveAddresses = 3,
    DuplicateReserveAddress = 4,
}

/// The tag and the payload of an accepted address.
type AddressParts = (u32, [u8; ADDRESS_PAYLOAD_BYTES]);

fn fr_from_be(env: &Env, bytes: &[u8; FR_BYTES]) -> U256 {
    U256::from_be_bytes(env, &Bytes::from_array(env, bytes))
}

fn hash(env: &Env, inputs: &Vec<U256>) -> U256 {
    poseidon2_hash::<POSEIDON2_STATE_WIDTH, Bn254Fr>(env, inputs)
}

/// A domain tag as a field element: the ASCII string, left-padded with zero
/// bytes to the serialized length.
fn domain_tag(env: &Env, ascii: &[u8]) -> U256 {
    let mut bytes = [0u8; FR_BYTES];
    bytes[FR_BYTES - ascii.len()..].copy_from_slice(ascii);
    fr_from_be(env, &bytes)
}

/// The domain tag of the context hash.
pub fn ctx_domain_tag(env: &Env) -> U256 {
    domain_tag(env, CTX_DOMAIN_TAG_ASCII)
}

/// The domain tag of the salt derivation.
pub fn salt_domain_tag(env: &Env) -> U256 {
    domain_tag(env, SALT_DOMAIN_TAG_ASCII)
}

/// Reduces 32 bytes into the field. A random source gives the master secret,
/// so its value can be equal to or larger than the modulus.
pub fn fr_reduce(env: &Env, bytes: &[u8; FR_BYTES]) -> U256 {
    fr_from_be(env, bytes).rem_euclid(&<Bn254Fr as Field>::modulus(env))
}

fn address_parts(address: &Address) -> Result<AddressParts, ContextError> {
    match address.to_payload() {
        Some(AddressPayload::AccountIdPublicKeyEd25519(key)) => {
            Ok((ADDRESS_TAG_ACCOUNT, key.to_array()))
        }
        Some(AddressPayload::ContractIdHash(id)) => Ok((ADDRESS_TAG_CONTRACT, id.to_array())),
        None => Err(ContextError::UnsupportedAddressType),
    }
}

/// Encodes the tag and the payload into the limb pair
/// `(tag * 2^128 + payload[0..16], payload[16..32])`, both read big-endian.
/// The tag occupies the high limb bytes, so the sum needs no arithmetic here.
fn encode_parts(env: &Env, parts: &AddressParts) -> (U256, U256) {
    let (tag, payload) = parts;
    let mut hi = [0u8; FR_BYTES];
    hi[..ADDRESS_LIMB_BYTES].copy_from_slice(&(*tag as u128).to_be_bytes());
    hi[ADDRESS_LIMB_BYTES..].copy_from_slice(&payload[..ADDRESS_LIMB_BYTES]);
    let mut lo = [0u8; FR_BYTES];
    lo[ADDRESS_LIMB_BYTES..].copy_from_slice(&payload[ADDRESS_LIMB_BYTES..]);
    (fr_from_be(env, &hi), fr_from_be(env, &lo))
}

/// Encodes an accepted address into two field elements. The encoding is
/// injective, because the tag and every payload bit stay in the limb pair.
pub fn encode_address(env: &Env, address: &Address) -> Result<(U256, U256), ContextError> {
    Ok(encode_parts(env, &address_parts(address)?))
}

/// Commits to the set of authorized reserve addresses.
///
/// The sort makes the value a set hash, so the submission order cannot change
/// it. The sponge capacity encodes the input count, so two sets of different
/// sizes cannot produce the same value.
pub fn reserve_set_hash(env: &Env, reserves: &Vec<Address>) -> Result<U256, ContextError> {
    let count = reserves.len() as usize;
    if count == 0 {
        return Err(ContextError::EmptyReserveSet);
    }
    if count > MAX_RESERVE_ADDRESSES as usize {
        return Err(ContextError::TooManyReserveAddresses);
    }

    let mut sorted: [AddressParts; MAX_RESERVE_ADDRESSES as usize] =
        [(0, [0u8; ADDRESS_PAYLOAD_BYTES]); MAX_RESERVE_ADDRESSES as usize];
    for (index, address) in reserves.iter().enumerate() {
        sorted[index] = address_parts(&address)?;
    }

    // An insertion sort needs no allocation, and the set holds at most
    // MAX_RESERVE_ADDRESSES entries.
    for i in 1..count {
        let mut j = i;
        while j > 0 && sorted[j - 1] > sorted[j] {
            sorted.swap(j - 1, j);
            j -= 1;
        }
    }
    for i in 1..count {
        if sorted[i - 1] == sorted[i] {
            return Err(ContextError::DuplicateReserveAddress);
        }
    }

    let mut limbs = Vec::new(env);
    for parts in sorted.iter().take(count) {
        let (hi, lo) = encode_parts(env, parts);
        limbs.push_back(hi);
        limbs.push_back(lo);
    }
    Ok(hash(env, &limbs))
}

/// Binds a proof to one authority, one asset, one reserve address set, and one
/// snapshot ledger.
///
/// The expiry window stays outside the preimage. A prover-supplied window would
/// let the authority choose its own validity period, so the registry holds the
/// window as a policy constant instead.
pub fn context_hash(
    env: &Env,
    authority: &Address,
    asset: &Address,
    reserve_set: &U256,
    snapshot_ledger: u32,
) -> Result<U256, ContextError> {
    let (authority_hi, authority_lo) = encode_address(env, authority)?;
    let (asset_hi, asset_lo) = encode_address(env, asset)?;
    let mut inputs = Vec::new(env);
    inputs.push_back(ctx_domain_tag(env));
    inputs.push_back(authority_hi);
    inputs.push_back(authority_lo);
    inputs.push_back(asset_hi);
    inputs.push_back(asset_lo);
    inputs.push_back(reserve_set.clone());
    inputs.push_back(U256::from_u32(env, snapshot_ledger));
    Ok(hash(env, &inputs))
}

/// Hashes one internal node of the liabilities tree.
pub fn node_hash(env: &Env, left: &U256, right: &U256) -> U256 {
    let mut inputs = Vec::new(env);
    inputs.push_back(left.clone());
    inputs.push_back(right.clone());
    hash(env, &inputs)
}

/// Hashes one leaf of the liabilities tree.
///
/// The salt blinds the leaf. A customer who checks an inclusion package reads
/// the sibling hashes, and a balance has low entropy, so an unsalted leaf
/// falls to a search over plausible identifier and balance pairs.
pub fn leaf_hash(env: &Env, id: &U256, balance: u64, salt: &U256) -> U256 {
    let mut inputs = Vec::new(env);
    inputs.push_back(id.clone());
    inputs.push_back(U256::from_u128(env, balance as u128));
    inputs.push_back(salt.clone());
    hash(env, &inputs)
}

/// Derives the salt of the leaf at one global index.
///
/// The context binds every salt to one authority, one asset, one reserve
/// address set, and one snapshot, so two attestations never share a salt. The
/// derivation runs outside every circuit, and no circuit sees the master
/// secret.
pub fn derive_salt(env: &Env, master_secret: &U256, context: &U256, global_index: u64) -> U256 {
    let mut inputs = Vec::new(env);
    inputs.push_back(salt_domain_tag(env));
    inputs.push_back(master_secret.clone());
    inputs.push_back(context.clone());
    inputs.push_back(U256::from_u128(env, global_index as u128));
    hash(env, &inputs)
}
