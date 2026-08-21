#![no_std]
//! A fund share token for the scenario runs, and for nothing else.
//!
//! The registry accepts an asset under two tiers. A classic asset registers
//! under its issuer. A contract token registers under the administrator that
//! the token itself names. The second tier needs a token that is not a classic
//! asset, and this is that token: a fund share that exists as a contract and
//! has no classic counterpart. The tests of the registry use the asset contract
//! that the host builds for a classic asset, which reaches the same code and
//! says nothing about a token of this kind.
//!
//! It is scenario scaffolding and it lives beside the other scaffolding rather
//! than under `contracts/`, which holds what this project deploys and stands
//! behind.
//!
//! # What it implements, and what it does not
//!
//! The registry asks a token for two things. It calls `admin` at registration
//! and compares the answer with the authority that the caller supplied. It
//! calls `balance` once for each reserve address at attestation and adds the
//! answers. Those two, a constructor that records the administrator, and a
//! `mint` that gives the reserves something to hold, are the whole of this
//! contract.
//!
//! It carries no `decimals`, no `name`, and no `symbol`. A reader who expects
//! them of a thing called a token is reading the name rather than the contract,
//! and adding them so that such a reader finds them would be code written for
//! an audience rather than for a caller. Nothing in the demonstration reads
//! them. If a step of the demonstration comes to need one, a wallet view or an
//! explorer page that has to show it, that is a reason and it can have one
//! then.
//!
//! It also carries no `transfer` and no `allowance`. A share that moves between
//! holders is a property of a real token and no part of what the registry
//! reads, and a transfer here would be a second way to change a balance that
//! nothing checks.
//!
//! # Why the mint asks for the administrator
//!
//! A reserve balance means backing only when the holder cannot create the
//! asset. A mint that anybody could call would make every balance this token
//! reports meaningless, and the registry reads those balances as the backing of
//! an attestation. So the mint requires the authorization of the administrator,
//! which is the same rule the asset contract of the host applies.
//!
//! It accepts an administrator who mints without limit, so it must never reach
//! a real network as anything but a demonstration.

use soroban_sdk::{contract, contracterror, contractimpl, contracttype, Address, Env};

/// What this contract stores.
#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// The administrator, which the registry compares with the authority.
    Admin,
    /// The share balance of one holder.
    Balance(Address),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// The contract holds no administrator. The constructor records one, so
    /// this answers a contract that never ran it.
    AdministratorNotSet = 1,
    /// A mint of nothing, or of a negative amount. A negative balance would
    /// reduce the reserve sum that an attestation rests on, and a mint of zero
    /// states an intention that it does not carry out.
    AmountNotPositive = 2,
    /// The balance of one holder would leave the range of the balance type.
    BalanceOverflow = 3,
}

#[contract]
pub struct FundToken;

#[contractimpl]
impl FundToken {
    /// Records the administrator that this token names.
    pub fn __constructor(env: Env, admin: Address) {
        env.storage().instance().set(&DataKey::Admin, &admin);
        extend_contract(&env);
    }

    /// The administrator, which the registry reads at registration.
    pub fn admin(env: Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::AdministratorNotSet)
    }

    /// The share balance of one holder, which the registry reads for each
    /// reserve address at attestation.
    ///
    /// A holder that this token never minted to holds nothing, which is an
    /// answer and not a failure. The registry adds what it reads, so an address
    /// outside the token contributes zero rather than stopping the run.
    pub fn balance(env: Env, id: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::Balance(id))
            .unwrap_or(0)
    }

    /// Gives one holder more shares, under the authorization of the
    /// administrator.
    pub fn mint(env: Env, to: Address, amount: i128) -> Result<(), Error> {
        let admin = Self::admin(env.clone())?;
        admin.require_auth();
        if amount <= 0 {
            return Err(Error::AmountNotPositive);
        }
        let key = DataKey::Balance(to);
        let held: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        let total = held.checked_add(amount).ok_or(Error::BalanceOverflow)?;
        env.storage().persistent().set(&key, &total);
        extend_balance(&env, &key);
        extend_contract(&env);
        Ok(())
    }
}

/// Keeps the contract alive for as long as the network allows.
///
/// A demonstration that failed because a balance expired would fail for a
/// reason that has nothing to do with what it demonstrates.
fn extend_contract(env: &Env) {
    let ttl = env.storage().max_ttl();
    env.storage().instance().extend_ttl(ttl, ttl);
}

/// Keeps one balance alive for the same reason.
fn extend_balance(env: &Env, key: &DataKey) {
    let ttl = env.storage().max_ttl();
    env.storage().persistent().extend_ttl(key, ttl, ttl);
}
