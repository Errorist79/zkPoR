//! Attestation and reserve reading tests.
//!
//! Every rejection is checked for the reason it names, and every rejection has
//! a control that differs only in its cause.
//!
//! The verifier here is a stub, so these tests measure what the registry
//! builds and decides, and not whether a proof is sound. The soundness of a
//! proof, and the refusal of a proof whose context does not match, need a real
//! verifier and a real proof, which the localnet gate covers.

mod common;

use common::{
    expect_authorization_failure, expect_error, registered_token, test_env, Registered,
    StubTokenClient, StubVerifierClient,
};
use soroban_sdk::{
    testutils::{Address as _, Events as _, Ledger as _, MockAuth, MockAuthInvoke},
    Address, Bytes, Env, IntoVal, Val, Vec, U256,
};
use zkpor_context::{
    context_hash, fr_in_range, fr_modulus, reserve_set_hash, ATTESTATION_MAX_AGE_LEDGERS, FR_BYTES,
};
use zkpor_registry::{params, AttestationSlot, Error, RegistryClient, ReserveObservation};

/// The ledger that the attestation tests start from. A test needs a ledger
/// above the age window, so the sequence cannot start near zero.
const START_LEDGER: u32 = 10_000;
/// The balance that each reserve address holds in the tests that do not
/// measure a balance. The value is test data.
const RESERVE_BALANCE: i128 = 1_000;
/// The liabilities that the tests declare. The value is test data.
const TOTAL_LIABILITIES: u128 = 500;
/// The proof bytes of the tests. The stub verifier reads no proof, and the
/// localnet gate carries the real one.
const PROOF: [u8; 4] = [1, 2, 3, 4];

/// One registered asset whose reserve addresses hold a balance, at a ledger
/// above the age window.
fn ready(env: &Env, accepts: bool, reserve_count: u32) -> Registered {
    env.ledger()
        .with_mut(|ledger| ledger.sequence_number += START_LEDGER);
    let fixture = registered_token(env, accepts, reserve_count);
    let token = StubTokenClient::new(env, &fixture.asset);
    for reserve in fixture.reserves.iter() {
        token.set_balance(&reserve, &RESERVE_BALANCE);
    }
    fixture
}

fn proof(env: &Env) -> Bytes {
    Bytes::from_array(env, &PROOF)
}

fn root(env: &Env) -> U256 {
    U256::from_u32(env, 42)
}

/// The 32 bytes of one element of the public input byte string.
fn element(inputs: &Bytes, index: u32) -> Bytes {
    let size = FR_BYTES as u32;
    inputs.slice(index * size..(index + 1) * size)
}

#[test]
fn an_attestation_is_recorded_and_announced() {
    let env = test_env();
    let fixture = ready(&env, true, 2);
    let registry = RegistryClient::new(&env, &fixture.registry);
    let snapshot = env.ledger().sequence() - 1;

    registry.submit_attestation(
        &fixture.asset,
        &snapshot,
        &root(&env),
        &TOTAL_LIABILITIES,
        &proof(&env),
    );

    // The registry announced the attestation, and it announced it once. The
    // reading happens here, because the environment reports the events of the
    // last invocation.
    assert_eq!(
        env.events()
            .all()
            .filter_by_contract(&fixture.registry)
            .events()
            .len(),
        1
    );

    let attestation = match registry.entry(&fixture.asset).attestation {
        AttestationSlot::Filled(attestation) => attestation,
        AttestationSlot::Empty => panic!("the registry recorded no attestation"),
    };
    assert_eq!(attestation.final_root, root(&env));
    assert_eq!(attestation.total_liabilities, TOTAL_LIABILITIES);
    assert_eq!(attestation.snapshot_ledger, snapshot);
    assert_eq!(attestation.attested_ledger, env.ledger().sequence());
    // Two reserve addresses, each holding the same balance.
    assert_eq!(attestation.reserve_sum, RESERVE_BALANCE * 2);
}

/// The registry builds every element of the public input byte string. This
/// reads the string that reached the verifier and rebuilds each element from
/// the stored state.
#[test]
fn the_registry_builds_the_public_inputs_itself() {
    let env = test_env();
    let fixture = ready(&env, true, 1);
    let registry = RegistryClient::new(&env, &fixture.registry);
    let snapshot = env.ledger().sequence();
    registry.submit_attestation(
        &fixture.asset,
        &snapshot,
        &root(&env),
        &TOTAL_LIABILITIES,
        &proof(&env),
    );

    let inputs = StubVerifierClient::new(&env, &fixture.verifier).last_public_inputs();
    assert_eq!(inputs.len(), params::PUBLIC_INPUT_COUNT * FR_BYTES as u32);

    let expected = context_hash(
        &env,
        &fixture.authority,
        &fixture.asset,
        &reserve_set_hash(&env, &fixture.reserves).unwrap(),
        snapshot,
    )
    .unwrap();
    assert_eq!(
        element(&inputs, params::CONTEXT_HASH_INDEX),
        expected.to_be_bytes()
    );
    assert_eq!(
        element(&inputs, params::INNER_KEY_HASH_INDEX),
        Bytes::from_array(&env, &params::INNER_KEY_HASH)
    );
    assert_eq!(
        element(&inputs, params::FINAL_ROOT_INDEX),
        root(&env).to_be_bytes()
    );
    assert_eq!(
        element(&inputs, params::L_INDEX),
        U256::from_u128(&env, TOTAL_LIABILITIES).to_be_bytes()
    );
}

/// A different snapshot ledger must reach the verifier as a different
/// context, and must leave the other three elements alone.
#[test]
fn a_different_snapshot_ledger_changes_the_context_alone() {
    let env = test_env();
    let fixture = ready(&env, true, 1);
    let registry = RegistryClient::new(&env, &fixture.registry);
    let verifier = StubVerifierClient::new(&env, &fixture.verifier);
    let root = root(&env);

    registry.submit_attestation(
        &fixture.asset,
        &(env.ledger().sequence() - 1),
        &root,
        &TOTAL_LIABILITIES,
        &proof(&env),
    );
    let first = verifier.last_public_inputs();

    registry.submit_attestation(
        &fixture.asset,
        &env.ledger().sequence(),
        &root,
        &TOTAL_LIABILITIES,
        &proof(&env),
    );
    let second = verifier.last_public_inputs();

    assert_ne!(
        element(&first, params::CONTEXT_HASH_INDEX),
        element(&second, params::CONTEXT_HASH_INDEX)
    );
    for index in [
        params::INNER_KEY_HASH_INDEX,
        params::FINAL_ROOT_INDEX,
        params::L_INDEX,
    ] {
        assert_eq!(element(&first, index), element(&second, index));
    }
}

#[test]
fn a_proof_that_does_not_verify_is_refused() {
    let env = test_env();
    let fixture = ready(&env, false, 1);
    let registry = RegistryClient::new(&env, &fixture.registry);
    let snapshot = env.ledger().sequence();

    expect_error(
        registry.try_submit_attestation(
            &fixture.asset,
            &snapshot,
            &root(&env),
            &TOTAL_LIABILITIES,
            &proof(&env),
        ),
        Error::ProofRejected,
    );
    assert_eq!(
        registry.entry(&fixture.asset).attestation,
        AttestationSlot::Empty
    );

    // The same call against a verifier that accepts is recorded, so the
    // refusal came from the verifier.
    let accepting = ready(&env, true, 1);
    RegistryClient::new(&env, &accepting.registry).submit_attestation(
        &accepting.asset,
        &env.ledger().sequence(),
        &root(&env),
        &TOTAL_LIABILITIES,
        &proof(&env),
    );
}

#[test]
fn a_snapshot_ledger_outside_the_window_is_refused() {
    let env = test_env();
    let fixture = ready(&env, true, 1);
    let registry = RegistryClient::new(&env, &fixture.registry);
    let now = env.ledger().sequence();

    // Later than this ledger: the snapshot did not happen yet.
    expect_error(
        registry.try_submit_attestation(
            &fixture.asset,
            &(now + 1),
            &root(&env),
            &TOTAL_LIABILITIES,
            &proof(&env),
        ),
        Error::SnapshotOutsideWindow,
    );
    // Older than the window allows.
    expect_error(
        registry.try_submit_attestation(
            &fixture.asset,
            &(now - ATTESTATION_MAX_AGE_LEDGERS - 1),
            &root(&env),
            &TOTAL_LIABILITIES,
            &proof(&env),
        ),
        Error::SnapshotOutsideWindow,
    );

    // Both edges of the window are inside it.
    for snapshot in [now, now - ATTESTATION_MAX_AGE_LEDGERS] {
        registry.submit_attestation(
            &fixture.asset,
            &snapshot,
            &root(&env),
            &TOTAL_LIABILITIES,
            &proof(&env),
        );
    }
}

#[test]
fn only_the_recorded_authority_submits() {
    let env = test_env();
    let fixture = ready(&env, true, 1);
    let registry = RegistryClient::new(&env, &fixture.registry);
    let snapshot = env.ledger().sequence();
    let args: Vec<Val> = (
        fixture.asset.clone(),
        snapshot,
        root(&env),
        TOTAL_LIABILITIES,
        proof(&env),
    )
        .into_val(&env);

    // Another address authorizes the call, and the stored authority does not.
    let stranger = Address::generate(&env);
    env.mock_auths(&[MockAuth {
        address: &stranger,
        invoke: &MockAuthInvoke {
            contract: &fixture.registry,
            fn_name: "submit_attestation",
            args,
            sub_invokes: &[],
        },
    }]);
    expect_authorization_failure(registry.try_submit_attestation(
        &fixture.asset,
        &snapshot,
        &root(&env),
        &TOTAL_LIABILITIES,
        &proof(&env),
    ));

    // The same call with the authority in place is recorded.
    env.mock_all_auths();
    registry.submit_attestation(
        &fixture.asset,
        &snapshot,
        &root(&env),
        &TOTAL_LIABILITIES,
        &proof(&env),
    );
}

/// A reserve address that holds no balance entry fails the attestation. The
/// registry must not read the failure as a zero.
#[test]
fn a_reserve_balance_that_does_not_read_fails_the_attestation() {
    let env = test_env();
    let fixture = ready(&env, true, 1);
    let registry = RegistryClient::new(&env, &fixture.registry);
    let token = StubTokenClient::new(&env, &fixture.asset);
    let snapshot = env.ledger().sequence();

    // A second reserve address that holds nothing, added by the authority.
    let mut reserves = fixture.reserves.clone();
    reserves.push_back(Address::generate(&env));
    registry.set_reserves(&fixture.asset, &reserves);

    expect_error(
        registry.try_submit_attestation(
            &fixture.asset,
            &snapshot,
            &root(&env),
            &TOTAL_LIABILITIES,
            &proof(&env),
        ),
        Error::ReserveBalanceUnavailable,
    );

    // The same call after the address holds a balance is recorded, so the
    // refusal came from the read and not from the reserve set.
    token.set_balance(&reserves.get_unchecked(1), &RESERVE_BALANCE);
    registry.submit_attestation(
        &fixture.asset,
        &snapshot,
        &root(&env),
        &TOTAL_LIABILITIES,
        &proof(&env),
    );
}

#[test]
fn a_reserve_sum_that_would_overflow_fails_the_attestation() {
    let env = test_env();
    let fixture = ready(&env, true, 2);
    let registry = RegistryClient::new(&env, &fixture.registry);
    let token = StubTokenClient::new(&env, &fixture.asset);
    let snapshot = env.ledger().sequence();

    token.set_balance(&fixture.reserves.get_unchecked(0), &i128::MAX);
    expect_error(
        registry.try_submit_attestation(
            &fixture.asset,
            &snapshot,
            &root(&env),
            &TOTAL_LIABILITIES,
            &proof(&env),
        ),
        Error::ReserveSumOverflow,
    );

    // The same call with a sum inside the range is recorded.
    token.set_balance(&fixture.reserves.get_unchecked(0), &RESERVE_BALANCE);
    registry.submit_attestation(
        &fixture.asset,
        &snapshot,
        &root(&env),
        &TOTAL_LIABILITIES,
        &proof(&env),
    );
}

/// The host reduces a value that is not a field element instead of refusing
/// it, so the proof would carry the reduction while the record kept the
/// submitted value.
#[test]
fn a_root_that_is_not_a_field_element_is_refused() {
    let env = test_env();
    let fixture = ready(&env, true, 1);
    let registry = RegistryClient::new(&env, &fixture.registry);
    let snapshot = env.ledger().sequence();
    let modulus = fr_modulus(&env);

    for root in [modulus.clone(), modulus.add(&U256::from_u32(&env, 1))] {
        expect_error(
            registry.try_submit_attestation(
                &fixture.asset,
                &snapshot,
                &root,
                &TOTAL_LIABILITIES,
                &proof(&env),
            ),
            Error::RootOutOfRange,
        );
    }

    // The largest field element is accepted, so the refusal above came from
    // the range and not from the size of the value.
    registry.submit_attestation(
        &fixture.asset,
        &snapshot,
        &modulus.sub(&U256::from_u32(&env, 1)),
        &TOTAL_LIABILITIES,
        &proof(&env),
    );
}

/// The other three elements cannot leave the range. The registry computes the
/// context, so it is a hash. The total is a `u128`. This checks the third one,
/// which arrives as a compiled-in constant.
#[test]
fn the_compiled_in_inner_key_hash_is_a_field_element() {
    let env = test_env();
    let value = U256::from_be_bytes(&env, &Bytes::from_array(&env, &params::INNER_KEY_HASH));
    assert!(fr_in_range(&env, &value));
}

#[test]
fn an_asset_with_no_entry_takes_no_attestation() {
    let env = test_env();
    let fixture = ready(&env, true, 1);
    let registry = RegistryClient::new(&env, &fixture.registry);

    expect_error(
        registry.try_submit_attestation(
            &Address::generate(&env),
            &env.ledger().sequence(),
            &root(&env),
            &TOTAL_LIABILITIES,
            &proof(&env),
        ),
        Error::AssetNotRegistered,
    );
}

#[test]
fn an_observation_carries_the_sum_and_its_ledger() {
    let env = test_env();
    let fixture = ready(&env, true, 2);
    let registry = RegistryClient::new(&env, &fixture.registry);

    assert_eq!(
        registry.observe_reserves(&fixture.asset),
        ReserveObservation {
            observed_sum: RESERVE_BALANCE * 2,
            observed_ledger: env.ledger().sequence(),
        }
    );

    // The reading follows the ledger and the balances.
    env.ledger().with_mut(|ledger| ledger.sequence_number += 1);
    StubTokenClient::new(&env, &fixture.asset)
        .set_balance(&fixture.reserves.get_unchecked(0), &(RESERVE_BALANCE * 3));
    assert_eq!(
        registry.observe_reserves(&fixture.asset),
        ReserveObservation {
            observed_sum: RESERVE_BALANCE * 4,
            observed_ledger: env.ledger().sequence(),
        }
    );
}

/// An observation follows the rule of the attestation path: a read that fails
/// fails the call, and no zero stands in for a missing answer.
#[test]
fn an_observation_fails_when_a_balance_does_not_read() {
    let env = test_env();
    let fixture = ready(&env, true, 1);
    let registry = RegistryClient::new(&env, &fixture.registry);

    let mut reserves = fixture.reserves.clone();
    reserves.push_back(Address::generate(&env));
    registry.set_reserves(&fixture.asset, &reserves);
    expect_error(
        registry.try_observe_reserves(&fixture.asset),
        Error::ReserveBalanceUnavailable,
    );

    // The same reading after the address holds a balance answers the sum.
    StubTokenClient::new(&env, &fixture.asset)
        .set_balance(&reserves.get_unchecked(1), &RESERVE_BALANCE);
    assert_eq!(
        registry.observe_reserves(&fixture.asset).observed_sum,
        RESERVE_BALANCE * 2
    );
}

#[test]
fn an_asset_with_no_entry_has_no_observation() {
    let env = test_env();
    let fixture = ready(&env, true, 1);
    let registry = RegistryClient::new(&env, &fixture.registry);

    expect_error(
        registry.try_observe_reserves(&Address::generate(&env)),
        Error::AssetNotRegistered,
    );
}
