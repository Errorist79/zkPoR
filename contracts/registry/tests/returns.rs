//! Emits the encoding of every value that a client reads back from the
//! registry, and checks the committed file against it.
//!
//! A client of another language has to know how the registry answers: which
//! keys a record carries, and how a value that names one case of a closed set
//! arrives. Prose cannot carry that, because prose does not fail when the
//! encoding changes. This file therefore writes the encoded values, and the
//! TypeScript client decodes the committed file in its own tests.
//!
//! Run the test with ZKPOR_UPDATE_VECTORS=1 to write the file again after a
//! deliberate change of the interface. A change here is a change of the
//! interface, so it needs a matching change in every client.
//!
//! A value that can exceed 2^53 is a string, not a JSON number, because a JSON
//! number holds no larger integer exactly.

mod common;

use common::{classic_fixture, registered_token, test_env, StubTokenClient, ASSET_CODE4};
use soroban_sdk::{
    testutils::{Events as _, Ledger as _},
    xdr::{ContractEventBody, Limits, ScVal, WriteXdr},
    Address, Bytes, Env, IntoVal, TryFromVal, Val, Vec, U256,
};
use std::{env as std_env, fs, path::PathBuf, string::String, vec::Vec as StdVec};
use zkpor_registry::{AssetAuthenticity, RegistryClient};

const VECTOR_FILE: &str = "fixtures/registry_returns.json";
const UPDATE_FLAG: &str = "ZKPOR_UPDATE_VECTORS";

/// The ledger that these cases start from. A snapshot must sit inside the age
/// window, so the sequence cannot start near zero.
const START_LEDGER: u32 = 10_000;
/// The balance that each reserve address holds. The value is test data.
const RESERVE_BALANCE: i128 = 1_000;
/// The liabilities that the attestation declares. The value is test data.
const TOTAL_LIABILITIES: u128 = 500;
/// The root that the attestation carries. The value is test data.
const FINAL_ROOT: u32 = 42;
/// The reserve address count of the cases. Two is the smallest count that shows
/// a list of more than one element.
const RESERVE_COUNT: u32 = 2;

fn base64(value: &ScVal) -> String {
    value
        .to_xdr_base64(Limits::none())
        .expect("a value of the host encodes")
}

/// The encoded form of one value that a call returned.
fn encoded<T: IntoVal<Env, Val>>(env: &Env, value: &T) -> String {
    let converted: Val = value.into_val(env);
    base64(&ScVal::try_from_val(env, &converted).expect("a returned value converts"))
}

fn quoted(text: &str) -> String {
    let mut out = String::from("\"");
    for character in text.chars() {
        match character {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            other => out.push(other),
        }
    }
    out.push('"');
    out
}

fn hex_u256(value: &U256) -> String {
    let bytes: soroban_sdk::BytesN<32> = value.to_be_bytes().try_into().expect("32 bytes");
    let mut text = String::from("0x");
    for byte in bytes.to_array() {
        text.push_str(&std::format!("{byte:02x}"));
    }
    text
}

fn address_list(addresses: &Vec<Address>) -> String {
    let texts: StdVec<String> = addresses
        .iter()
        .map(|address| quoted(&address.to_string().to_string()))
        .collect();
    std::format!("[{}]", texts.join(", "))
}

/// The record of one asset, encoded, with the values it must decode to.
fn record_case(env: &Env, case: &str, registry: &Address, asset: &Address) -> String {
    let record = RegistryClient::new(env, registry).entry(asset);
    let attestation = match &record.attestation {
        zkpor_registry::AttestationSlot::Empty => String::from("null"),
        zkpor_registry::AttestationSlot::Filled(attestation) => std::format!(
            "{{\"final_root\": {}, \"total_liabilities\": {}, \"snapshot_ledger\": {}, \
             \"reserve_sum\": {}, \"attested_ledger\": {}}}",
            quoted(&hex_u256(&attestation.final_root)),
            quoted(&std::format!("{}", attestation.total_liabilities)),
            attestation.snapshot_ledger,
            quoted(&std::format!("{}", attestation.reserve_sum)),
            attestation.attested_ledger
        ),
    };
    std::format!(
        "{{\"case\": {}, \"call\": \"entry\", \"scval\": {},\n      \"expected\": {{\
         \"authority\": {}, \"tier\": {}, \"reserves\": {}, \"reserve_set_hash\": {}, \
         \"attestation\": {attestation}}}}}",
        quoted(case),
        quoted(&encoded(env, &record)),
        quoted(&record.authority.to_string().to_string()),
        quoted(match record.tier {
            zkpor_registry::AssetTier::ClassicIssuer => "ClassicIssuer",
            zkpor_registry::AssetTier::ContractAdministrator => "ContractAdministrator",
        }),
        address_list(&record.reserves),
        quoted(&hex_u256(&record.reserve_set_hash))
    )
}

/// The reserve observation, encoded, with the values it must decode to.
fn observation_case(env: &Env, case: &str, registry: &Address, asset: &Address) -> String {
    let observation = RegistryClient::new(env, registry).observe_reserves(asset);
    std::format!(
        "{{\"case\": {}, \"call\": \"observe_reserves\", \"scval\": {},\n      \
         \"expected\": {{\"observed_sum\": {}, \"observed_ledger\": {}}}}}",
        quoted(case),
        quoted(&encoded(env, &observation)),
        quoted(&std::format!("{}", observation.observed_sum)),
        observation.observed_ledger
    )
}

/// The one event of the last invocation, as its topics and its data.
fn event_case(env: &Env, case: &str) -> String {
    let all = env.events().all();
    let found = all.events();
    assert_eq!(found.len(), 1, "the attestation emits one event");
    let event = found.first().expect("the event");
    let ContractEventBody::V0(body) = &event.body;
    let topics: StdVec<String> = body
        .topics
        .iter()
        .map(|topic| quoted(&base64(topic)))
        .collect();
    std::format!(
        "{{\"case\": {}, \"topics\": [{}],\n      \"data\": {}}}",
        quoted(case),
        topics.join(", "),
        quoted(&base64(&body.data))
    )
}

fn vectors(env: &Env) -> String {
    env.ledger()
        .with_mut(|ledger| ledger.sequence_number += START_LEDGER);

    // A contract token, under the administrator that the token names.
    let token = registered_token(env, true, RESERVE_COUNT);
    let stub = StubTokenClient::new(env, &token.asset);
    for reserve in token.reserves.iter() {
        stub.set_balance(&reserve, &RESERVE_BALANCE);
    }
    let registry = RegistryClient::new(env, &token.registry);
    let before = record_case(
        env,
        "a contract token with no attestation; the slot names the empty case",
        &token.registry,
        &token.asset,
    );

    let snapshot = env.ledger().sequence() - 1;
    registry.submit_attestation(
        &token.asset,
        &snapshot,
        &U256::from_u32(env, FINAL_ROOT),
        &TOTAL_LIABILITIES,
        &Bytes::from_array(env, &[1, 2, 3, 4]),
    );
    let event = event_case(env, "the event of an accepted attestation");
    let after = record_case(
        env,
        "the same token after an attestation; the slot carries the record",
        &token.registry,
        &token.asset,
    );
    let observation = observation_case(
        env,
        "the reserve reading of the same token; no attestation covers it",
        &token.registry,
        &token.asset,
    );

    // A classic asset, under its issuer account. The tier differs, so the
    // encoding of the tier needs its own case.
    let classic = classic_fixture(env, &ASSET_CODE4);
    let reserves = common::addresses(env, RESERVE_COUNT);
    env.mock_all_auths();
    registry.register_asset(
        &classic.asset,
        &classic.issuer,
        &AssetAuthenticity::Classic(classic.serialized.clone()),
        &reserves,
    );
    let classic_record = record_case(
        env,
        "a classic asset; the authority is the issuer account and the tier differs",
        &token.registry,
        &classic.asset,
    );

    std::format!(
        "{{\n  \"constants\": {{\n    \"attestation_event_topic\": \"attestation_accepted\"\n  }},\n  \
         \"note\": {},\n  \
         \"returns\": [\n    {}\n  ],\n  \"events\": [\n    {}\n  ]\n}}\n",
        quoted(
            "every scval is the base64 XDR of the value that the call returned; a value that can exceed 2^53 is a string"
        ),
        [before, after, observation, classic_record].join(",\n    "),
        event
    )
}

fn vector_path() -> PathBuf {
    PathBuf::from(std_env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(VECTOR_FILE)
}

#[test]
fn the_committed_returns_match_this_implementation() {
    let env = test_env();
    let produced = vectors(&env);
    let path = vector_path();

    if std_env::var(UPDATE_FLAG).is_ok() {
        fs::create_dir_all(path.parent().expect("the fixtures directory")).expect("the directory");
        fs::write(&path, &produced).expect("the file");
        return;
    }

    let committed = fs::read_to_string(&path).unwrap_or_else(|_| {
        std::panic!("{VECTOR_FILE} is missing; run the test with {UPDATE_FLAG}=1")
    });
    assert_eq!(
        committed, produced,
        "{VECTOR_FILE} does not match this implementation"
    );
}

/// The file must not depend on the run. A value that moved between runs would
/// make the committed file fail for a reason that names no change.
#[test]
fn the_returns_are_deterministic() {
    assert_eq!(vectors(&test_env()), vectors(&test_env()));
}
