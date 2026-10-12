mod common;

use common::{expect_error, registered_token, test_env, Registered, StubTokenClient};
use soroban_sdk::{
    testutils::{
        storage::{Instance as _, Persistent as _},
        Address as _, Ledger as _,
    },
    Address, Bytes, Env, U256,
};
use zkpor_context::ATTESTATION_MAX_AGE_LEDGERS;
use zkpor_registry::{DataKey, Error, ObservationStatus, RegistryClient};

const START_LEDGER: u32 = 10_000;
const RESERVE_BALANCE: i128 = 1_000;
const LIABILITIES: u128 = 500;
const ROOT: u32 = 7;

fn ready(env: &Env, reserves: u32) -> Registered {
    env.ledger()
        .with_mut(|ledger| ledger.sequence_number = START_LEDGER);
    let fixture = registered_token(env, true, reserves);
    for reserve in fixture.reserves.iter() {
        StubTokenClient::new(env, &fixture.asset).set_balance(&reserve, &RESERVE_BALANCE);
    }
    fixture
}

fn balance(env: &Env, fixture: &Registered, amount: i128) {
    StubTokenClient::new(env, &fixture.asset)
        .set_balance(&fixture.reserves.get_unchecked(0), &amount);
}

fn attest(env: &Env, fixture: &Registered) -> u64 {
    RegistryClient::new(env, &fixture.registry).submit_attestation(
        &fixture.asset,
        &env.ledger().sequence(),
        &U256::from_u32(env, ROOT),
        &LIABILITIES,
        &Bytes::new(env),
    )
}

#[test]
fn anyone_can_record_distinct_observations_in_one_ledger_without_an_attestation() {
    let env = test_env();
    let fixture = ready(&env, 1);
    let registry = RegistryClient::new(&env, &fixture.registry);
    env.mock_auths(&[]);
    assert_eq!(
        registry.observation_status(&fixture.asset),
        ObservationStatus {
            observation_count: 0,
            first_low_observation: None,
        }
    );
    let first = registry.observe_reserves(&fixture.asset);
    balance(&env, &fixture, RESERVE_BALANCE - 1);
    let second = registry.observe_reserves(&fixture.asset);
    assert_eq!(first.observation_id, 1);
    assert_eq!(second.observation_id, 2);
    assert_eq!(first.observed_ledger, second.observed_ledger);
    assert_eq!(first.observed_sum, RESERVE_BALANCE);
    assert_eq!(second.observed_sum, RESERVE_BALANCE - 1);
    assert_eq!(second.attestation_id, None);
    assert!(!second.below_attested);
    assert_eq!(registry.get_observation(&fixture.asset, &1), first);
    assert_eq!(registry.get_observation(&fixture.asset, &2), second);
    assert_eq!(
        second.reserve_set_hash,
        registry.entry(&fixture.asset).reserve_set_hash
    );
    assert_eq!(
        registry.observation_status(&fixture.asset),
        ObservationStatus {
            observation_count: 2,
            first_low_observation: None,
        }
    );
}

#[test]
fn comparison_uses_the_newest_durable_attestation_in_the_same_ledger() {
    let env = test_env();
    let fixture = ready(&env, 1);
    let registry = RegistryClient::new(&env, &fixture.registry);
    assert_eq!(attest(&env, &fixture), 1);
    balance(&env, &fixture, RESERVE_BALANCE / 2);
    assert_eq!(attest(&env, &fixture), 2);
    let first = registry.get_attestation(&fixture.asset, &1);
    let second = registry.get_attestation(&fixture.asset, &2);
    assert_eq!(first.attested_ledger, second.attested_ledger);
    balance(&env, &fixture, second.reserve_sum + 1);
    env.mock_auths(&[]);
    let above = registry.observe_reserves(&fixture.asset);
    assert_eq!(above.attestation_id, Some(2));
    assert!(!above.below_attested);
    assert!(above.observed_sum < first.reserve_sum);
    balance(&env, &fixture, second.reserve_sum);
    let equal = registry.observe_reserves(&fixture.asset);
    assert!(!equal.below_attested);
    balance(&env, &fixture, second.reserve_sum - 1);
    let below = registry.observe_reserves(&fixture.asset);
    assert_eq!(below.attestation_id, Some(2));
    assert!(below.below_attested);
    assert_eq!(
        registry
            .observation_status(&fixture.asset)
            .first_low_observation,
        Some(below.observation_id)
    );
}

#[test]
fn the_first_low_observation_survives_later_recovery_and_new_attestations() {
    let env = test_env();
    let fixture = ready(&env, 1);
    let registry = RegistryClient::new(&env, &fixture.registry);
    attest(&env, &fixture);
    balance(&env, &fixture, RESERVE_BALANCE - 1);
    let low = registry.observe_reserves(&fixture.asset);
    balance(&env, &fixture, RESERVE_BALANCE + 1);
    let recovered = registry.observe_reserves(&fixture.asset);
    assert!(!recovered.below_attested);
    attest(&env, &fixture);
    let current = registry.observe_reserves(&fixture.asset);
    assert_eq!(current.attestation_id, Some(2));
    assert!(!current.below_attested);
    balance(&env, &fixture, 0);
    assert!(registry.observe_reserves(&fixture.asset).below_attested);
    assert_eq!(
        registry.get_observation(&fixture.asset, &low.observation_id),
        low
    );
    assert_eq!(
        registry
            .observation_status(&fixture.asset)
            .first_low_observation,
        Some(low.observation_id)
    );
}

#[test]
fn reserve_set_changes_clear_the_baseline_but_preserve_the_low_history() {
    let env = test_env();
    let fixture = ready(&env, 1);
    let registry = RegistryClient::new(&env, &fixture.registry);
    attest(&env, &fixture);
    balance(&env, &fixture, RESERVE_BALANCE - 1);
    let low = registry.observe_reserves(&fixture.asset);
    let mut reserves = fixture.reserves.clone();
    let added = Address::generate(&env);
    reserves.push_back(added.clone());
    StubTokenClient::new(&env, &fixture.asset).set_balance(&added, &0);
    registry.set_reserves(&fixture.asset, &reserves);
    let after = registry.observe_reserves(&fixture.asset);
    assert_eq!(after.attestation_id, None);
    assert!(!after.below_attested);
    assert_ne!(after.reserve_set_hash, low.reserve_set_hash);
    assert_eq!(
        after.reserve_set_hash,
        registry.entry(&fixture.asset).reserve_set_hash
    );
    assert_eq!(
        registry.get_observation(&fixture.asset, &low.observation_id),
        low
    );
    assert_eq!(
        registry
            .observation_status(&fixture.asset)
            .first_low_observation,
        Some(low.observation_id)
    );
}

#[test]
fn an_old_attestation_remains_a_reference_without_a_freshness_claim() {
    let env = test_env();
    let fixture = ready(&env, 1);
    let registry = RegistryClient::new(&env, &fixture.registry);
    attest(&env, &fixture);
    env.ledger().with_mut(|ledger| {
        ledger.sequence_number += ATTESTATION_MAX_AGE_LEDGERS + 1;
    });
    balance(&env, &fixture, RESERVE_BALANCE - 1);
    let observation = registry.observe_reserves(&fixture.asset);
    assert_eq!(observation.attestation_id, Some(1));
    assert!(observation.below_attested);
    assert_eq!(observation.observed_ledger, env.ledger().sequence());
}

#[test]
fn failed_balance_reads_and_sum_overflow_leave_the_history_unchanged() {
    let env = test_env();
    let fixture = ready(&env, 2);
    let registry = RegistryClient::new(&env, &fixture.registry);
    let first = registry.observe_reserves(&fixture.asset);
    let missing = fixture.reserves.get_unchecked(1);
    env.as_contract(&fixture.asset, || {
        env.storage().persistent().remove(&missing);
    });
    expect_error(
        registry.try_observe_reserves(&fixture.asset),
        Error::ReserveBalanceUnavailable,
    );
    StubTokenClient::new(&env, &fixture.asset).set_balance(&missing, &1);
    balance(&env, &fixture, i128::MAX);
    expect_error(
        registry.try_observe_reserves(&fixture.asset),
        Error::ReserveSumOverflow,
    );
    assert_eq!(registry.get_observation(&fixture.asset, &1), first);
    assert_eq!(
        registry
            .observation_status(&fixture.asset)
            .observation_count,
        1
    );
    expect_error(
        registry.try_get_observation(&fixture.asset, &2),
        Error::ObservationNotFound,
    );
}

#[test]
fn an_observation_identifier_cannot_wrap() {
    let env = test_env();
    let fixture = ready(&env, 1);
    let registry = RegistryClient::new(&env, &fixture.registry);
    let first = registry.observe_reserves(&fixture.asset);
    let full = ObservationStatus {
        observation_count: u64::MAX,
        first_low_observation: None,
    };
    env.as_contract(&fixture.registry, || {
        env.storage()
            .persistent()
            .set(&DataKey::ObservationStatus(fixture.asset.clone()), &full);
    });
    expect_error(
        registry.try_observe_reserves(&fixture.asset),
        Error::ObservationIdOverflow,
    );
    assert_eq!(registry.observation_status(&fixture.asset), full);
    assert_eq!(registry.get_observation(&fixture.asset, &1), first);
}

#[test]
fn observations_extend_their_persistent_entries_and_contract_lifetime() {
    let env = test_env();
    let fixture = ready(&env, 1);
    let registry = RegistryClient::new(&env, &fixture.registry);
    let observation = registry.observe_reserves(&fixture.asset);
    env.as_contract(&fixture.registry, || {
        let expected = env.storage().max_ttl();
        assert_eq!(
            env.storage().persistent().get_ttl(&DataKey::Observation(
                fixture.asset.clone(),
                observation.observation_id,
            )),
            expected
        );
        assert_eq!(
            env.storage()
                .persistent()
                .get_ttl(&DataKey::ObservationStatus(fixture.asset.clone(),)),
            expected
        );
        assert_eq!(env.storage().instance().get_ttl(), expected);
    });
}

#[test]
fn unknown_assets_and_observation_identifiers_are_refused() {
    let env = test_env();
    let fixture = ready(&env, 1);
    let registry = RegistryClient::new(&env, &fixture.registry);
    let unknown = Address::generate(&env);
    expect_error(
        registry.try_observe_reserves(&unknown),
        Error::AssetNotRegistered,
    );
    expect_error(
        registry.try_observation_status(&unknown),
        Error::AssetNotRegistered,
    );
    for id in [0, 1] {
        expect_error(
            registry.try_get_observation(&fixture.asset, &id),
            Error::ObservationNotFound,
        );
    }
}
