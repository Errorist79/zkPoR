//! Emits the shared test vectors and checks the committed file against them.
//!
//! The Noir implementation and the TypeScript implementation must reproduce
//! every value in the file. Run the test with ZKPOR_UPDATE_VECTORS=1 to write
//! the file again after a deliberate change of an algorithm.
//!
//! Every case carries a `case` string. A failure then names the shape that
//! broke, and a reader does not have to rebuild the intent of the inputs.
//!
//! A value that can exceed 2^53 is a decimal string, not a JSON number. The
//! JSON number type holds no larger integer exactly, so a number would give a
//! reader a value that differs from the value the hash consumed.

use soroban_sdk::{address_payload::AddressPayload, Address, Bytes, BytesN, Env, Vec, U256};
use std::{env as std_env, fs, path::PathBuf, string::String, vec::Vec as StdVec};
use zkpor_context::{
    context_hash, ctx_domain_tag, derive_salt, encode_address, fr_in_range, fr_modulus, fr_reduce,
    leaf_hash, node_hash, reserve_set_hash, salt_domain_tag, ADDRESS_LIMB_BYTES,
    ADDRESS_PAYLOAD_BYTES, ADDRESS_TAG_ACCOUNT, ADDRESS_TAG_CONTRACT, ATTESTATION_MAX_AGE_LEDGERS,
    FR_BYTES, MAX_RESERVE_ADDRESSES, PADDING_LEAF_BALANCE, PADDING_LEAF_ID, POSEIDON2_STATE_WIDTH,
};

const VECTOR_FILE: &str = "fixtures/context_vectors.json";
const UPDATE_FLAG: &str = "ZKPOR_UPDATE_VECTORS";

/// The payload of an address, as a rule over the 32 payload bytes.
#[derive(Copy, Clone)]
enum Payload {
    /// Every byte holds one value.
    Repeat(u8),
    /// Every byte is zero, except the byte at the index.
    OneByte(usize, u8),
    /// Byte `j` holds `base + j`, so the high limb never equals the low limb.
    Ramp(u8),
}

/// A field element that a case names, rather than supplies as bytes.
#[derive(Copy, Clone)]
enum Fr {
    /// A value that a u64 holds.
    Small(u64),
    /// The largest field element, `r - 1`.
    Largest,
}

/// A member list of a reserve set, as indices into the address table.
enum SetSpec {
    /// The listed indices, in the listed order.
    Explicit(&'static [usize]),
    /// The first `n` addresses, in ascending index order.
    Prefix(usize),
    /// The first `n` addresses, in descending index order.
    PrefixReversed(usize),
}

/// Addresses whose payloads sit on a boundary of the limb encoding.
const BOUNDARY_ADDRESSES: [(u32, Payload, &str); 12] = [
    (
        ADDRESS_TAG_ACCOUNT,
        Payload::Repeat(0x00),
        "account, every payload byte zero",
    ),
    (
        ADDRESS_TAG_ACCOUNT,
        Payload::Repeat(0xff),
        "account, every payload bit set",
    ),
    (
        ADDRESS_TAG_CONTRACT,
        Payload::Repeat(0x00),
        "contract, the payload of address 0; only the tag differs",
    ),
    (
        ADDRESS_TAG_CONTRACT,
        Payload::Repeat(0xff),
        "contract, the payload of address 1; only the tag differs",
    ),
    (
        ADDRESS_TAG_ACCOUNT,
        Payload::Ramp(0),
        "account, payload byte j holds j; a limb exchange or a byte reversal changes the limbs",
    ),
    (
        ADDRESS_TAG_ACCOUNT,
        Payload::OneByte(0, 0x80),
        "account, the high bit of the first payload byte",
    ),
    (
        ADDRESS_TAG_ACCOUNT,
        Payload::OneByte(15, 0x01),
        "account, the last byte of the high limb",
    ),
    (
        ADDRESS_TAG_ACCOUNT,
        Payload::OneByte(16, 0x01),
        "account, the first byte of the low limb",
    ),
    (
        ADDRESS_TAG_ACCOUNT,
        Payload::OneByte(31, 0x01),
        "account, the last byte of the low limb",
    ),
    (
        ADDRESS_TAG_CONTRACT,
        Payload::OneByte(15, 0x01),
        "contract, the last byte of the high limb",
    ),
    (
        ADDRESS_TAG_CONTRACT,
        Payload::OneByte(16, 0x01),
        "contract, the first byte of the low limb",
    ),
    (
        ADDRESS_TAG_ACCOUNT,
        Payload::OneByte(31, 0x02),
        "account, the payload of address 8 with another last byte",
    ),
];

/// Distinct addresses that fill a large reserve set. The table must hold at
/// least MAX_RESERVE_ADDRESSES entries.
const FILLER_ADDRESSES: usize = 24;

/// Reserve sets. A set of N addresses hashes 2N inputs, and the sponge
/// absorbs the inputs in groups of the rate, so the remainder of the input
/// count divided by the rate selects the shape of the last absorb. The sizes
/// therefore cover every remainder at the small end and at the bound: 1, 2,
/// and 3 addresses, and the three largest sizes that MAX_RESERVE_ADDRESSES
/// permits. The sizes in between cover the earlier bound of sixteen.
const RESERVE_SETS: [(SetSpec, &str); 18] = [
    (SetSpec::Explicit(&[0]), "one account address; the smallest accepted set, and two hash inputs"),
    (SetSpec::Explicit(&[3]), "one contract address"),
    (SetSpec::Explicit(&[0, 2]), "two addresses that differ only by the type tag; four inputs, the input count of the salt derivation"),
    (SetSpec::Explicit(&[2, 0]), "the two addresses of the previous case in the reverse order; the hash must not change"),
    (SetSpec::Explicit(&[8, 11]), "two addresses that differ only in the last payload byte"),
    (SetSpec::Prefix(3), "three addresses; six inputs, an exact multiple of the sponge rate"),
    (SetSpec::PrefixReversed(3), "the three addresses of the previous case in the reverse order; the hash must not change"),
    (SetSpec::Prefix(4), "four addresses"),
    (SetSpec::Prefix(5), "five addresses"),
    (SetSpec::Prefix(6), "six addresses; twelve inputs, an exact multiple of the sponge rate"),
    (SetSpec::Prefix(8), "eight addresses"),
    (SetSpec::Prefix(15), "fifteen addresses"),
    (SetSpec::Prefix(16), "sixteen addresses; the earlier coordination bound"),
    (SetSpec::Prefix(17), "seventeen addresses; one above the earlier bound"),
    (SetSpec::Prefix(30), "thirty addresses; two below the current bound"),
    (SetSpec::Prefix(31), "thirty-one addresses; one below the current bound"),
    (SetSpec::Prefix(32), "thirty-two addresses; the largest accepted set"),
    (SetSpec::PrefixReversed(32), "the largest set in the reverse order; the hash must not change"),
];

/// The index of the largest reserve set in RESERVE_SETS.
const LARGEST_SET: usize = 16;

/// Authority index, asset index, reserve set index, snapshot ledger, and case.
const CONTEXTS: [(usize, usize, usize, u32, &str); 7] = [
    (0, 1, 0, 0, "the smallest reserve set and ledger zero"),
    (
        1,
        0,
        0,
        0,
        "the authority and the asset exchanged; the hash must change",
    ),
    (
        0,
        0,
        0,
        0,
        "one address as both the authority and the asset",
    ),
    (0, 1, 0, 1, "ledger one"),
    (0, 1, 0, 2_147_483_648, "ledger 2^31, the high bit of a u32"),
    (0, 1, 0, u32::MAX, "the largest u32 ledger"),
    (
        4,
        3,
        LARGEST_SET,
        ATTESTATION_MAX_AGE_LEDGERS,
        "the largest reserve set",
    ),
];

/// Left input, right input, and case of a tree node.
const NODES: [(Fr, Fr, &str); 5] = [
    (Fr::Small(0), Fr::Small(0), "both inputs zero"),
    (Fr::Small(1), Fr::Small(2), "two small inputs"),
    (
        Fr::Small(2),
        Fr::Small(1),
        "the inputs of the previous case exchanged; the node hash is not symmetric",
    ),
    (
        Fr::Small(0),
        Fr::Largest,
        "a zero left input and the largest field element on the right",
    ),
    (
        Fr::Largest,
        Fr::Largest,
        "both inputs at the largest field element",
    ),
];

/// Identifier, balance, salt, and case of a leaf.
const LEAVES: [(Fr, u64, Fr, &str); 12] = [
    (Fr::Small(PADDING_LEAF_ID as u64), PADDING_LEAF_BALANCE, Fr::Small(0), "the padding leaf with a zero salt"),
    (Fr::Small(PADDING_LEAF_ID as u64), PADDING_LEAF_BALANCE, Fr::Small(1), "the padding leaf with a non-zero salt"),
    (Fr::Small(1), 0, Fr::Small(1), "identifier one and a zero balance"),
    (Fr::Small(1), 1, Fr::Small(1), "the smallest non-zero balance"),
    (Fr::Small(1), 4_294_967_295, Fr::Small(1), "a balance at the largest u32"),
    (Fr::Small(1), 4_294_967_296, Fr::Small(1), "a balance one above the largest u32"),
    (Fr::Small(1), 9_007_199_254_740_993, Fr::Small(1), "a balance above 2^53, which a JSON number does not hold exactly"),
    (Fr::Small(1), u64::MAX, Fr::Small(1), "the largest u64 balance"),
    (Fr::Largest, 100, Fr::Small(1), "an identifier at the largest field element"),
    (Fr::Small(7), 100, Fr::Small(2), "a customer leaf"),
    (Fr::Small(7), 100, Fr::Small(3), "the identifier and the balance of the previous case with another salt; the leaf must change"),
    (Fr::Small(7), 100, Fr::Largest, "the largest field element as the salt"),
];

/// Master secret, context index, global leaf index, and case of a salt.
const SALTS: [(Fr, usize, u64, &str); 10] = [
    (Fr::Small(0), 0, 0, "a zero master secret"),
    (Fr::Small(1), 0, 0, "the first leaf position"),
    (Fr::Small(1), 0, 1, "the second leaf position"),
    (
        Fr::Small(1),
        1,
        0,
        "another context at the first position; the salt must change",
    ),
    (Fr::Small(1), 0, 4_294_967_295, "the largest u32 index"),
    (
        Fr::Small(1),
        0,
        4_294_967_296,
        "one above the largest u32 index",
    ),
    (
        Fr::Small(1),
        0,
        9_007_199_254_740_992,
        "index 2^53, the largest integer that a JSON number holds exactly",
    ),
    (
        Fr::Small(1),
        0,
        9_007_199_254_740_993,
        "index 2^53 + 1, which a JSON number does not hold",
    ),
    (Fr::Small(1), 0, u64::MAX, "the largest u64 index"),
    (
        Fr::Largest,
        0,
        0,
        "a master secret at the largest field element",
    ),
];

fn payload_bytes(kind: Payload) -> [u8; ADDRESS_PAYLOAD_BYTES] {
    let mut bytes = [0u8; ADDRESS_PAYLOAD_BYTES];
    match kind {
        Payload::Repeat(value) => bytes = [value; ADDRESS_PAYLOAD_BYTES],
        Payload::OneByte(index, value) => bytes[index] = value,
        Payload::Ramp(base) => {
            for (offset, byte) in bytes.iter_mut().enumerate() {
                *byte = base.wrapping_add(offset as u8);
            }
        }
    }
    bytes
}

/// The address table. The fillers start above the largest first byte that a
/// boundary payload uses, so every payload in the table is distinct.
fn address_cases() -> StdVec<(u32, Payload, String)> {
    let mut cases: StdVec<(u32, Payload, String)> = BOUNDARY_ADDRESSES
        .iter()
        .map(|(tag, kind, case)| (*tag, *kind, String::from(*case)))
        .collect();
    for index in 0..FILLER_ADDRESSES {
        let tag = if index % 2 == 0 {
            ADDRESS_TAG_ACCOUNT
        } else {
            ADDRESS_TAG_CONTRACT
        };
        let base = 0x20u8 + (index as u8) * 3;
        cases.push((tag, Payload::Ramp(base), std::format!("set member {index}")));
    }
    cases
}

fn address(env: &Env, cases: &[(u32, Payload, String)], index: usize) -> Address {
    let (tag, kind, _) = &cases[index];
    let payload = BytesN::from_array(env, &payload_bytes(*kind));
    if *tag == ADDRESS_TAG_ACCOUNT {
        AddressPayload::AccountIdPublicKeyEd25519(payload).to_address(env)
    } else {
        AddressPayload::ContractIdHash(payload).to_address(env)
    }
}

fn members(spec: &SetSpec) -> StdVec<usize> {
    match spec {
        SetSpec::Explicit(list) => list.to_vec(),
        SetSpec::Prefix(count) => (0..*count).collect(),
        SetSpec::PrefixReversed(count) => (0..*count).rev().collect(),
    }
}

fn largest_fr(env: &Env) -> U256 {
    fr_modulus(env).sub(&U256::from_u32(env, 1))
}

fn fr_value(env: &Env, value: Fr) -> U256 {
    match value {
        Fr::Small(number) => U256::from_u128(env, number as u128),
        Fr::Largest => largest_fr(env),
    }
}

fn to_array(value: &U256) -> [u8; FR_BYTES] {
    let bytes: BytesN<32> = value.to_be_bytes().try_into().unwrap();
    bytes.to_array()
}

fn hex_bytes(bytes: &[u8]) -> String {
    let mut text = String::from("0x");
    for byte in bytes {
        text.push_str(&std::format!("{byte:02x}"));
    }
    text
}

fn hex(value: &U256) -> String {
    hex_bytes(&to_array(value))
}

fn join(entries: &[String]) -> String {
    entries.join(",\n    ")
}

fn address_json(env: &Env, cases: &[(u32, Payload, String)], index: usize) -> String {
    let (tag, kind, case) = &cases[index];
    let (hi, lo) = encode_address(env, &address(env, cases, index)).unwrap();
    std::format!(
        "{{\"index\": {index}, \"case\": \"{case}\", \"tag\": {tag}, \"payload\": \"{}\", \
         \"hi\": \"{}\", \"lo\": \"{}\"}}",
        hex_bytes(&payload_bytes(*kind)),
        hex(&hi),
        hex(&lo)
    )
}

/// The inputs and the outputs of the modular reduction of a 32-byte value.
/// A master secret comes from a random source, so its value can reach or pass
/// the modulus.
fn reductions_json(env: &Env) -> StdVec<String> {
    let modulus = fr_modulus(env);
    let one = U256::from_u32(env, 1);
    let cases: [(U256, &str); 6] = [
        (U256::from_u32(env, 0), "zero"),
        (one.clone(), "one"),
        (
            modulus.sub(&one),
            "one below the modulus; the largest field element",
        ),
        (modulus.clone(), "the modulus; the reduction gives zero"),
        (
            modulus.add(&one),
            "one above the modulus; the reduction gives one",
        ),
        (
            U256::from_be_bytes(env, &Bytes::from_array(env, &[0xff; FR_BYTES])),
            "every bit set; the largest 32-byte value",
        ),
    ];
    cases
        .iter()
        .map(|(input, case)| {
            let bytes = to_array(input);
            std::format!(
                "{{\"case\": \"{case}\", \"input\": \"{}\", \"in_range\": {}, \"reduced\": \"{}\"}}",
                hex_bytes(&bytes),
                fr_in_range(env, input),
                hex(&fr_reduce(env, &bytes))
            )
        })
        .collect()
}

fn vectors(env: &Env) -> String {
    let cases = address_cases();
    let addresses: StdVec<String> = (0..cases.len())
        .map(|index| address_json(env, &cases, index))
        .collect();

    let mut set_hashes = StdVec::new();
    let mut sets = StdVec::new();
    for (spec, case) in &RESERVE_SETS {
        let list = members(spec);
        let mut reserves = Vec::new(env);
        for index in &list {
            reserves.push_back(address(env, &cases, *index));
        }
        let hash = reserve_set_hash(env, &reserves).unwrap();
        sets.push(std::format!(
            "{{\"case\": \"{case}\", \"size\": {}, \"addresses\": {list:?}, \
             \"reserve_set_hash\": \"{}\"}}",
            list.len(),
            hex(&hash)
        ));
        set_hashes.push(hash);
    }

    let mut context_hashes = StdVec::new();
    let mut contexts = StdVec::new();
    for (authority, asset, set, ledger, case) in CONTEXTS {
        let hash = context_hash(
            env,
            &address(env, &cases, authority),
            &address(env, &cases, asset),
            &set_hashes[set],
            ledger,
        )
        .unwrap();
        contexts.push(std::format!(
            "{{\"case\": \"{case}\", \"authority\": {authority}, \"asset\": {asset}, \
             \"reserve_set\": {set}, \"snapshot_ledger\": {ledger}, \"context_hash\": \"{}\"}}",
            hex(&hash)
        ));
        context_hashes.push(hash);
    }

    let nodes: StdVec<String> = NODES
        .iter()
        .map(|(left, right, case)| {
            let left = fr_value(env, *left);
            let right = fr_value(env, *right);
            std::format!(
                "{{\"case\": \"{case}\", \"left\": \"{}\", \"right\": \"{}\", \"node\": \"{}\"}}",
                hex(&left),
                hex(&right),
                hex(&node_hash(env, &left, &right))
            )
        })
        .collect();

    let leaves: StdVec<String> = LEAVES
        .iter()
        .map(|(id, balance, salt, case)| {
            let id = fr_value(env, *id);
            let salt = fr_value(env, *salt);
            std::format!(
                "{{\"case\": \"{case}\", \"id\": \"{}\", \"balance\": \"{balance}\", \
                 \"salt\": \"{}\", \"leaf\": \"{}\"}}",
                hex(&id),
                hex(&salt),
                hex(&leaf_hash(env, &id, *balance, &salt))
            )
        })
        .collect();

    let salts: StdVec<String> = SALTS
        .iter()
        .map(|(secret, context, index, case)| {
            let secret = fr_value(env, *secret);
            std::format!(
                "{{\"case\": \"{case}\", \"master_secret\": \"{}\", \"context\": {context}, \
                 \"global_index\": \"{index}\", \"salt\": \"{}\"}}",
                hex(&secret),
                hex(&derive_salt(
                    env,
                    &secret,
                    &context_hashes[*context],
                    *index
                ))
            )
        })
        .collect();

    std::format!(
        "{{\n  \"constants\": {{\n    \"fr_modulus\": \"{}\",\n    \
         \"fr_bytes\": {},\n    \"ctx_domain_tag\": \"{}\",\n    \
         \"salt_domain_tag\": \"{}\",\n    \"poseidon2_state_width\": {},\n    \
         \"max_reserve_addresses\": {},\n    \"attestation_max_age_ledgers\": {},\n    \
         \"address_payload_bytes\": {},\n    \"address_limb_bytes\": {},\n    \
         \"address_tag_account\": {},\n    \"address_tag_contract\": {},\n    \
         \"padding_leaf_id\": {},\n    \"padding_leaf_balance\": \"{}\"\n  }},\n  \
         \"field_reductions\": [\n    {}\n  ],\n  \
         \"addresses\": [\n    {}\n  ],\n  \"reserve_sets\": [\n    {}\n  ],\n  \
         \"contexts\": [\n    {}\n  ],\n  \"nodes\": [\n    {}\n  ],\n  \
         \"leaves\": [\n    {}\n  ],\n  \"salts\": [\n    {}\n  ]\n}}\n",
        hex(&fr_modulus(env)),
        FR_BYTES,
        hex(&ctx_domain_tag(env)),
        hex(&salt_domain_tag(env)),
        POSEIDON2_STATE_WIDTH,
        MAX_RESERVE_ADDRESSES,
        ATTESTATION_MAX_AGE_LEDGERS,
        ADDRESS_PAYLOAD_BYTES,
        ADDRESS_LIMB_BYTES,
        ADDRESS_TAG_ACCOUNT,
        ADDRESS_TAG_CONTRACT,
        PADDING_LEAF_ID,
        PADDING_LEAF_BALANCE,
        join(&reductions_json(env)),
        join(&addresses),
        join(&sets),
        join(&contexts),
        join(&nodes),
        join(&leaves),
        join(&salts)
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

/// The set sizes must cover every remainder of the input count over the sponge
/// rate, at the small end and at the bound, and LARGEST_SET must name the
/// largest set. A later edit of the table would otherwise drop a shape or move
/// the index without a failure.
#[test]
fn the_reserve_set_sizes_cover_the_required_shapes() {
    let sizes: StdVec<usize> = RESERVE_SETS
        .iter()
        .map(|(spec, _)| members(spec).len())
        .collect();
    let bound = MAX_RESERVE_ADDRESSES as usize;
    assert_eq!(sizes[LARGEST_SET], bound);
    for required in [1, 2, 3, bound - 2, bound - 1, bound] {
        assert!(
            sizes.contains(&required),
            "no reserve set holds {required} addresses"
        );
    }
    for size in &sizes {
        assert!(*size >= 1 && *size <= bound);
    }
}

/// The address table must hold enough distinct addresses for the largest set.
/// A repeated payload would make the largest set fail on a duplicate, and a
/// short table would make it fail on an index.
#[test]
fn the_address_table_holds_distinct_addresses_for_the_largest_set() {
    let cases = address_cases();
    assert!(cases.len() >= MAX_RESERVE_ADDRESSES as usize);
    let mut seen: StdVec<(u32, [u8; ADDRESS_PAYLOAD_BYTES])> = StdVec::new();
    for (tag, kind, _) in &cases {
        let parts = (*tag, payload_bytes(*kind));
        assert!(!seen.contains(&parts), "the address table repeats an entry");
        seen.push(parts);
    }
}
