//! Deployment, registration, and authorization tests.
//!
//! Every rejection is checked for the reason it names, so a test cannot pass
//! because the call failed somewhere else.
//!
//! Two properties of the authorization model stay untested here, and a reader
//! must not assume this suite covers them:
//!
//! - Network binding. The network identifier appears only in the preimage
//!   that a signer signs. The test host accepts a void signature, so no test
//!   can move a consent to another network and see the refusal.
//! - Multisig weights and thresholds of an account address. The test host
//!   holds no account signers, so a test cannot lower a weight below a
//!   threshold.

mod common;

use common::{
    account, addresses, canonical_address, classic_asset, classic_fixture, deploy_registry,
    expect_authorization_failure, expect_error, test_env, PassiveContract, PermissiveAccount,
    StubVerifier, ASSET_CODE12, ASSET_CODE4, ISSUER_KEY, OTHER_ACCOUNT_KEY, RELEASE_KEY,
};
use soroban_sdk::{
    testutils::{
        storage::{Instance as _, Persistent as _},
        Address as _, Ledger as _, MockAuth, MockAuthInvoke,
    },
    xdr, Address, Bytes, Env, IntoVal, Val, Vec, U256,
};
use zkpor_context::MAX_RESERVE_ADDRESSES;
use zkpor_registry::{
    AssetAuthenticity, AssetEntry, AssetTier, Attestation, AttestationSlot, DataKey, Error,
    Registry, RegistryClient, NATIVE_ASSET_XDR,
};

/// How long a consent of the authorization tests stays valid. The value is
/// test data. It must stay below the largest time to live that the network
/// allows, because the host refuses an expiration beyond it.
const AUTH_LIFETIME_LEDGERS: u32 = 1_000;
/// The ledger that the authorization tests start from. A test needs a past
/// ledger for an expired consent, so the sequence cannot start at zero.
const AUTH_START_LEDGER: u32 = 100;

#[test]
fn the_deployment_reads_the_key_of_a_real_verifier() {
    let env = test_env();
    let verifier = env.register(
        ultrahonk_verifier::UltraHonkVerifierContract,
        (Bytes::from_slice(&env, RELEASE_KEY),),
    );
    let registry_id = env.register(Registry, (verifier.clone(),));

    env.as_contract(&registry_id, || {
        let stored: Address = env.storage().instance().get(&DataKey::Verifier).unwrap();
        assert_eq!(stored, verifier);
    });
}

/// The deployment fails with VerifierKeyMismatch, which is contract error 5.
/// A panic carries the code and not the name.
#[test]
#[should_panic(expected = "Error(Contract, #5)")]
fn the_deployment_refuses_a_verifier_that_holds_another_key() {
    let env = test_env();
    let mut key = Bytes::from_slice(&env, RELEASE_KEY);
    key.set(0, key.get_unchecked(0) ^ 1);
    let verifier = env.register(StubVerifier, (key, true));

    env.register(Registry, (verifier,));
}

#[test]
fn a_classic_asset_registers_under_its_issuer() {
    let env = test_env();
    env.mock_all_auths();
    let registry = RegistryClient::new(&env, &deploy_registry(&env));
    let classic = classic_fixture(&env, &ASSET_CODE4);
    let reserves = addresses(&env, 2);

    registry.register_asset(
        &classic.asset,
        &classic.issuer,
        &AssetAuthenticity::Classic(classic.serialized),
        &reserves,
    );

    let entry = registry.entry(&classic.asset);
    assert_eq!(entry.authority, classic.issuer);
    assert_eq!(entry.tier, AssetTier::ClassicIssuer);
    assert_eq!(entry.reserves, reserves);
    assert_eq!(
        entry.reserve_set_hash,
        zkpor_context::reserve_set_hash(&env, &reserves).unwrap()
    );
    assert_eq!(entry.attestation, AttestationSlot::Empty);
}

#[test]
fn a_twelve_character_asset_code_registers_as_well() {
    let env = test_env();
    env.mock_all_auths();
    let registry = RegistryClient::new(&env, &deploy_registry(&env));
    let classic = classic_fixture(&env, &ASSET_CODE12);

    registry.register_asset(
        &classic.asset,
        &classic.issuer,
        &AssetAuthenticity::Classic(classic.serialized),
        &addresses(&env, 1),
    );

    assert_eq!(
        registry.entry(&classic.asset).tier,
        AssetTier::ClassicIssuer
    );
}

#[test]
fn a_contract_token_registers_under_its_administrator() {
    let env = test_env();
    env.mock_all_auths();
    let registry = RegistryClient::new(&env, &deploy_registry(&env));
    let administrator = Address::generate(&env);
    let token = env.register_stellar_asset_contract_v2(administrator.clone());
    let reserves = addresses(&env, 1);

    registry.register_asset(
        &token.address(),
        &administrator,
        &AssetAuthenticity::Contract,
        &reserves,
    );

    let entry = registry.entry(&token.address());
    assert_eq!(entry.authority, administrator);
    assert_eq!(entry.tier, AssetTier::ContractAdministrator);
}

#[test]
fn an_asset_address_that_is_not_the_canonical_one_is_rejected() {
    let env = test_env();
    env.mock_all_auths();
    let registry = RegistryClient::new(&env, &deploy_registry(&env));
    let classic = classic_fixture(&env, &ASSET_CODE4);

    expect_error(
        registry.try_register_asset(
            &Address::generate(&env),
            &classic.issuer,
            &AssetAuthenticity::Classic(classic.serialized),
            &addresses(&env, 1),
        ),
        Error::NotTheCanonicalAssetContract,
    );
}

#[test]
fn an_issuer_that_is_not_the_authority_is_rejected() {
    let env = test_env();
    env.mock_all_auths();
    let registry = RegistryClient::new(&env, &deploy_registry(&env));
    let classic = classic_fixture(&env, &ASSET_CODE4);

    expect_error(
        registry.try_register_asset(
            &classic.asset,
            &account(&env, &OTHER_ACCOUNT_KEY),
            &AssetAuthenticity::Classic(classic.serialized),
            &addresses(&env, 1),
        ),
        Error::IssuerMismatch,
    );
}

#[test]
fn an_administrator_that_is_not_the_authority_is_rejected() {
    let env = test_env();
    env.mock_all_auths();
    let registry = RegistryClient::new(&env, &deploy_registry(&env));
    let token = env.register_stellar_asset_contract_v2(Address::generate(&env));

    expect_error(
        registry.try_register_asset(
            &token.address(),
            &Address::generate(&env),
            &AssetAuthenticity::Contract,
            &addresses(&env, 1),
        ),
        Error::AdministratorMismatch,
    );
}

#[test]
fn a_token_without_an_administrator_function_is_rejected() {
    let env = test_env();
    env.mock_all_auths();
    let registry = RegistryClient::new(&env, &deploy_registry(&env));
    let token = env.register(PassiveContract, ());

    expect_error(
        registry.try_register_asset(
            &token,
            &Address::generate(&env),
            &AssetAuthenticity::Contract,
            &addresses(&env, 1),
        ),
        Error::AdministratorMissing,
    );
}

#[test]
fn the_native_asset_is_rejected_under_the_classic_tier() {
    let env = test_env();
    env.mock_all_auths();
    let registry = RegistryClient::new(&env, &deploy_registry(&env));
    let serialized = Bytes::from_array(&env, &NATIVE_ASSET_XDR);

    expect_error(
        registry.try_register_asset(
            &canonical_address(&env, &serialized),
            &account(&env, &ISSUER_KEY),
            &AssetAuthenticity::Classic(serialized),
            &addresses(&env, 1),
        ),
        Error::NativeAssetNotSupported,
    );
}

#[test]
fn the_native_asset_is_rejected_under_the_contract_tier() {
    let env = test_env();
    env.mock_all_auths();
    let registry = RegistryClient::new(&env, &deploy_registry(&env));
    let native = canonical_address(&env, &Bytes::from_array(&env, &NATIVE_ASSET_XDR));

    expect_error(
        registry.try_register_asset(
            &native,
            &Address::generate(&env),
            &AssetAuthenticity::Contract,
            &addresses(&env, 1),
        ),
        Error::NativeAssetNotSupported,
    );
}

/// The host answers the largest signed 64-bit value for the balance of a
/// classic issuer in its own asset, so an issuer in its own reserve set covers
/// every liability without holding anything.
#[test]
fn a_reserve_set_that_names_the_issuer_is_rejected() {
    let env = test_env();
    env.mock_all_auths();
    let registry = RegistryClient::new(&env, &deploy_registry(&env));
    let classic = classic_fixture(&env, &ASSET_CODE4);
    let authenticity = AssetAuthenticity::Classic(classic.serialized);

    let mut reserves = addresses(&env, 1);
    reserves.push_back(classic.issuer.clone());
    expect_error(
        registry.try_register_asset(&classic.asset, &classic.issuer, &authenticity, &reserves),
        Error::AuthorityInReserveSet,
    );

    // The same call without the issuer in the set is accepted.
    reserves.pop_back();
    registry.register_asset(&classic.asset, &classic.issuer, &authenticity, &reserves);
}

/// The mint function of the standard administrative interface requires the
/// administrator, so a contract token has the same hole under tier 2.
#[test]
fn a_reserve_set_that_names_the_administrator_is_rejected() {
    let env = test_env();
    env.mock_all_auths();
    let registry = RegistryClient::new(&env, &deploy_registry(&env));
    let administrator = Address::generate(&env);
    let token = env.register_stellar_asset_contract_v2(administrator.clone());

    let mut reserves = addresses(&env, 1);
    reserves.push_back(administrator.clone());
    expect_error(
        registry.try_register_asset(
            &token.address(),
            &administrator,
            &AssetAuthenticity::Contract,
            &reserves,
        ),
        Error::AuthorityInReserveSet,
    );

    // The same call without the administrator in the set is accepted.
    reserves.pop_back();
    registry.register_asset(
        &token.address(),
        &administrator,
        &AssetAuthenticity::Contract,
        &reserves,
    );
}

#[test]
fn set_reserves_cannot_introduce_the_authority() {
    let env = test_env();
    env.mock_all_auths();
    let registry = RegistryClient::new(&env, &deploy_registry(&env));
    let classic = classic_fixture(&env, &ASSET_CODE4);
    registry.register_asset(
        &classic.asset,
        &classic.issuer,
        &AssetAuthenticity::Classic(classic.serialized),
        &addresses(&env, 1),
    );

    let mut replacement = addresses(&env, 2);
    replacement.push_back(classic.issuer.clone());
    expect_error(
        registry.try_set_reserves(&classic.asset, &replacement),
        Error::AuthorityInReserveSet,
    );

    // The same change without the issuer in the set is accepted.
    replacement.pop_back();
    registry.set_reserves(&classic.asset, &replacement);
    assert_eq!(registry.entry(&classic.asset).reserves, replacement);
}

#[test]
fn a_serialized_value_that_is_not_a_classic_asset_is_rejected() {
    let env = test_env();
    env.mock_all_auths();
    let registry = RegistryClient::new(&env, &deploy_registry(&env));
    let issuer = account(&env, &ISSUER_KEY);
    let valid = classic_asset(&env, &ASSET_CODE4, &ISSUER_KEY);

    // A truncated value, a value with a trailing byte, an unknown asset type,
    // and an unknown public key type.
    let truncated = valid.slice(..valid.len() - 1);
    let mut extended = valid.clone();
    extended.push_back(0);
    let mut unknown_asset_type = valid.clone();
    unknown_asset_type.set(3, 9);
    let mut unknown_key_type = valid.clone();
    unknown_key_type.set(11, 9);

    for serialized in [truncated, extended, unknown_asset_type, unknown_key_type] {
        // The asset address is never derived from a value of an unknown
        // shape, so any address serves here.
        expect_error(
            registry.try_register_asset(
                &Address::generate(&env),
                &issuer,
                &AssetAuthenticity::Classic(serialized),
                &addresses(&env, 1),
            ),
            Error::MalformedAsset,
        );
    }
}

#[test]
fn a_second_registration_of_the_same_asset_is_rejected() {
    let env = test_env();
    env.mock_all_auths();
    let registry = RegistryClient::new(&env, &deploy_registry(&env));
    let classic = classic_fixture(&env, &ASSET_CODE4);

    registry.register_asset(
        &classic.asset,
        &classic.issuer,
        &AssetAuthenticity::Classic(classic.serialized.clone()),
        &addresses(&env, 1),
    );
    expect_error(
        registry.try_register_asset(
            &classic.asset,
            &classic.issuer,
            &AssetAuthenticity::Classic(classic.serialized),
            &addresses(&env, 1),
        ),
        Error::AssetAlreadyRegistered,
    );
}

#[test]
fn a_reserve_set_of_the_wrong_shape_is_rejected() {
    let env = test_env();
    env.mock_all_auths();
    let registry = RegistryClient::new(&env, &deploy_registry(&env));
    let classic = classic_fixture(&env, &ASSET_CODE4);
    let authenticity = AssetAuthenticity::Classic(classic.serialized);

    let mut duplicate = addresses(&env, 1);
    duplicate.push_back(duplicate.get_unchecked(0));

    for (reserves, expected) in [
        (Vec::new(&env), Error::EmptyReserveSet),
        (
            addresses(&env, MAX_RESERVE_ADDRESSES + 1),
            Error::TooManyReserveAddresses,
        ),
        (duplicate, Error::DuplicateReserveAddress),
    ] {
        expect_error(
            registry.try_register_asset(&classic.asset, &classic.issuer, &authenticity, &reserves),
            expected,
        );
    }
}

#[test]
fn a_reserve_address_that_did_not_authorize_is_rejected() {
    let env = test_env();
    let registry_id = deploy_registry(&env);
    let registry = RegistryClient::new(&env, &registry_id);
    let administrator = Address::generate(&env);
    let token = env.register_stellar_asset_contract_v2(administrator.clone());
    let reserves = addresses(&env, 2);
    let authenticity = AssetAuthenticity::Contract;
    let args: Vec<Val> = (
        token.address(),
        administrator.clone(),
        authenticity.clone(),
        reserves.clone(),
    )
        .into_val(&env);

    // Every party but the second reserve address authorizes the call.
    let first = reserves.get_unchecked(0);
    env.mock_auths(&[
        MockAuth {
            address: &administrator,
            invoke: &MockAuthInvoke {
                contract: &registry_id,
                fn_name: "register_asset",
                args: args.clone(),
                sub_invokes: &[],
            },
        },
        MockAuth {
            address: &first,
            invoke: &MockAuthInvoke {
                contract: &registry_id,
                fn_name: "register_asset",
                args,
                sub_invokes: &[],
            },
        },
    ]);

    expect_authorization_failure(registry.try_register_asset(
        &token.address(),
        &administrator,
        &authenticity,
        &reserves,
    ));

    // The same call with the second consent in place is accepted.
    env.mock_all_auths();
    registry.register_asset(&token.address(), &administrator, &authenticity, &reserves);
}

#[test]
fn a_passive_contract_cannot_be_a_reserve_address() {
    let env = test_env();
    let registry_id = deploy_registry(&env);
    let registry = RegistryClient::new(&env, &registry_id);
    let administrator = Address::generate(&env);
    let token = env.register_stellar_asset_contract_v2(administrator.clone());
    // A passive contract is neither the invoker nor a custom account, so it
    // cannot pass require_auth.
    let mut reserves = Vec::new(&env);
    reserves.push_back(env.register(PassiveContract, ()));
    let authenticity = AssetAuthenticity::Contract;

    env.mock_auths(&[MockAuth {
        address: &administrator,
        invoke: &MockAuthInvoke {
            contract: &registry_id,
            fn_name: "register_asset",
            args: (
                token.address(),
                administrator.clone(),
                authenticity.clone(),
                reserves.clone(),
            )
                .into_val(&env),
            sub_invokes: &[],
        },
    }]);

    expect_authorization_failure(registry.try_register_asset(
        &token.address(),
        &administrator,
        &authenticity,
        &reserves,
    ));

    // Recorded consent for every party makes the same call pass, so the
    // rejection came from the consent that the passive contract cannot give.
    env.mock_all_auths();
    registry.register_asset(&token.address(), &administrator, &authenticity, &reserves);
}

/// One authorization entry, and three calls that must not accept it: the same
/// call with another reserve set, the same call at another registry, and
/// another function of the same registry.
#[test]
fn a_consent_binds_to_the_call_it_was_given_for() {
    let env = test_env();
    let registry_id = deploy_registry(&env);
    let registry = RegistryClient::new(&env, &registry_id);
    let other_registry = deploy_registry(&env);
    let administrator = Address::generate(&env);
    let token = env.register_stellar_asset_contract_v2(administrator.clone());
    let reserves = addresses(&env, 1);
    let other_reserves = addresses(&env, 1);
    let authenticity = AssetAuthenticity::Contract;
    let reserve = reserves.get_unchecked(0);
    let consented_args: Vec<Val> = (
        token.address(),
        administrator.clone(),
        authenticity.clone(),
        other_reserves.clone(),
    )
        .into_val(&env);

    let authorize = |contract: &Address, fn_name: &'static str, args: Vec<Val>| {
        env.mock_auths(&[
            MockAuth {
                address: &administrator,
                invoke: &MockAuthInvoke {
                    contract: &registry_id,
                    fn_name: "register_asset",
                    args: (
                        token.address(),
                        administrator.clone(),
                        authenticity.clone(),
                        reserves.clone(),
                    )
                        .into_val(&env),
                    sub_invokes: &[],
                },
            },
            MockAuth {
                address: &reserve,
                invoke: &MockAuthInvoke {
                    contract,
                    fn_name,
                    args,
                    sub_invokes: &[],
                },
            },
        ]);
    };

    // The consent names another reserve set.
    authorize(&registry_id, "register_asset", consented_args);
    expect_authorization_failure(registry.try_register_asset(
        &token.address(),
        &administrator,
        &authenticity,
        &reserves,
    ));

    let correct_args: Vec<Val> = (
        token.address(),
        administrator.clone(),
        authenticity.clone(),
        reserves.clone(),
    )
        .into_val(&env);

    // The consent names another registry.
    authorize(&other_registry, "register_asset", correct_args.clone());
    expect_authorization_failure(registry.try_register_asset(
        &token.address(),
        &administrator,
        &authenticity,
        &reserves,
    ));

    // The consent names another function.
    authorize(&registry_id, "set_reserves", correct_args);
    expect_authorization_failure(registry.try_register_asset(
        &token.address(),
        &administrator,
        &authenticity,
        &reserves,
    ));

    // The same call with every consent in place is accepted, so the three
    // rejections above came from the consent and from nothing else.
    env.mock_all_auths();
    registry.register_asset(&token.address(), &administrator, &authenticity, &reserves);
}

#[test]
fn set_reserves_replaces_the_set_and_its_hash() {
    let env = test_env();
    env.mock_all_auths();
    let registry = RegistryClient::new(&env, &deploy_registry(&env));
    let classic = classic_fixture(&env, &ASSET_CODE4);
    registry.register_asset(
        &classic.asset,
        &classic.issuer,
        &AssetAuthenticity::Classic(classic.serialized),
        &addresses(&env, 1),
    );

    let replacement = addresses(&env, 3);
    registry.set_reserves(&classic.asset, &replacement);

    let entry = registry.entry(&classic.asset);
    assert_eq!(entry.reserves, replacement);
    assert_eq!(
        entry.reserve_set_hash,
        zkpor_context::reserve_set_hash(&env, &replacement).unwrap()
    );
    assert_eq!(entry.authority, classic.issuer);
}

#[test]
fn set_reserves_clears_a_stored_attestation() {
    let env = test_env();
    env.mock_all_auths();
    let registry_id = deploy_registry(&env);
    let registry = RegistryClient::new(&env, &registry_id);
    let classic = classic_fixture(&env, &ASSET_CODE4);
    registry.register_asset(
        &classic.asset,
        &classic.issuer,
        &AssetAuthenticity::Classic(classic.serialized),
        &addresses(&env, 1),
    );

    let key = DataKey::Asset(classic.asset.clone());
    env.as_contract(&registry_id, || {
        let mut entry: AssetEntry = env.storage().persistent().get(&key).unwrap();
        entry.attestation = AttestationSlot::Filled(Attestation {
            final_root: U256::from_u32(&env, 1),
            total_liabilities: 2,
            snapshot_ledger: 3,
            reserve_sum: 4,
            attested_ledger: 5,
        });
        env.storage().persistent().set(&key, &entry);
    });

    registry.set_reserves(&classic.asset, &addresses(&env, 2));
    assert_eq!(
        registry.entry(&classic.asset).attestation,
        AttestationSlot::Empty
    );
}

#[test]
fn set_reserves_needs_the_recorded_authority() {
    let env = test_env();
    let registry_id = deploy_registry(&env);
    let registry = RegistryClient::new(&env, &registry_id);
    let administrator = Address::generate(&env);
    let token = env.register_stellar_asset_contract_v2(administrator.clone());
    let reserves = addresses(&env, 1);

    env.mock_all_auths();
    registry.register_asset(
        &token.address(),
        &administrator,
        &AssetAuthenticity::Contract,
        &reserves,
    );

    // Every party but the recorded authority authorizes the change.
    let replacement = addresses(&env, 1);
    let reserve = replacement.get_unchecked(0);
    env.mock_auths(&[MockAuth {
        address: &reserve,
        invoke: &MockAuthInvoke {
            contract: &registry_id,
            fn_name: "set_reserves",
            args: (token.address(), replacement.clone()).into_val(&env),
            sub_invokes: &[],
        },
    }]);

    expect_authorization_failure(registry.try_set_reserves(&token.address(), &replacement));

    // The same change with the authority in place is accepted.
    env.mock_all_auths();
    registry.set_reserves(&token.address(), &replacement);
}

/// One registered contract token whose authority and whose reserve address are
/// account contracts, so a test can build the authorization entries itself.
struct Consenting {
    registry: Address,
    asset: Address,
    authority: Address,
    reserves: Vec<Address>,
}

fn consenting_fixture(env: &Env) -> Consenting {
    env.ledger()
        .with_mut(|ledger| ledger.sequence_number += AUTH_START_LEDGER);
    let registry_id = deploy_registry(env);
    let authority = env.register(PermissiveAccount, ());
    let token = env.register_stellar_asset_contract_v2(authority.clone());
    let mut reserves = Vec::new(env);
    reserves.push_back(env.register(PermissiveAccount, ()));

    env.mock_all_auths();
    RegistryClient::new(env, &registry_id).register_asset(
        &token.address(),
        &authority,
        &AssetAuthenticity::Contract,
        &reserves,
    );
    Consenting {
        registry: registry_id,
        asset: token.address(),
        authority,
        reserves,
    }
}

/// One authorization entry for `set_reserves`, with the address credentials
/// that the enforcing host path reads: the nonce and the expiration ledger.
fn set_reserves_entry(
    env: &Env,
    address: &Address,
    fixture: &Consenting,
    nonce: i64,
    expiration: u32,
) -> xdr::SorobanAuthorizationEntry {
    xdr::SorobanAuthorizationEntry {
        root_invocation: (&MockAuthInvoke {
            contract: &fixture.registry,
            fn_name: "set_reserves",
            args: (fixture.asset.clone(), fixture.reserves.clone()).into_val(env),
            sub_invokes: &[],
        })
            .into(),
        credentials: xdr::SorobanCredentials::Address(xdr::SorobanAddressCredentials {
            address: address.into(),
            nonce,
            signature_expiration_ledger: expiration,
            signature: xdr::ScVal::Void,
        }),
    }
}

/// The consents of both parties of one `set_reserves` call.
fn set_reserves_entries(
    env: &Env,
    fixture: &Consenting,
    nonce: i64,
    expiration: u32,
) -> [xdr::SorobanAuthorizationEntry; 2] {
    [
        set_reserves_entry(env, &fixture.authority, fixture, nonce, expiration),
        set_reserves_entry(
            env,
            &fixture.reserves.get_unchecked(0),
            fixture,
            nonce,
            expiration,
        ),
    ]
}

/// The host writes a consumed nonce as a ledger entry of the address, so the
/// same entry cannot authorize a second call.
#[test]
fn a_captured_consent_cannot_be_replayed() {
    let env = test_env();
    let fixture = consenting_fixture(&env);
    let registry = RegistryClient::new(&env, &fixture.registry);
    let expiration = env.ledger().sequence() + AUTH_LIFETIME_LEDGERS;

    env.set_auths(&set_reserves_entries(&env, &fixture, 1, expiration));
    registry.set_reserves(&fixture.asset, &fixture.reserves);

    // The same entries again, which is what a captured consent gives an
    // attacker.
    env.set_auths(&set_reserves_entries(&env, &fixture, 1, expiration));
    expect_authorization_failure(registry.try_set_reserves(&fixture.asset, &fixture.reserves));

    // The same call with a fresh nonce is accepted, so the refusal came from
    // the consumed nonce and from nothing else.
    env.set_auths(&set_reserves_entries(&env, &fixture, 2, expiration));
    registry.set_reserves(&fixture.asset, &fixture.reserves);
}

/// The host reads the expiration ledger of the credentials before a signature
/// means anything, so a consent that expired authorizes no call.
#[test]
fn a_consent_that_expired_authorizes_nothing() {
    let env = test_env();
    let fixture = consenting_fixture(&env);
    let registry = RegistryClient::new(&env, &fixture.registry);

    let past = env.ledger().sequence() - 1;
    env.set_auths(&set_reserves_entries(&env, &fixture, 1, past));
    expect_authorization_failure(registry.try_set_reserves(&fixture.asset, &fixture.reserves));

    // The same entries, the same nonce, and a live expiration are accepted,
    // so the refusal came from the expiration alone.
    let live = env.ledger().sequence() + AUTH_LIFETIME_LEDGERS;
    env.set_auths(&set_reserves_entries(&env, &fixture, 1, live));
    registry.set_reserves(&fixture.asset, &fixture.reserves);
}

#[test]
fn every_write_extends_the_entry_and_the_contract() {
    let env = test_env();
    env.mock_all_auths();
    let registry_id = deploy_registry(&env);
    let registry = RegistryClient::new(&env, &registry_id);
    let classic = classic_fixture(&env, &ASSET_CODE4);
    registry.register_asset(
        &classic.asset,
        &classic.issuer,
        &AssetAuthenticity::Classic(classic.serialized),
        &addresses(&env, 1),
    );

    let key = DataKey::Asset(classic.asset.clone());
    let largest = env.as_contract(&registry_id, || env.storage().max_ttl());
    env.as_contract(&registry_id, || {
        assert_eq!(env.storage().persistent().get_ttl(&key), largest);
        assert_eq!(env.storage().instance().get_ttl(), largest);
    });

    // Ledgers pass, the time to live falls, and the next write tops both up.
    let elapsed = 1_000;
    env.ledger()
        .with_mut(|ledger| ledger.sequence_number += elapsed);
    env.as_contract(&registry_id, || {
        assert_eq!(env.storage().persistent().get_ttl(&key), largest - elapsed);
    });

    registry.set_reserves(&classic.asset, &addresses(&env, 2));
    env.as_contract(&registry_id, || {
        assert_eq!(env.storage().persistent().get_ttl(&key), largest);
        assert_eq!(env.storage().instance().get_ttl(), largest);
    });
}

#[test]
fn an_unregistered_asset_has_no_entry_and_no_reserve_change() {
    let env = test_env();
    env.mock_all_auths();
    let registry = RegistryClient::new(&env, &deploy_registry(&env));
    let asset = Address::generate(&env);

    expect_error(registry.try_entry(&asset), Error::AssetNotRegistered);
    expect_error(
        registry.try_set_reserves(&asset, &addresses(&env, 1)),
        Error::AssetNotRegistered,
    );
}
