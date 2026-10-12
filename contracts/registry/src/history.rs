use soroban_sdk::{contractimpl, Address, Env};

use crate::{extend_entry, Attestation, DataKey, Error, Registry, RegistryArgs, RegistryClient};

pub(crate) fn count(env: &Env, asset: &Address) -> u64 {
    env.storage()
        .persistent()
        .get(&DataKey::AttestationCount(asset.clone()))
        .unwrap_or(0)
}

pub(crate) fn read(env: &Env, asset: &Address, id: u64) -> Result<Attestation, Error> {
    env.storage()
        .persistent()
        .get(&DataKey::Attestation(asset.clone(), id))
        .ok_or(Error::AttestationNotFound)
}

pub(crate) fn append(env: &Env, asset: &Address, attestation: &Attestation) -> Result<u64, Error> {
    let id = count(env, asset)
        .checked_add(1)
        .ok_or(Error::AttestationIdOverflow)?;
    let record_key = DataKey::Attestation(asset.clone(), id);
    let count_key = DataKey::AttestationCount(asset.clone());
    env.storage().persistent().set(&record_key, attestation);
    env.storage().persistent().set(&count_key, &id);
    extend_entry(env, &record_key);
    extend_entry(env, &count_key);
    Ok(id)
}

#[contractimpl]
impl Registry {
    /// Returns the last history identifier. Identifiers start at one.
    pub fn attestation_count(env: Env, asset: Address) -> Result<u64, Error> {
        if !env
            .storage()
            .persistent()
            .has(&DataKey::Asset(asset.clone()))
        {
            return Err(Error::AssetNotRegistered);
        }
        Ok(count(&env, &asset))
    }

    /// Returns one permanent attestation, including records from the same ledger.
    pub fn get_attestation(env: Env, asset: Address, id: u64) -> Result<Attestation, Error> {
        read(&env, &asset, id)
    }
}
