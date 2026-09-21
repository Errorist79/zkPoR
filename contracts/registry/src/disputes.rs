use soroban_sdk::{
    contractimpl, contracttype, token::TokenClient, Address, Env, MuxedAddress, Vec, U256,
};
use zkpor_context::{fr_in_range, leaf_hash, node_hash, PADDING_LEAF_ID};

use crate::{
    extend_contract, extend_entry, history, native_asset_contract, params, AssetEntry, DataKey,
    Error, Registry, RegistryArgs, RegistryClient,
};

pub const ANSWER_WINDOW_LEDGERS: u32 = 51_840;
pub const TARGET_MAX_AGE_LEDGERS: u32 = 518_400;
pub const DISPUTE_DEPOSIT_STROOPS: i128 = 100_000_000;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InclusionEvidence {
    pub id: U256,
    pub commitment: U256,
    pub path: Vec<U256>,
    pub position: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DisputeStatus {
    Open,
    Answered,
    /// The issuer did not answer before the contract deadline.
    OmissionProven,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Dispute {
    pub disputer: Address,
    pub evidence_id: u64,
    pub target_id: u64,
    pub identifier: U256,
    pub opened_ledger: u32,
    pub deadline: u32,
    pub status: DisputeStatus,
    pub closed_ledger: u32,
    pub burned_bond: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Bond {
    pub available: i128,
    pub burned: i128,
}

fn asset_entry(env: &Env, asset: &Address) -> Result<AssetEntry, Error> {
    env.storage()
        .persistent()
        .get(&DataKey::Asset(asset.clone()))
        .ok_or(Error::AssetNotRegistered)
}

fn inclusion(env: &Env, root: &U256, evidence: &InclusionEvidence) -> Result<(), Error> {
    if evidence.path.len() != params::MERKLE_PATH_DEPTH
        || evidence.position.checked_shr(params::MERKLE_PATH_DEPTH) != Some(0)
        || evidence.id == U256::from_u32(env, PADDING_LEAF_ID)
        || !fr_in_range(env, &evidence.id)
        || !fr_in_range(env, &evidence.commitment)
    {
        return Err(Error::InvalidInclusion);
    }
    let mut hash = leaf_hash(env, &evidence.id, &evidence.commitment);
    let mut position = evidence.position;
    for sibling in evidence.path.iter() {
        if !fr_in_range(env, &sibling) {
            return Err(Error::InvalidInclusion);
        }
        hash = if position & 1 == 0 {
            node_hash(env, &hash, &sibling)
        } else {
            node_hash(env, &sibling, &hash)
        };
        position >>= 1;
    }
    if hash != *root {
        return Err(Error::InvalidInclusion);
    }
    Ok(())
}

fn bond(env: &Env, asset: &Address) -> Bond {
    env.storage()
        .persistent()
        .get(&DataKey::Bond(asset.clone()))
        .unwrap_or(Bond {
            available: 0,
            burned: 0,
        })
}

fn save<T>(env: &Env, key: &DataKey, value: &T)
where
    T: soroban_sdk::IntoVal<Env, soroban_sdk::Val>,
{
    env.storage().persistent().set(key, value);
    extend_entry(env, key);
    extend_contract(env);
}

fn transfer(env: &Env, from: &Address, to: &Address, amount: i128) {
    TokenClient::new(env, &native_asset_contract(env)).transfer(
        from,
        MuxedAddress::from(to),
        &amount,
    );
}

fn open_record(env: &Env, key: &DataKey) -> Result<Dispute, Error> {
    let dispute: Dispute = env
        .storage()
        .persistent()
        .get(key)
        .ok_or(Error::DisputeNotFound)?;
    if dispute.status != DisputeStatus::Open {
        return Err(Error::DisputeClosed);
    }
    Ok(dispute)
}

#[contractimpl]
impl Registry {
    /// Fixes the target and holds the deposit after an old inclusion check.
    /// An absent target selects the newest attestation.
    pub fn open_dispute(
        env: Env,
        asset: Address,
        disputer: Address,
        evidence_id: u64,
        target: Option<u64>,
        evidence: InclusionEvidence,
    ) -> Result<Dispute, Error> {
        asset_entry(&env, &asset)?;
        let target_id = target.unwrap_or_else(|| history::count(&env, &asset));
        let target_record = history::read(&env, &asset, target_id)?;
        let now = env.ledger().sequence();
        if now < target_record.attested_ledger
            || now - target_record.attested_ledger > TARGET_MAX_AGE_LEDGERS
        {
            return Err(Error::TargetOutsideWindow);
        }
        if evidence_id >= target_id {
            return Err(Error::EvidenceNotOlder);
        }
        let old = history::read(&env, &asset, evidence_id)?;
        inclusion(&env, &old.final_root, &evidence)?;
        let key = DataKey::Dispute(asset, target_id, evidence.id.clone());
        if env.storage().persistent().has(&key) {
            return Err(Error::DisputeAlreadyExists);
        }
        let deadline = now
            .checked_add(ANSWER_WINDOW_LEDGERS)
            .ok_or(Error::DeadlineOverflow)?;
        disputer.require_auth();
        let dispute = Dispute {
            disputer: disputer.clone(),
            evidence_id,
            target_id,
            identifier: evidence.id,
            opened_ledger: now,
            deadline,
            status: DisputeStatus::Open,
            closed_ledger: 0,
            burned_bond: 0,
        };
        save(&env, &key, &dispute);
        transfer(
            &env,
            &disputer,
            &env.current_contract_address(),
            DISPUTE_DEPOSIT_STROOPS,
        );
        Ok(dispute)
    }

    /// Pays the deposit to the issuer after an inclusion check under the fixed target.
    pub fn answer_dispute(
        env: Env,
        asset: Address,
        target_id: u64,
        evidence: InclusionEvidence,
    ) -> Result<(), Error> {
        let entry = asset_entry(&env, &asset)?;
        let key = DataKey::Dispute(asset.clone(), target_id, evidence.id.clone());
        let mut dispute = open_record(&env, &key)?;
        if env.ledger().sequence() > dispute.deadline {
            return Err(Error::AnswerWindowClosed);
        }
        let target = history::read(&env, &asset, target_id)?;
        inclusion(&env, &target.final_root, &evidence)?;
        entry.authority.require_auth();
        dispute.status = DisputeStatus::Answered;
        dispute.closed_ledger = env.ledger().sequence();
        save(&env, &key, &dispute);
        transfer(
            &env,
            &env.current_contract_address(),
            &entry.authority,
            DISPUTE_DEPOSIT_STROOPS,
        );
        Ok(())
    }

    /// Refunds the deposit and permanently locks the bond after no answer.
    pub fn resolve_dispute(
        env: Env,
        asset: Address,
        target_id: u64,
        id: U256,
    ) -> Result<(), Error> {
        let key = DataKey::Dispute(asset.clone(), target_id, id);
        let mut dispute = open_record(&env, &key)?;
        if env.ledger().sequence() <= dispute.deadline {
            return Err(Error::AnswerWindowOpen);
        }
        let mut allocation = bond(&env, &asset);
        dispute.burned_bond = allocation.available;
        allocation.burned = allocation
            .burned
            .checked_add(allocation.available)
            .ok_or(Error::BondOverflow)?;
        allocation.available = 0;
        dispute.status = DisputeStatus::OmissionProven;
        dispute.closed_ledger = env.ledger().sequence();
        save(&env, &DataKey::Bond(asset), &allocation);
        save(&env, &key, &dispute);
        transfer(
            &env,
            &env.current_contract_address(),
            &dispute.disputer,
            DISPUTE_DEPOSIT_STROOPS,
        );
        Ok(())
    }

    /// Adds an optional bond. No function permits a withdrawal, including before a dispute.
    pub fn fund_bond(env: Env, asset: Address, amount: i128) -> Result<(), Error> {
        let entry = asset_entry(&env, &asset)?;
        if amount <= 0 {
            return Err(Error::InvalidBondAmount);
        }
        let mut allocation = bond(&env, &asset);
        allocation.available = allocation
            .available
            .checked_add(amount)
            .ok_or(Error::BondOverflow)?;
        allocation
            .available
            .checked_add(allocation.burned)
            .ok_or(Error::BondOverflow)?;
        entry.authority.require_auth();
        save(&env, &DataKey::Bond(asset), &allocation);
        transfer(
            &env,
            &entry.authority,
            &env.current_contract_address(),
            amount,
        );
        Ok(())
    }

    pub fn get_bond(env: Env, asset: Address) -> Result<Bond, Error> {
        asset_entry(&env, &asset)?;
        Ok(bond(&env, &asset))
    }

    pub fn get_dispute(
        env: Env,
        asset: Address,
        target_id: u64,
        id: U256,
    ) -> Result<Dispute, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Dispute(asset, target_id, id))
            .ok_or(Error::DisputeNotFound)
    }
}
