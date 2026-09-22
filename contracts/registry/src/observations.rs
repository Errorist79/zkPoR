use soroban_sdk::{contractimpl, contracttype, Address, Env, U256};

use crate::{
    extend_contract, extend_entry, history, reserve_sum, AssetEntry, AttestationSlot, DataKey,
    Error, Registry, RegistryArgs, RegistryClient,
};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReserveObservation {
    pub observation_id: u64,
    pub observed_sum: i128,
    pub observed_ledger: u32,
    pub reserve_set_hash: U256,
    /// No identifier means that the current reserve set has no attestation.
    pub attestation_id: Option<u64>,
    /// False with no attestation does not establish reserve coverage.
    pub below_attested: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ObservationStatus {
    pub observation_count: u64,
    /// The first low observation stays set after every later operation.
    pub first_low_observation: Option<u64>,
}

fn status(env: &Env, asset: &Address) -> ObservationStatus {
    env.storage()
        .persistent()
        .get(&DataKey::ObservationStatus(asset.clone()))
        .unwrap_or(ObservationStatus {
            observation_count: 0,
            first_low_observation: None,
        })
}

#[contractimpl]
impl Registry {
    /// Records reserve balances that the contract reads in this transaction.
    /// A simulation returns a proposed observation but does not store it.
    pub fn observe_reserves(env: Env, asset: Address) -> Result<ReserveObservation, Error> {
        let entry: AssetEntry = env
            .storage()
            .persistent()
            .get(&DataKey::Asset(asset.clone()))
            .ok_or(Error::AssetNotRegistered)?;
        let mut state = status(&env, &asset);
        let observation_id = state
            .observation_count
            .checked_add(1)
            .ok_or(Error::ObservationIdOverflow)?;
        let observed_sum = reserve_sum(&env, &asset, &entry.reserves)?;
        let (attestation_id, below_attested) = match entry.attestation {
            AttestationSlot::Empty => (None, false),
            AttestationSlot::Filled(_) => {
                let id = history::count(&env, &asset);
                let attestation = history::read(&env, &asset, id)?;
                (Some(id), observed_sum < attestation.reserve_sum)
            }
        };
        let observation = ReserveObservation {
            observation_id,
            observed_sum,
            observed_ledger: env.ledger().sequence(),
            reserve_set_hash: entry.reserve_set_hash,
            attestation_id,
            below_attested,
        };
        state.observation_count = observation_id;
        if below_attested && state.first_low_observation.is_none() {
            state.first_low_observation = Some(observation_id);
        }
        let record_key = DataKey::Observation(asset.clone(), observation_id);
        let status_key = DataKey::ObservationStatus(asset);
        env.storage().persistent().set(&record_key, &observation);
        env.storage().persistent().set(&status_key, &state);
        extend_entry(&env, &record_key);
        extend_entry(&env, &status_key);
        extend_contract(&env);
        Ok(observation)
    }

    /// Returns one stored observation. Identifiers start at one.
    pub fn get_observation(env: Env, asset: Address, id: u64) -> Result<ReserveObservation, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Observation(asset, id))
            .ok_or(Error::ObservationNotFound)
    }

    /// Returns the history count and the permanent first low observation.
    pub fn observation_status(env: Env, asset: Address) -> Result<ObservationStatus, Error> {
        if !env
            .storage()
            .persistent()
            .has(&DataKey::Asset(asset.clone()))
        {
            return Err(Error::AssetNotRegistered);
        }
        Ok(status(&env, &asset))
    }
}
