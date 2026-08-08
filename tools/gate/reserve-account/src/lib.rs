#![no_std]
//! A reserve address for the registry gate, and for nothing else.
//!
//! A reserve address must authorize its own registration. An account address
//! signs an authorization entry. The pinned Stellar command line can sign
//! such an entry, but it collects a signer only for a top-level Address
//! argument (stellar-cli 27.0.0,
//! cmd/soroban-cli/src/commands/contract/arg_parsing.rs). A reserve sits
//! inside a Vec<Address>, so a second account cannot give that consent in a
//! scripted run. This contract is a custom account that accepts every
//! signature, so the gate registers it as a reserve address with one signer.
//!
//! This contract is a stand-in for a localnet harness only. It does not
//! exercise the path of a real reserve, which signs its authorization entry
//! through the JavaScript SDK. A gate that uses this contract is not
//! evidence for that path.
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
