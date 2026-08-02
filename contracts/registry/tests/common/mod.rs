//! Fixtures and stub contracts that the test files share.
//!
//! Each test file compiles this module again, and no file uses every item, so
//! the unused warning is off here.
#![allow(dead_code)]

use core::fmt::Debug;
use soroban_sdk::{
    address_payload::AddressPayload, contract, contracterror, contractimpl, symbol_short,
    testutils::Address as _, Address, Bytes, BytesN, Env, Val, Vec,
};
use zkpor_registry::{
    AssetAuthenticity, Error, Registry, RegistryClient, ASSET_TYPE_ALPHANUM12, ASSET_TYPE_ALPHANUM4,
    PUBLIC_KEY_TYPE_ED25519,
};

/// The committed aggregator verification key. The registry compiles in the
/// hash of these bytes, so a verifier that holds them satisfies its
/// constructor.
pub const RELEASE_KEY: &[u8] = include_bytes!("../../../../circuits/recursion/agg/vk");
/// The ed25519 key of the issuer account in the test fixtures.
pub const ISSUER_KEY: [u8; 32] = [7u8; 32];
/// The ed25519 key of an account that is not the issuer.
pub const OTHER_ACCOUNT_KEY: [u8; 32] = [9u8; 32];
/// The four-character code of the test asset.
pub const ASSET_CODE4: [u8; 4] = *b"USDX";
/// The twelve-character code of the test asset.
pub const ASSET_CODE12: [u8; 12] = *b"LONGERASSET1";

const KEY: soroban_sdk::Symbol = symbol_short!("key");
const ACCEPTS: soroban_sdk::Symbol = symbol_short!("accepts");
const INPUTS: soroban_sdk::Symbol = symbol_short!("inputs");
const ADMIN: soroban_sdk::Symbol = symbol_short!("admin");

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum StubError {
    /// The stub verifier was told to refuse.
    ProofRefused = 1,
    /// The stub token holds no balance entry for the address, which is what
    /// an account without a trustline produces on a real network.
    BalanceUnavailable = 2,
}

/// A verifier that answers with the key it was given, and that accepts or
/// refuses on command.
///
/// It also keeps the last public input byte string, so a test can read what
/// the registry built without trusting the registry to report it.
#[contract]
pub struct StubVerifier;

#[contractimpl]
impl StubVerifier {
    pub fn __constructor(env: Env, key: Bytes, accepts: bool) {
        env.storage().instance().set(&KEY, &key);
        env.storage().instance().set(&ACCEPTS, &accepts);
    }

    pub fn vk_bytes(env: Env) -> Bytes {
        env.storage().instance().get(&KEY).unwrap()
    }

    pub fn verify_proof(env: Env, public_inputs: Bytes, proof_bytes: Bytes) -> Result<(), StubError> {
        let _ = proof_bytes;
        env.storage().instance().set(&INPUTS, &public_inputs);
        if env.storage().instance().get(&ACCEPTS).unwrap() {
            Ok(())
        } else {
            Err(StubError::ProofRefused)
        }
    }

    pub fn last_public_inputs(env: Env) -> Bytes {
        env.storage().instance().get(&INPUTS).unwrap()
    }
}

/// A token that names an administrator and answers the balances that a test
/// gives it. An address with no balance set answers a failure, which is what
/// an account without a trustline produces on a real network.
#[contract]
pub struct StubToken;

#[contractimpl]
impl StubToken {
    pub fn __constructor(env: Env, admin: Address) {
        env.storage().instance().set(&ADMIN, &admin);
    }

    pub fn admin(env: Env) -> Address {
        env.storage().instance().get(&ADMIN).unwrap()
    }

    pub fn set_balance(env: Env, address: Address, amount: i128) {
        env.storage().persistent().set(&address, &amount);
    }

    pub fn balance(env: Env, address: Address) -> Result<i128, StubError> {
        env.storage()
            .persistent()
            .get(&address)
            .ok_or(StubError::BalanceUnavailable)
    }
}

/// A contract that holds a balance and nothing else. It names no
/// administrator, and it cannot authorize a call.
#[contract]
pub struct PassiveContract;

#[contractimpl]
impl PassiveContract {
    pub fn hold(_env: Env) {}
}

/// An account contract that accepts every signature.
///
/// `set_auths` does not register an account contract, unlike `mock_auths`, so
/// a test that builds its own authorization entries registers this one at each
/// consenting address. The host then reaches the nonce check and the
/// expiration check, which is what those tests measure.
#[contract]
pub struct PermissiveAccount;

#[contractimpl]
impl PermissiveAccount {
    #[allow(non_snake_case)]
    pub fn __check_auth(_signature_payload: Val, _signatures: Val, _auth_context: Val) {}
}

/// The Poseidon2 permutation is a host function, and the default budget stops
/// a test that hashes a reserve set.
pub fn test_env() -> Env {
    let env = Env::default();
    env.cost_estimate().budget().reset_unlimited();
    env
}

pub fn account(env: &Env, key: &[u8; 32]) -> Address {
    Address::from_payload(
        env,
        AddressPayload::AccountIdPublicKeyEd25519(BytesN::from_array(env, key)),
    )
}

/// The serialized `Asset` XDR: the asset type, the asset code, the public key
/// type of the issuer, and the issuer key.
pub fn classic_asset(env: &Env, code: &[u8], issuer_key: &[u8; 32]) -> Bytes {
    let asset_type = if code.len() == ASSET_CODE4.len() {
        ASSET_TYPE_ALPHANUM4
    } else {
        ASSET_TYPE_ALPHANUM12
    };
    let mut bytes = Bytes::new(env);
    bytes.extend_from_array(&asset_type.to_be_bytes());
    bytes.extend_from_slice(code);
    bytes.extend_from_array(&PUBLIC_KEY_TYPE_ED25519.to_be_bytes());
    bytes.extend_from_array(issuer_key);
    bytes
}

pub fn canonical_address(env: &Env, serialized_asset: &Bytes) -> Address {
    env.deployer()
        .with_stellar_asset(serialized_asset.clone())
        .deployed_address()
}

/// A registry whose verifier holds the release key and accepts every proof.
pub fn deploy_registry(env: &Env) -> Address {
    deploy_registry_with_verifier(env, true).0
}

/// A registry and the verifier behind it, which accepts or refuses on command.
pub fn deploy_registry_with_verifier(env: &Env, accepts: bool) -> (Address, Address) {
    let verifier = env.register(
        StubVerifier,
        (Bytes::from_slice(env, RELEASE_KEY), accepts),
    );
    (env.register(Registry, (verifier.clone(),)), verifier)
}

pub fn addresses(env: &Env, count: u32) -> Vec<Address> {
    let mut reserves = Vec::new(env);
    for _ in 0..count {
        reserves.push_back(Address::generate(env));
    }
    reserves
}

pub fn expect_error<T: Debug, E: Debug>(result: Result<T, Result<Error, E>>, expected: Error) {
    match result {
        Err(Ok(actual)) => assert_eq!(actual, expected),
        other => panic!("expected {expected:?}, and the call returned {other:?}"),
    }
}

/// A failed authorization is a host error, so it never carries a contract
/// error of this registry.
pub fn expect_authorization_failure<T: Debug, E: Debug>(result: Result<T, Result<Error, E>>) {
    match result {
        Err(Err(_)) => (),
        other => panic!("expected an authorization failure, and the call returned {other:?}"),
    }
}

/// One classic asset, with the issuer as its authority.
pub struct Classic {
    pub asset: Address,
    pub issuer: Address,
    pub serialized: Bytes,
}

pub fn classic_fixture(env: &Env, code: &[u8]) -> Classic {
    let serialized = classic_asset(env, code, &ISSUER_KEY);
    Classic {
        asset: canonical_address(env, &serialized),
        issuer: account(env, &ISSUER_KEY),
        serialized,
    }
}

/// One registered contract token, its administrator, and its reserve
/// addresses. Every attestation test needs this shape.
pub struct Registered {
    pub registry: Address,
    pub verifier: Address,
    pub asset: Address,
    pub authority: Address,
    pub reserves: Vec<Address>,
}

/// Registers a stub token under its administrator, with `reserve_count`
/// reserve addresses that hold no balance yet.
pub fn registered_token(env: &Env, accepts: bool, reserve_count: u32) -> Registered {
    let (registry_id, verifier) = deploy_registry_with_verifier(env, accepts);
    let authority = Address::generate(env);
    let asset = env.register(StubToken, (authority.clone(),));
    let reserves = addresses(env, reserve_count);

    env.mock_all_auths();
    RegistryClient::new(env, &registry_id).register_asset(
        &asset,
        &authority,
        &AssetAuthenticity::Contract,
        &reserves,
    );
    Registered {
        registry: registry_id,
        verifier,
        asset,
        authority,
        reserves,
    }
}
