#![no_std]
//! A reserve address for the registry gate, and for nothing else.
//!
//! A reserve address must authorize its own registration. An account address
//! signs an authorization entry, and the pinned Stellar command line signs
//! only the transaction envelope, so a second account cannot give that consent
//! in a scripted run. This contract is a custom account that accepts every
//! signature, so the gate registers it as a reserve address with one signer.
//!
//! It accepts everything, so it must never reach a real network.

use soroban_sdk::{contract, contractimpl, Val};

#[contract]
pub struct ReserveAccount;

#[contractimpl]
impl ReserveAccount {
    /// The argument types repeat the account contract that soroban-sdk uses in
    /// its own tests, so the host reaches this body with any payload.
    #[allow(non_snake_case)]
    pub fn __check_auth(_signature_payload: Val, _signatures: Val, _auth_context: Val) {}
}
