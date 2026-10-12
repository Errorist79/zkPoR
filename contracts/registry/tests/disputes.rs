mod common;

use common::{
    expect_authorization_failure, expect_error, registered_token, test_env, Registered,
    StubTokenClient, StubVerifierClient,
};
use soroban_sdk::{
    contract, contractimpl,
    testutils::{Address as _, Ledger as _},
    Address, Bytes, BytesN, Env, MuxedAddress, Vec, U256,
};
use zkpor_context::{balance_commitment, context_hash, fr_modulus, leaf_hash, node_hash};
use zkpor_registry::{
    params, AttestationSlot, DataKey, DisputeEvidence, DisputeOrigin, DisputeStatus, DkimKeyInput,
    EmailEvidence, Error, InclusionEvidence, InclusionOpening, RegistryClient,
    ANSWER_WINDOW_LEDGERS, DISPUTE_DEPOSIT_STROOPS, NATIVE_ASSET_XDR, TARGET_MAX_AGE_LEDGERS,
};

const START_LEDGER: u32 = 100;
const INITIAL_FUNDS: i128 = DISPUTE_DEPOSIT_STROOPS * 10;
const BOND_AMOUNT: i128 = DISPUTE_DEPOSIT_STROOPS * 3;
const RESERVE_BALANCE: i128 = 1_000;
const CUSTOMER_BALANCE: u64 = 50;
const CUSTOMER_ID: u32 = 7;
const CUSTOMER_SALT: u32 = 11;

fn dkim_key(env: &Env) -> DkimKeyInput {
    DkimKeyInput {
        modulus_hash: U256::from_u32(env, 71),
        redc_hash: U256::from_u32(env, 73),
        domain_hash: BytesN::from_array(env, &[7; 32]),
        from_header_hash: BytesN::from_array(env, &[9; 32]),
    }
}

fn email_evidence(env: &Env, key_id: u64, id: &U256) -> DisputeEvidence {
    DisputeEvidence::Email(EmailEvidence {
        key_id,
        id: id.clone(),
        proof: Bytes::new(env),
    })
}

fn email_verifier(env: &Env, registry: &Address) -> Address {
    env.as_contract(registry, || {
        env.storage()
            .instance()
            .get(&DataKey::EmailVerifier)
            .unwrap()
    })
}

#[contract]
struct NativeToken;

#[contractimpl]
impl NativeToken {
    pub fn set_balance(env: Env, address: Address, amount: i128) {
        env.storage().persistent().set(&address, &amount);
    }

    pub fn balance(env: Env, address: Address) -> i128 {
        env.storage().persistent().get(&address).unwrap_or(0)
    }

    pub fn transfer(env: Env, from: Address, to: MuxedAddress, amount: i128) {
        from.require_auth();
        assert!(amount >= 0);
        let balance = Self::balance(env.clone(), from.clone());
        assert!(balance >= amount);
        Self::set_balance(env.clone(), from, balance - amount);
        let recipient = to.address();
        let received = Self::balance(env.clone(), recipient.clone());
        Self::set_balance(env, recipient, received.checked_add(amount).unwrap());
    }
}

struct Fixture {
    registered: Registered,
    native: Address,
    disputer: Address,
    evidence: InclusionEvidence,
    root: U256,
}

fn inclusion(env: &Env, id: u32, balance: u64) -> (InclusionEvidence, U256) {
    let identifier = U256::from_u32(env, id);
    let commitment = balance_commitment(env, balance, &U256::from_u32(env, CUSTOMER_SALT));
    let mut root = leaf_hash(env, &identifier, &commitment);
    let mut path = Vec::new(env);
    for level in 0..params::MERKLE_PATH_DEPTH {
        let sibling = U256::from_u32(env, level + 1);
        root = node_hash(env, &root, &sibling);
        path.push_back(sibling);
    }
    (
        InclusionEvidence {
            id: identifier,
            commitment,
            path,
            position: 0,
        },
        root,
    )
}

fn ready(env: &Env) -> Fixture {
    ready_at(env, START_LEDGER)
}

fn ready_at(env: &Env, start: u32) -> Fixture {
    env.ledger().with_mut(|ledger| {
        ledger.sequence_number = start;
        ledger.max_entry_ttl =
            (TARGET_MAX_AGE_LEDGERS + ANSWER_WINDOW_LEDGERS * 2).min(u32::MAX - start);
    });
    let registered = registered_token(env, true, 1);
    for reserve in registered.reserves.iter() {
        StubTokenClient::new(env, &registered.asset).set_balance(&reserve, &RESERVE_BALANCE);
    }
    let native = env
        .deployer()
        .with_stellar_asset(Bytes::from_array(env, &NATIVE_ASSET_XDR))
        .deployed_address();
    env.register_at(&native, NativeToken, ());
    let disputer = Address::generate(env);
    let token = NativeTokenClient::new(env, &native);
    token.set_balance(&disputer, &INITIAL_FUNDS);
    token.set_balance(&registered.authority, &INITIAL_FUNDS);
    let (evidence, root) = inclusion(env, CUSTOMER_ID, CUSTOMER_BALANCE);
    let fixture = Fixture {
        registered,
        native,
        disputer,
        evidence,
        root,
    };
    submit(env, &fixture, &fixture.root);
    submit(env, &fixture, &fixture.root);
    fixture
}

fn submit(env: &Env, fixture: &Fixture, root: &U256) -> u64 {
    RegistryClient::new(env, &fixture.registered.registry).submit_attestation(
        &fixture.registered.asset,
        &env.ledger().sequence(),
        root,
        &u128::from(CUSTOMER_BALANCE),
        &Bytes::new(env),
    )
}

fn open(env: &Env, fixture: &Fixture) {
    RegistryClient::new(env, &fixture.registered.registry).open_dispute(
        &fixture.registered.asset,
        &fixture.disputer,
        &None,
        &DisputeEvidence::Inclusion(InclusionOpening {
            attestation_id: 1,
            inclusion: fixture.evidence.clone(),
        }),
    );
}

fn advance(env: &Env, ledger: u32) {
    env.ledger().with_mut(|info| info.sequence_number = ledger);
}

#[test]
fn signer_registration_needs_issuer_auth_and_keeps_each_historical_key() {
    let env = test_env();
    let fixture = ready(&env);
    let registry = RegistryClient::new(&env, &fixture.registered.registry);
    env.mock_auths(&[]);
    expect_authorization_failure(
        registry.try_register_dkim_key(&fixture.registered.asset, &dkim_key(&env)),
    );
    assert_eq!(registry.dkim_key_count(&fixture.registered.asset), 0);
    env.mock_all_auths();
    assert_eq!(
        registry.register_dkim_key(&fixture.registered.asset, &dkim_key(&env)),
        1
    );
    let first = registry.get_dkim_key(&fixture.registered.asset, &1);
    let mut changed = dkim_key(&env);
    changed.from_header_hash = BytesN::from_array(&env, &[10; 32]);
    assert_eq!(
        registry.register_dkim_key(&fixture.registered.asset, &changed),
        2
    );
    let second = registry.get_dkim_key(&fixture.registered.asset, &2);
    assert_eq!(first.registered_ledger, second.registered_ledger);
    assert_ne!(first.context_hash, second.context_hash);
    registry.set_reserves(&fixture.registered.asset, &fixture.registered.reserves);
    assert_eq!(registry.get_dkim_key(&fixture.registered.asset, &1), first);
    let opened = registry.open_dispute(
        &fixture.registered.asset,
        &fixture.disputer,
        &None,
        &email_evidence(&env, 1, &fixture.evidence.id),
    );
    assert_eq!(opened.origin, DisputeOrigin::Email(1));
}

#[test]
fn invalid_keys_missing_keys_and_key_counter_overflow_fail() {
    let env = test_env();
    let fixture = ready(&env);
    let registry = RegistryClient::new(&env, &fixture.registered.registry);
    for value in [U256::from_u32(&env, 0), fr_modulus(&env)] {
        let mut bad = dkim_key(&env);
        bad.modulus_hash = value.clone();
        expect_error(
            registry.try_register_dkim_key(&fixture.registered.asset, &bad),
            Error::InvalidDkimKey,
        );
        bad = dkim_key(&env);
        bad.redc_hash = value;
        expect_error(
            registry.try_register_dkim_key(&fixture.registered.asset, &bad),
            Error::InvalidDkimKey,
        );
    }
    expect_error(
        registry.try_register_dkim_key(&Address::generate(&env), &dkim_key(&env)),
        Error::AssetNotRegistered,
    );
    expect_error(
        registry.try_get_dkim_key(&fixture.registered.asset, &0),
        Error::DkimKeyNotFound,
    );
    expect_error(
        registry.try_get_dkim_key(&fixture.registered.asset, &1),
        Error::DkimKeyNotFound,
    );
    env.as_contract(&fixture.registered.registry, || {
        env.storage().persistent().set(
            &DataKey::DkimKeyCount(fixture.registered.asset.clone()),
            &u64::MAX,
        );
    });
    expect_error(
        registry.try_register_dkim_key(&fixture.registered.asset, &dkim_key(&env)),
        Error::DkimKeyIdOverflow,
    );
}

#[test]
fn an_email_opening_uses_the_registered_inputs_and_the_same_answer_settlement() {
    let env = test_env();
    let fixture = ready(&env);
    let registry = RegistryClient::new(&env, &fixture.registered.registry);
    registry.register_dkim_key(&fixture.registered.asset, &dkim_key(&env));
    let record = registry.get_dkim_key(&fixture.registered.asset, &1);
    let opened = registry.open_dispute(
        &fixture.registered.asset,
        &fixture.disputer,
        &None,
        &email_evidence(&env, 1, &fixture.evidence.id),
    );
    assert_eq!(opened.origin, DisputeOrigin::Email(1));
    assert_eq!(opened.target_id, 2);
    assert_eq!(opened.deadline, START_LEDGER + ANSWER_WINDOW_LEDGERS);
    let actual = StubVerifierClient::new(&env, &email_verifier(&env, &fixture.registered.registry))
        .last_public_inputs();
    let mut expected = record.context_hash.to_be_bytes();
    expected.append(&U256::from_u32(&env, 71).to_be_bytes());
    expected.append(&U256::from_u32(&env, 73).to_be_bytes());
    for byte in [7, 7, 9, 9] {
        let mut field = [0; 32];
        field[16..].fill(byte);
        expected.extend_from_array(&field);
    }
    let mut first = [b'A'; 32];
    first[0] = 0;
    expected.extend_from_array(&first);
    let mut second = [0; 32];
    second[1..12].fill(b'A');
    second[12] = b'c';
    expected.extend_from_array(&second);
    assert_eq!(actual, expected);
    submit(&env, &fixture, &fixture.root);
    registry.answer_dispute(&fixture.registered.asset, &2, &fixture.evidence);
    assert_eq!(
        registry
            .get_dispute(&fixture.registered.asset, &2, &fixture.evidence.id)
            .status,
        DisputeStatus::Answered
    );
    let token = NativeTokenClient::new(&env, &fixture.native);
    assert_eq!(
        token.balance(&fixture.disputer),
        INITIAL_FUNDS - DISPUTE_DEPOSIT_STROOPS
    );
    assert_eq!(
        token.balance(&fixture.registered.authority),
        INITIAL_FUNDS + DISPUTE_DEPOSIT_STROOPS
    );
}

#[test]
fn an_email_identifier_needs_no_prior_inclusion_and_timeout_stays_permanent() {
    let env = test_env();
    let fixture = ready(&env);
    let registry = RegistryClient::new(&env, &fixture.registered.registry);
    registry.register_dkim_key(&fixture.registered.asset, &dkim_key(&env));
    registry.fund_bond(&fixture.registered.asset, &BOND_AMOUNT);
    let omitted = U256::from_u32(&env, CUSTOMER_ID + 1);
    registry.open_dispute(
        &fixture.registered.asset,
        &fixture.disputer,
        &None,
        &email_evidence(&env, 1, &omitted),
    );
    advance(&env, START_LEDGER + ANSWER_WINDOW_LEDGERS + 1);
    env.mock_auths(&[]);
    registry.resolve_dispute(&fixture.registered.asset, &2, &omitted);
    let closed = registry.get_dispute(&fixture.registered.asset, &2, &omitted);
    assert_eq!(closed.status, DisputeStatus::OmissionProven);
    assert_eq!(closed.burned_bond, BOND_AMOUNT);
    assert_eq!(
        NativeTokenClient::new(&env, &fixture.native).balance(&fixture.disputer),
        INITIAL_FUNDS
    );
    expect_error(
        registry.try_resolve_dispute(&fixture.registered.asset, &2, &omitted),
        Error::DisputeClosed,
    );
}

#[test]
fn evidence_paths_and_rotated_keys_share_the_same_duplicate_guard() {
    let env = test_env();
    let fixture = ready(&env);
    let registry = RegistryClient::new(&env, &fixture.registered.registry);
    registry.register_dkim_key(&fixture.registered.asset, &dkim_key(&env));
    open(&env, &fixture);
    expect_error(
        registry.try_open_dispute(
            &fixture.registered.asset,
            &fixture.disputer,
            &None,
            &email_evidence(&env, 1, &fixture.evidence.id),
        ),
        Error::DisputeAlreadyExists,
    );
    submit(&env, &fixture, &fixture.root);
    registry.open_dispute(
        &fixture.registered.asset,
        &fixture.disputer,
        &None,
        &email_evidence(&env, 1, &fixture.evidence.id),
    );
    registry.register_dkim_key(&fixture.registered.asset, &dkim_key(&env));
    expect_error(
        registry.try_open_dispute(
            &fixture.registered.asset,
            &fixture.disputer,
            &None,
            &email_evidence(&env, 2, &fixture.evidence.id),
        ),
        Error::DisputeAlreadyExists,
    );
    expect_error(
        registry.try_open_dispute(
            &fixture.registered.asset,
            &fixture.disputer,
            &None,
            &DisputeEvidence::Inclusion(InclusionOpening {
                attestation_id: 1,
                inclusion: fixture.evidence.clone(),
            }),
        ),
        Error::DisputeAlreadyExists,
    );
}

#[test]
fn invalid_email_evidence_or_missing_auth_cannot_charge_a_deposit() {
    let env = test_env();
    let fixture = ready(&env);
    let registry = RegistryClient::new(&env, &fixture.registered.registry);
    registry.register_dkim_key(&fixture.registered.asset, &dkim_key(&env));
    for id in [U256::from_u32(&env, 0), fr_modulus(&env)] {
        expect_error(
            registry.try_open_dispute(
                &fixture.registered.asset,
                &fixture.disputer,
                &None,
                &email_evidence(&env, 1, &id),
            ),
            Error::InvalidEmailIdentifier,
        );
    }
    expect_error(
        registry.try_open_dispute(
            &fixture.registered.asset,
            &fixture.disputer,
            &None,
            &email_evidence(&env, 2, &fixture.evidence.id),
        ),
        Error::DkimKeyNotFound,
    );
    env.mock_auths(&[]);
    expect_authorization_failure(registry.try_open_dispute(
        &fixture.registered.asset,
        &fixture.disputer,
        &None,
        &email_evidence(&env, 1, &fixture.evidence.id),
    ));
    env.mock_all_auths();
    StubVerifierClient::new(&env, &email_verifier(&env, &fixture.registered.registry))
        .set_accepts(&false);
    expect_error(
        registry.try_open_dispute(
            &fixture.registered.asset,
            &fixture.disputer,
            &None,
            &email_evidence(&env, 1, &fixture.evidence.id),
        ),
        Error::EmailProofRejected,
    );
    expect_error(
        registry.try_get_dispute(&fixture.registered.asset, &2, &fixture.evidence.id),
        Error::DisputeNotFound,
    );
    assert_eq!(
        NativeTokenClient::new(&env, &fixture.native).balance(&fixture.disputer),
        INITIAL_FUNDS
    );
}

#[test]
fn history_keeps_same_ledger_records_and_original_context() {
    let env = test_env();
    let fixture = ready(&env);
    let registry = RegistryClient::new(&env, &fixture.registered.registry);
    assert_eq!(registry.attestation_count(&fixture.registered.asset), 2);
    let old = registry.get_attestation(&fixture.registered.asset, &1);
    assert_eq!(old, registry.get_attestation(&fixture.registered.asset, &2));
    let entry = registry.entry(&fixture.registered.asset);
    assert_eq!(
        old.context_hash,
        context_hash(
            &env,
            &entry.authority,
            &fixture.registered.asset,
            &entry.reserve_set_hash,
            START_LEDGER
        )
        .unwrap()
    );
    registry.set_reserves(&fixture.registered.asset, &fixture.registered.reserves);
    assert_eq!(
        registry.entry(&fixture.registered.asset).attestation,
        AttestationSlot::Empty
    );
    assert_eq!(registry.get_attestation(&fixture.registered.asset, &1), old);
    assert_eq!(submit(&env, &fixture, &fixture.root), 3);
    expect_error(
        registry.try_get_attestation(&fixture.registered.asset, &0),
        Error::AttestationNotFound,
    );
    expect_error(
        registry.try_get_attestation(&fixture.registered.asset, &4),
        Error::AttestationNotFound,
    );
}

#[test]
fn an_answer_pays_only_the_deposit_and_preserves_the_bond() {
    let env = test_env();
    let fixture = ready(&env);
    let registry = RegistryClient::new(&env, &fixture.registered.registry);
    let token = NativeTokenClient::new(&env, &fixture.native);
    registry.fund_bond(&fixture.registered.asset, &BOND_AMOUNT);
    open(&env, &fixture);
    assert_eq!(
        token.balance(&fixture.disputer),
        INITIAL_FUNDS - DISPUTE_DEPOSIT_STROOPS
    );
    registry.answer_dispute(&fixture.registered.asset, &2, &fixture.evidence);
    assert_eq!(
        token.balance(&fixture.registered.authority),
        INITIAL_FUNDS - BOND_AMOUNT + DISPUTE_DEPOSIT_STROOPS
    );
    assert_eq!(token.balance(&fixture.registered.registry), BOND_AMOUNT);
    assert_eq!(
        registry.get_bond(&fixture.registered.asset).available,
        BOND_AMOUNT
    );
    assert_eq!(
        registry
            .get_dispute(&fixture.registered.asset, &2, &fixture.evidence.id)
            .status,
        DisputeStatus::Answered
    );
    expect_error(
        registry.try_answer_dispute(&fixture.registered.asset, &2, &fixture.evidence),
        Error::DisputeClosed,
    );
    expect_error(
        registry.try_resolve_dispute(&fixture.registered.asset, &2, &fixture.evidence.id),
        Error::DisputeClosed,
    );
    expect_error(
        registry.try_open_dispute(
            &fixture.registered.asset,
            &fixture.disputer,
            &None,
            &DisputeEvidence::Inclusion(InclusionOpening {
                attestation_id: 1,
                inclusion: fixture.evidence.clone(),
            }),
        ),
        Error::DisputeAlreadyExists,
    );
}

#[test]
fn an_unanswered_dispute_refunds_and_permanently_locks_the_bond() {
    let env = test_env();
    let fixture = ready(&env);
    let registry = RegistryClient::new(&env, &fixture.registered.registry);
    let token = NativeTokenClient::new(&env, &fixture.native);
    registry.fund_bond(&fixture.registered.asset, &BOND_AMOUNT);
    open(&env, &fixture);
    advance(&env, START_LEDGER + ANSWER_WINDOW_LEDGERS + 1);
    env.mock_auths(&[]);
    registry.resolve_dispute(&fixture.registered.asset, &2, &fixture.evidence.id);
    assert_eq!(token.balance(&fixture.disputer), INITIAL_FUNDS);
    assert_eq!(token.balance(&fixture.registered.registry), BOND_AMOUNT);
    let allocation = registry.get_bond(&fixture.registered.asset);
    assert_eq!(allocation.available, 0);
    assert_eq!(allocation.burned, BOND_AMOUNT);
    let dispute = registry.get_dispute(&fixture.registered.asset, &2, &fixture.evidence.id);
    assert_eq!(dispute.status, DisputeStatus::OmissionProven);
    assert_eq!(dispute.burned_bond, BOND_AMOUNT);
    assert_eq!(
        dispute.closed_ledger,
        START_LEDGER + ANSWER_WINDOW_LEDGERS + 1
    );
    expect_error(
        registry.try_resolve_dispute(&fixture.registered.asset, &2, &fixture.evidence.id),
        Error::DisputeClosed,
    );
    expect_error(
        registry.try_answer_dispute(&fixture.registered.asset, &2, &fixture.evidence),
        Error::DisputeClosed,
    );
}

#[test]
fn the_deadline_allows_an_answer_but_not_resolution() {
    let env = test_env();
    let fixture = ready(&env);
    let registry = RegistryClient::new(&env, &fixture.registered.registry);
    open(&env, &fixture);
    advance(&env, START_LEDGER + ANSWER_WINDOW_LEDGERS);
    expect_error(
        registry.try_resolve_dispute(&fixture.registered.asset, &2, &fixture.evidence.id),
        Error::AnswerWindowOpen,
    );
    registry.answer_dispute(&fixture.registered.asset, &2, &fixture.evidence);
}

#[test]
fn an_answer_after_the_deadline_is_refused() {
    let env = test_env();
    let fixture = ready(&env);
    let registry = RegistryClient::new(&env, &fixture.registered.registry);
    open(&env, &fixture);
    advance(&env, START_LEDGER + ANSWER_WINDOW_LEDGERS + 1);
    expect_error(
        registry.try_answer_dispute(&fixture.registered.asset, &2, &fixture.evidence),
        Error::AnswerWindowClosed,
    );
    registry.resolve_dispute(&fixture.registered.asset, &2, &fixture.evidence.id);
    assert_eq!(registry.get_bond(&fixture.registered.asset).burned, 0);
}

#[test]
fn targets_are_fixed_and_eligible_through_the_age_boundary() {
    let env = test_env();
    let fixture = ready(&env);
    let registry = RegistryClient::new(&env, &fixture.registered.registry);
    open(&env, &fixture);
    let (_, changed) = inclusion(&env, CUSTOMER_ID, CUSTOMER_BALANCE + 1);
    submit(&env, &fixture, &changed);
    registry.answer_dispute(&fixture.registered.asset, &2, &fixture.evidence);
    advance(&env, START_LEDGER + TARGET_MAX_AGE_LEDGERS);
    registry.open_dispute(
        &fixture.registered.asset,
        &fixture.disputer,
        &Some(3),
        &DisputeEvidence::Inclusion(InclusionOpening {
            attestation_id: 1,
            inclusion: fixture.evidence.clone(),
        }),
    );
    assert_eq!(
        registry
            .get_dispute(&fixture.registered.asset, &3, &fixture.evidence.id)
            .target_id,
        3
    );
}

#[test]
fn stale_future_and_nonlater_targets_are_refused() {
    let env = test_env();
    let fixture = ready(&env);
    let registry = RegistryClient::new(&env, &fixture.registered.registry);
    expect_error(
        registry.try_open_dispute(
            &fixture.registered.asset,
            &fixture.disputer,
            &Some(2),
            &DisputeEvidence::Inclusion(InclusionOpening {
                attestation_id: 2,
                inclusion: fixture.evidence.clone(),
            }),
        ),
        Error::EvidenceNotOlder,
    );
    advance(&env, START_LEDGER - 1);
    expect_error(
        registry.try_open_dispute(
            &fixture.registered.asset,
            &fixture.disputer,
            &None,
            &DisputeEvidence::Inclusion(InclusionOpening {
                attestation_id: 1,
                inclusion: fixture.evidence.clone(),
            }),
        ),
        Error::TargetOutsideWindow,
    );
    advance(&env, START_LEDGER + TARGET_MAX_AGE_LEDGERS + 1);
    expect_error(
        registry.try_open_dispute(
            &fixture.registered.asset,
            &fixture.disputer,
            &None,
            &DisputeEvidence::Inclusion(InclusionOpening {
                attestation_id: 1,
                inclusion: fixture.evidence.clone(),
            }),
        ),
        Error::TargetOutsideWindow,
    );
}

#[test]
fn malformed_or_foreign_inclusion_evidence_cannot_open_a_dispute() {
    let env = test_env();
    let fixture = ready(&env);
    let registry = RegistryClient::new(&env, &fixture.registered.registry);
    let mut mutations = std::vec::Vec::new();
    let mut changed = fixture.evidence.clone();
    changed.id = U256::from_u32(&env, 0);
    mutations.push(changed);
    let mut changed = fixture.evidence.clone();
    changed.id = fr_modulus(&env);
    mutations.push(changed);
    let mut changed = fixture.evidence.clone();
    changed.commitment = fr_modulus(&env);
    mutations.push(changed);
    let mut changed = fixture.evidence.clone();
    changed.path.set(0, fr_modulus(&env));
    mutations.push(changed);
    let mut changed = fixture.evidence.clone();
    changed.path.pop_back();
    mutations.push(changed);
    let mut changed = fixture.evidence.clone();
    changed.position = 1 << params::MERKLE_PATH_DEPTH;
    mutations.push(changed);
    let mut changed = fixture.evidence.clone();
    changed.position = 1;
    mutations.push(changed);
    let mut changed = fixture.evidence.clone();
    changed.commitment = U256::from_u32(&env, 1);
    mutations.push(changed);
    for evidence in mutations {
        expect_error(
            registry.try_open_dispute(
                &fixture.registered.asset,
                &fixture.disputer,
                &None,
                &DisputeEvidence::Inclusion(InclusionOpening {
                    attestation_id: 1,
                    inclusion: evidence.clone(),
                }),
            ),
            Error::InvalidInclusion,
        );
    }
    assert_eq!(
        NativeTokenClient::new(&env, &fixture.native).balance(&fixture.disputer),
        INITIAL_FUNDS
    );
    open(&env, &fixture);
}

#[test]
fn the_answer_must_use_the_same_identifier_and_target_root() {
    let env = test_env();
    let fixture = ready(&env);
    let registry = RegistryClient::new(&env, &fixture.registered.registry);
    let (updated, root) = inclusion(&env, CUSTOMER_ID, 0);
    submit(&env, &fixture, &root);
    open(&env, &fixture);
    expect_error(
        registry.try_answer_dispute(&fixture.registered.asset, &3, &fixture.evidence),
        Error::InvalidInclusion,
    );
    let (foreign, _) = inclusion(&env, CUSTOMER_ID + 1, 0);
    expect_error(
        registry.try_answer_dispute(&fixture.registered.asset, &3, &foreign),
        Error::DisputeNotFound,
    );
    registry.answer_dispute(&fixture.registered.asset, &3, &updated);
}

#[test]
fn open_answer_and_bond_need_the_correct_authorization() {
    let env = test_env();
    let fixture = ready(&env);
    let registry = RegistryClient::new(&env, &fixture.registered.registry);
    env.mock_auths(&[]);
    expect_authorization_failure(registry.try_open_dispute(
        &fixture.registered.asset,
        &fixture.disputer,
        &None,
        &DisputeEvidence::Inclusion(InclusionOpening {
            attestation_id: 1,
            inclusion: fixture.evidence.clone(),
        }),
    ));
    expect_authorization_failure(registry.try_fund_bond(&fixture.registered.asset, &BOND_AMOUNT));
    env.mock_all_auths();
    open(&env, &fixture);
    env.mock_auths(&[]);
    expect_authorization_failure(registry.try_answer_dispute(
        &fixture.registered.asset,
        &2,
        &fixture.evidence,
    ));
    env.mock_all_auths();
    registry.answer_dispute(&fixture.registered.asset, &2, &fixture.evidence);
}

#[test]
fn concurrent_disputes_have_separate_deposits_and_burn_once() {
    let env = test_env();
    let fixture = ready(&env);
    let registry = RegistryClient::new(&env, &fixture.registered.registry);
    registry.fund_bond(&fixture.registered.asset, &BOND_AMOUNT);
    open(&env, &fixture);
    submit(&env, &fixture, &fixture.root);
    registry.open_dispute(
        &fixture.registered.asset,
        &fixture.disputer,
        &Some(3),
        &DisputeEvidence::Inclusion(InclusionOpening {
            attestation_id: 1,
            inclusion: fixture.evidence.clone(),
        }),
    );
    advance(&env, START_LEDGER + ANSWER_WINDOW_LEDGERS + 1);
    registry.resolve_dispute(&fixture.registered.asset, &2, &fixture.evidence.id);
    registry.resolve_dispute(&fixture.registered.asset, &3, &fixture.evidence.id);
    assert_eq!(
        registry.get_bond(&fixture.registered.asset).burned,
        BOND_AMOUNT
    );
    assert_eq!(
        registry
            .get_dispute(&fixture.registered.asset, &3, &fixture.evidence.id)
            .burned_bond,
        0
    );
    let token = NativeTokenClient::new(&env, &fixture.native);
    assert_eq!(token.balance(&fixture.registered.registry), BOND_AMOUNT);
    assert_eq!(token.balance(&fixture.disputer), INITIAL_FUNDS);
}

#[test]
fn failed_deposit_cannot_create_a_dispute_or_use_the_bond() {
    let env = test_env();
    let fixture = ready(&env);
    let registry = RegistryClient::new(&env, &fixture.registered.registry);
    let token = NativeTokenClient::new(&env, &fixture.native);
    registry.fund_bond(&fixture.registered.asset, &BOND_AMOUNT);
    token.set_balance(&fixture.disputer, &0);
    assert!(registry
        .try_open_dispute(
            &fixture.registered.asset,
            &fixture.disputer,
            &None,
            &DisputeEvidence::Inclusion(InclusionOpening {
                attestation_id: 1,
                inclusion: fixture.evidence.clone(),
            }),
        )
        .is_err());
    expect_error(
        registry.try_get_dispute(&fixture.registered.asset, &2, &fixture.evidence.id),
        Error::DisputeNotFound,
    );
    assert_eq!(token.balance(&fixture.registered.registry), BOND_AMOUNT);
    assert_eq!(
        registry.get_bond(&fixture.registered.asset).available,
        BOND_AMOUNT
    );
}

#[test]
fn invalid_bond_amounts_and_history_overflow_are_refused() {
    let env = test_env();
    let fixture = ready(&env);
    let registry = RegistryClient::new(&env, &fixture.registered.registry);
    for amount in [0, -1] {
        expect_error(
            registry.try_fund_bond(&fixture.registered.asset, &amount),
            Error::InvalidBondAmount,
        );
    }
    env.as_contract(&fixture.registered.registry, || {
        env.storage().persistent().set(
            &DataKey::AttestationCount(fixture.registered.asset.clone()),
            &u64::MAX,
        );
    });
    expect_error(
        registry.try_submit_attestation(
            &fixture.registered.asset,
            &env.ledger().sequence(),
            &fixture.root,
            &u128::from(CUSTOMER_BALANCE),
            &Bytes::new(&env),
        ),
        Error::AttestationIdOverflow,
    );
}

#[test]
fn the_answer_deadline_cannot_wrap() {
    let env = test_env();
    let fixture = ready_at(&env, u32::MAX - ANSWER_WINDOW_LEDGERS + 1);
    let registry = RegistryClient::new(&env, &fixture.registered.registry);
    expect_error(
        registry.try_open_dispute(
            &fixture.registered.asset,
            &fixture.disputer,
            &None,
            &DisputeEvidence::Inclusion(InclusionOpening {
                attestation_id: 1,
                inclusion: fixture.evidence.clone(),
            }),
        ),
        Error::DeadlineOverflow,
    );
    assert_eq!(
        NativeTokenClient::new(&env, &fixture.native).balance(&fixture.disputer),
        INITIAL_FUNDS
    );
}

#[test]
fn an_explicit_target_can_precede_the_newest_attestation() {
    let env = test_env();
    let fixture = ready(&env);
    let registry = RegistryClient::new(&env, &fixture.registered.registry);
    let (_, later_root) = inclusion(&env, CUSTOMER_ID, CUSTOMER_BALANCE + 1);
    submit(&env, &fixture, &later_root);
    registry.open_dispute(
        &fixture.registered.asset,
        &fixture.disputer,
        &Some(2),
        &DisputeEvidence::Inclusion(InclusionOpening {
            attestation_id: 1,
            inclusion: fixture.evidence.clone(),
        }),
    );
    registry.answer_dispute(&fixture.registered.asset, &2, &fixture.evidence);
    assert_eq!(
        registry
            .get_dispute(&fixture.registered.asset, &2, &fixture.evidence.id)
            .target_id,
        2
    );
}

#[test]
fn failed_settlement_preserves_the_open_dispute_and_bond() {
    let env = test_env();
    let fixture = ready(&env);
    let registry = RegistryClient::new(&env, &fixture.registered.registry);
    let token = NativeTokenClient::new(&env, &fixture.native);
    registry.fund_bond(&fixture.registered.asset, &BOND_AMOUNT);
    open(&env, &fixture);
    token.set_balance(&fixture.registered.registry, &0);
    assert!(registry
        .try_answer_dispute(&fixture.registered.asset, &2, &fixture.evidence)
        .is_err());
    assert_eq!(
        registry
            .get_dispute(&fixture.registered.asset, &2, &fixture.evidence.id)
            .status,
        DisputeStatus::Open
    );
    advance(&env, START_LEDGER + ANSWER_WINDOW_LEDGERS + 1);
    assert!(registry
        .try_resolve_dispute(&fixture.registered.asset, &2, &fixture.evidence.id)
        .is_err());
    assert_eq!(
        registry
            .get_dispute(&fixture.registered.asset, &2, &fixture.evidence.id)
            .status,
        DisputeStatus::Open
    );
    let allocation = registry.get_bond(&fixture.registered.asset);
    assert_eq!(allocation.available, BOND_AMOUNT);
    assert_eq!(allocation.burned, 0);
    token.set_balance(
        &fixture.registered.registry,
        &(BOND_AMOUNT + DISPUTE_DEPOSIT_STROOPS),
    );
    registry.resolve_dispute(&fixture.registered.asset, &2, &fixture.evidence.id);
    assert_eq!(token.balance(&fixture.registered.registry), BOND_AMOUNT);
}
