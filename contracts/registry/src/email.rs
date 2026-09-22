use soroban_sdk::{
    contractimpl, contracttype, Address, Bytes, BytesN, Env, IntoVal, Symbol, Vec, U256,
};
use zkpor_context::{encode_address, fr_in_range, fr_reduce, PADDING_LEAF_ID};

use crate::{
    extend_contract, extend_entry, AssetEntry, DataKey, EmailEvidence, Error, Registry,
    RegistryArgs, RegistryClient, VERIFY_PROOF_FN,
};

const CONTEXT_DOMAIN: &[u8] = b"zkpor-email-registration/1\0";
const IDENTIFIER_BYTES: usize = 32;
const SUBJECT_BYTES: usize = 43;
const PACKED_BYTES: usize = 31;
const HASH_HALF_BYTES: usize = 16;
const BASE64URL: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DkimKeyInput {
    pub modulus_hash: U256,
    pub redc_hash: U256,
    pub domain_hash: BytesN<32>,
    pub from_header_hash: BytesN<32>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DkimKey {
    pub key: DkimKeyInput,
    pub registered_ledger: u32,
    pub context_hash: U256,
}

fn count(env: &Env, asset: &Address) -> u64 {
    env.storage()
        .persistent()
        .get(&DataKey::DkimKeyCount(asset.clone()))
        .unwrap_or(0)
}

fn read(env: &Env, asset: &Address, key_id: u64) -> Result<DkimKey, Error> {
    env.storage()
        .persistent()
        .get(&DataKey::DkimKey(asset.clone(), key_id))
        .ok_or(Error::DkimKeyNotFound)
}

fn context(
    env: &Env,
    asset: &Address,
    authority: &Address,
    key_id: u64,
    key: &DkimKeyInput,
) -> Result<U256, Error> {
    let mut bytes = Bytes::from_slice(env, CONTEXT_DOMAIN);
    bytes.append(&env.ledger().network_id().into());
    for address in [&env.current_contract_address(), asset, authority] {
        let (tag, payload) = encode_address(env, address)?;
        bytes.append(&tag.to_be_bytes());
        bytes.append(&payload.to_be_bytes());
    }
    bytes.extend_from_array(&key_id.to_be_bytes());
    bytes.append(&key.modulus_hash.to_be_bytes());
    bytes.append(&key.redc_hash.to_be_bytes());
    bytes.append(&key.domain_hash.clone().into());
    bytes.append(&key.from_header_hash.clone().into());
    Ok(fr_reduce(env, &env.crypto().sha256(&bytes).to_array()))
}

fn append_hash(env: &Env, inputs: &mut Bytes, hash: &BytesN<32>) {
    let bytes = hash.to_array();
    for half in bytes.chunks_exact(HASH_HALF_BYTES) {
        let mut field = [0; IDENTIFIER_BYTES];
        field[HASH_HALF_BYTES..].copy_from_slice(half);
        inputs.append(&Bytes::from_array(env, &field));
    }
}

fn subject(id: &U256) -> [u8; SUBJECT_BYTES] {
    let mut input = [0; IDENTIFIER_BYTES];
    id.to_be_bytes().copy_into_slice(&mut input);
    let mut output = [0; SUBJECT_BYTES];
    for (index, byte) in output.iter_mut().enumerate() {
        let bit = index * 6;
        let source = bit / 8;
        let shift = bit % 8;
        let word =
            u16::from(input[source]) << 8 | u16::from(input.get(source + 1).copied().unwrap_or(0));
        *byte = BASE64URL[usize::from((word >> (10 - shift)) & 63)];
    }
    output
}

pub(crate) fn public_inputs(env: &Env, record: &DkimKey, id: &U256) -> Bytes {
    let mut inputs = record.context_hash.to_be_bytes();
    inputs.append(&record.key.modulus_hash.to_be_bytes());
    inputs.append(&record.key.redc_hash.to_be_bytes());
    append_hash(env, &mut inputs, &record.key.domain_hash);
    append_hash(env, &mut inputs, &record.key.from_header_hash);
    for part in subject(id).chunks(PACKED_BYTES) {
        let mut field = [0; IDENTIFIER_BYTES];
        field[1..1 + part.len()].copy_from_slice(part);
        inputs.append(&Bytes::from_array(env, &field));
    }
    inputs
}

pub(crate) fn verify(env: &Env, asset: &Address, evidence: &EmailEvidence) -> Result<(), Error> {
    if evidence.id == U256::from_u32(env, PADDING_LEAF_ID) || !fr_in_range(env, &evidence.id) {
        return Err(Error::InvalidEmailIdentifier);
    }
    let record = read(env, asset, evidence.key_id)?;
    let verifier: Address = env
        .storage()
        .instance()
        .get(&DataKey::EmailVerifier)
        .ok_or(Error::EmailVerifierNotSet)?;
    let mut args = Vec::new(env);
    args.push_back(public_inputs(env, &record, &evidence.id).into_val(env));
    args.push_back(evidence.proof.clone().into_val(env));
    env.try_invoke_contract::<(), Error>(&verifier, &Symbol::new(env, VERIFY_PROOF_FN), args)
        .map_err(|_| Error::EmailProofRejected)?
        .map_err(|_| Error::EmailProofRejected)
}

#[contractimpl]
impl Registry {
    /// Authorizes a signer for this asset. Old registrations remain valid.
    pub fn register_dkim_key(env: Env, asset: Address, key: DkimKeyInput) -> Result<u64, Error> {
        let entry: AssetEntry = env
            .storage()
            .persistent()
            .get(&DataKey::Asset(asset.clone()))
            .ok_or(Error::AssetNotRegistered)?;
        let zero = U256::from_u32(&env, 0);
        if key.modulus_hash == zero
            || key.redc_hash == zero
            || !fr_in_range(&env, &key.modulus_hash)
            || !fr_in_range(&env, &key.redc_hash)
        {
            return Err(Error::InvalidDkimKey);
        }
        let key_id = count(&env, &asset)
            .checked_add(1)
            .ok_or(Error::DkimKeyIdOverflow)?;
        let context_hash = context(&env, &asset, &entry.authority, key_id, &key)?;
        if context_hash == zero {
            return Err(Error::InvalidDkimKey);
        }
        entry.authority.require_auth();
        let record_key = DataKey::DkimKey(asset.clone(), key_id);
        let count_key = DataKey::DkimKeyCount(asset);
        env.storage().persistent().set(
            &record_key,
            &DkimKey {
                key,
                registered_ledger: env.ledger().sequence(),
                context_hash,
            },
        );
        env.storage().persistent().set(&count_key, &key_id);
        extend_entry(&env, &record_key);
        extend_entry(&env, &count_key);
        extend_contract(&env);
        Ok(key_id)
    }

    pub fn dkim_key_count(env: Env, asset: Address) -> Result<u64, Error> {
        if !env
            .storage()
            .persistent()
            .has(&DataKey::Asset(asset.clone()))
        {
            return Err(Error::AssetNotRegistered);
        }
        Ok(count(&env, &asset))
    }

    pub fn get_dkim_key(env: Env, asset: Address, key_id: u64) -> Result<DkimKey, Error> {
        read(&env, &asset, key_id)
    }
}
