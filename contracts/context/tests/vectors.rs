//! Emits the shared test vectors and checks the committed file against them.
//!
//! The Noir implementation and the TypeScript implementation must reproduce
//! every value in the file. Run the test with ZKPOR_UPDATE_VECTORS=1 to write
//! the file again after a deliberate change of an algorithm.

use soroban_sdk::{address_payload::AddressPayload, Address, BytesN, Env, Vec, U256};
use std::{env as std_env, fs, path::PathBuf, string::String, vec::Vec as StdVec};
use zkpor_context::{
    context_hash, ctx_domain_tag, encode_address, reserve_set_hash, ADDRESS_PAYLOAD_BYTES,
    ADDRESS_TAG_ACCOUNT, ADDRESS_TAG_CONTRACT, ATTESTATION_MAX_AGE_LEDGERS, MAX_RESERVE_ADDRESSES,
};

const VECTOR_FILE: &str = "fixtures/context_vectors.json";
const UPDATE_FLAG: &str = "ZKPOR_UPDATE_VECTORS";

/// Fixed inputs of the vectors. Each entry is an address type tag and a
/// repeated payload byte, so another implementation can rebuild the inputs
/// from the file alone.
const ADDRESSES: [(u32, u8); 4] = [
    (ADDRESS_TAG_ACCOUNT, 0x00),
    (ADDRESS_TAG_ACCOUNT, 0x01),
    (ADDRESS_TAG_CONTRACT, 0x01),
    (ADDRESS_TAG_CONTRACT, 0xff),
];
/// Index lists into ADDRESSES. The second set is not in sorted order, so the
/// file also pins the sort rule.
const RESERVE_SETS: [&[usize]; 3] = [&[0], &[3, 1, 2], &[0, 1, 2, 3]];
/// Authority index, asset index, reserve set index, and snapshot ledger.
const CONTEXTS: [(usize, usize, usize, u32); 2] = [(1, 2, 0, 0), (0, 3, 1, 4_294_967_295)];

fn address(env: &Env, index: usize) -> Address {
    let (tag, pattern) = ADDRESSES[index];
    let payload = BytesN::from_array(env, &[pattern; ADDRESS_PAYLOAD_BYTES]);
    if tag == ADDRESS_TAG_ACCOUNT {
        AddressPayload::AccountIdPublicKeyEd25519(payload).to_address(env)
    } else {
        AddressPayload::ContractIdHash(payload).to_address(env)
    }
}

fn hex(value: &U256) -> String {
    let bytes: BytesN<32> = value.to_be_bytes().try_into().unwrap();
    let mut text = String::from("0x");
    for byte in bytes.to_array() {
        text.push_str(&std::format!("{byte:02x}"));
    }
    text
}

fn address_json(env: &Env, index: usize) -> String {
    let (tag, pattern) = ADDRESSES[index];
    let (hi, lo) = encode_address(env, &address(env, index)).unwrap();
    std::format!(
        "{{\"tag\": {tag}, \"payload_byte\": {pattern}, \"hi\": \"{}\", \"lo\": \"{}\"}}",
        hex(&hi),
        hex(&lo)
    )
}

fn vectors(env: &Env) -> String {
    let addresses: StdVec<String> = (0..ADDRESSES.len())
        .map(|index| address_json(env, index))
        .collect();

    let mut set_hashes = StdVec::new();
    let mut sets = StdVec::new();
    for members in RESERVE_SETS {
        let mut list = Vec::new(env);
        for index in members {
            list.push_back(address(env, *index));
        }
        let hash = reserve_set_hash(env, &list).unwrap();
        sets.push(std::format!(
            "{{\"addresses\": {members:?}, \"reserve_set_hash\": \"{}\"}}",
            hex(&hash)
        ));
        set_hashes.push(hash);
    }

    let contexts: StdVec<String> = CONTEXTS
        .iter()
        .map(|(authority, asset, set, ledger)| {
            let hash = context_hash(
                env,
                &address(env, *authority),
                &address(env, *asset),
                &set_hashes[*set],
                *ledger,
            )
            .unwrap();
            std::format!(
                "{{\"authority\": {authority}, \"asset\": {asset}, \"reserve_set\": {set}, \
                 \"snapshot_ledger\": {ledger}, \"context_hash\": \"{}\"}}",
                hex(&hash)
            )
        })
        .collect();

    std::format!(
        "{{\n  \"constants\": {{\n    \"ctx_domain_tag\": \"{}\",\n    \
         \"max_reserve_addresses\": {},\n    \"attestation_max_age_ledgers\": {},\n    \
         \"address_tag_account\": {},\n    \"address_tag_contract\": {}\n  }},\n  \
         \"addresses\": [\n    {}\n  ],\n  \"reserve_sets\": [\n    {}\n  ],\n  \
         \"contexts\": [\n    {}\n  ]\n}}\n",
        hex(&ctx_domain_tag(env)),
        MAX_RESERVE_ADDRESSES,
        ATTESTATION_MAX_AGE_LEDGERS,
        ADDRESS_TAG_ACCOUNT,
        ADDRESS_TAG_CONTRACT,
        addresses.join(",\n    "),
        sets.join(",\n    "),
        contexts.join(",\n    ")
    )
}

fn vector_path() -> PathBuf {
    PathBuf::from(std_env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(VECTOR_FILE)
}

#[test]
fn the_committed_vectors_match_this_implementation() {
    let env = Env::default();
    env.cost_estimate().budget().reset_unlimited();
    let produced = vectors(&env);
    let path = vector_path();

    if std_env::var(UPDATE_FLAG).is_ok() {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, &produced).unwrap();
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

#[test]
fn the_vectors_are_deterministic() {
    let first = Env::default();
    first.cost_estimate().budget().reset_unlimited();
    let second = Env::default();
    second.cost_estimate().budget().reset_unlimited();
    assert_eq!(vectors(&first), vectors(&second));
}
