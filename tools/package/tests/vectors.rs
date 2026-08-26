//! Emits the tree and package vectors, and checks the committed file against
//! them.
//!
//! The TypeScript implementation must reproduce every value in the file. Run
//! the test with ZKPOR_UPDATE_VECTORS=1 to write the file again after a
//! deliberate change of an algorithm or of the layout.
//!
//! Two properties need these vectors, and the primitive vectors cannot carry
//! either one. The authentication path walk reads the bits of the leaf index,
//! so a walk with an inverted direction rule or a reversed level order gives
//! the same answer on a tree of one node and another answer on a real tree.
//! The package layout fixes the bytes of a file that one implementation writes
//! and another reads, so the two must agree on the bytes and not only on the
//! values.
//!
//! Every case carries a `case` string, so a failure names the shape that broke.

use num_bigint::BigUint;
use soroban_sdk::{address_payload::AddressPayload, Address, BytesN, Env, U256};
use std::{env as std_env, fs, path::PathBuf};
use zkpor_context::{leaf_hash, ADDRESS_PAYLOAD_BYTES};
use zkpor_package::{
    fr::{fr_hex, to_big, to_fr},
    new_env,
    schema::{
        json_string, package_filename, Package, JSON_INDENT, PACKAGE_EXTENSION, PACKAGE_FORMAT,
        PACKAGE_INDEX_DIGITS,
    },
    tree::{path_in_levels, subtree_root, tree_levels},
};

const VECTOR_FILE: &str = "fixtures/package_vectors.json";
const UPDATE_FLAG: &str = "ZKPOR_UPDATE_VECTORS";

/// The rule that gives the leaf values of a tree. The rule is a statement in
/// the file too, so a reader can rebuild every leaf of a tree that the file
/// does not list.
const LEAF_RULE: &str =
    "the leaf at index i holds id = i + 1, balance = i * 7, and salt = i + 1000";

/// The network name of the vector packages.
const NETWORK: &str = "testnet";
/// The payload of the registry address of the vector packages.
const REGISTRY_PAYLOAD: u8 = 0x11;
/// The payload of the asset address of the vector packages.
const ASSET_PAYLOAD: u8 = 0x22;

/// Depth and sampled leaf indices of each tree.
///
/// The indices at each depth cover an index of only zero bits, an index of
/// only one bits, the lowest bit alone and the highest bit alone. At depth 12
/// they also cover one alternating index and its bit reversal, so a walk that
/// reads the bits in the wrong order reaches the other index's root.
const TREES: [(usize, &[u64], &str); 4] = [
    (
        1,
        &[0, 1],
        "one level; the smallest tree that a path walk can cross",
    ),
    (2, &[0, 1, 2, 3], "two levels; every index of the tree"),
    (3, &[0, 1, 2, 4, 5, 7], "three levels"),
    (
        12,
        &[0, 1, 2, 2048, 4095, 1365, 2730],
        "twelve levels, the depth that the current deployment records; the file lists no leaf, and each path rebuilds the root on its own",
    ),
];

/// The largest depth at which the file lists every leaf. A larger tree holds
/// too many leaves to list, and its paths carry their own leaf instead.
const LISTED_DEPTH: usize = 3;

/// The index into TREES of the tree at the depth of the deployment.
const DEPLOYMENT_TREE: usize = 3;

/// A leaf that a tree holds at a position, when the position must carry
/// another value than the rule gives: tree index, leaf index, and case.
const OVERRIDES: [(usize, u64, &str); 1] = [(
    2,
    7,
    "the largest identifier, the largest balance, and the largest salt",
)];

/// Tree index, leaf index, and case of each package.
const PACKAGES: [(usize, u64, u32, &str); 4] = [
    (
        3,
        0,
        1,
        "the first leaf of the deployment tree; every index bit is zero",
    ),
    (
        3,
        4095,
        u32::MAX,
        "the last leaf of the deployment tree, at the largest snapshot ledger",
    ),
    (
        2,
        7,
        720,
        "a short path, so the layout of the file is readable in one screen",
    ),
    (
        2,
        0,
        0,
        "a short path at ledger zero and the smallest identifier",
    ),
];

fn contract(env: &Env, payload: u8) -> Address {
    AddressPayload::ContractIdHash(BytesN::from_array(env, &[payload; ADDRESS_PAYLOAD_BYTES]))
        .to_address(env)
}

fn strkey(env: &Env, payload: u8) -> String {
    contract(env, payload).to_string().to_string()
}

/// The identifier, the balance, and the salt of one leaf.
fn leaf_parts(env: &Env, tree: usize, index: u64) -> (BigUint, u64, BigUint) {
    if OVERRIDES.iter().any(|(t, i, _)| *t == tree && *i == index) {
        let largest = to_big(&zkpor_context::fr_modulus(env)) - 1u32;
        return (largest.clone(), u64::MAX, largest);
    }
    (
        BigUint::from(index + 1),
        index * 7,
        BigUint::from(index + 1000),
    )
}

fn leaf_value(env: &Env, tree: usize, index: u64) -> U256 {
    let (id, balance, salt) = leaf_parts(env, tree, index);
    leaf_hash(env, &to_fr(env, &id), balance, &to_fr(env, &salt))
}

fn leaves_of(env: &Env, tree: usize, depth: usize) -> Vec<U256> {
    (0..1u64 << depth)
        .map(|index| leaf_value(env, tree, index))
        .collect()
}

fn leaf_json(env: &Env, tree: usize, index: u64) -> String {
    let (id, balance, salt) = leaf_parts(env, tree, index);
    format!(
        "\"leaf_index\": {index}, \"id\": \"{}\", \"balance\": \"{balance}\", \
         \"salt\": \"{}\", \"leaf\": \"{}\"",
        fr_hex(&id),
        fr_hex(&salt),
        fr_hex(&to_big(&leaf_value(env, tree, index)))
    )
}

fn siblings_json(siblings: &[U256]) -> String {
    let texts: Vec<String> = siblings
        .iter()
        .map(|sibling| format!("\"{}\"", fr_hex(&to_big(sibling))))
        .collect();
    format!("[{}]", texts.join(", "))
}

fn override_case(tree: usize, index: u64) -> Option<&'static str> {
    OVERRIDES
        .iter()
        .find(|(t, i, _)| *t == tree && *i == index)
        .map(|(_, _, case)| *case)
}

fn tree_json(env: &Env, tree: usize) -> (String, U256, Vec<Vec<U256>>) {
    let (depth, sampled, case) = TREES[tree];
    let levels = tree_levels(env, &leaves_of(env, tree, depth));
    let root = subtree_root(env, &levels[0]);

    let listed = if depth <= LISTED_DEPTH {
        let entries: Vec<String> = (0..1u64 << depth)
            .map(|index| {
                let note = override_case(tree, index).unwrap_or("the rule gives every value");
                format!(
                    "\n      {{\"case\": \"{note}\", {}}}",
                    leaf_json(env, tree, index)
                )
            })
            .collect();
        format!(",\n    \"leaves\": [{}\n    ]", entries.join(","))
    } else {
        String::new()
    };

    let paths: Vec<String> = sampled
        .iter()
        .map(|index| {
            let siblings = path_in_levels(&levels, *index as usize);
            let bits: String = (0..depth)
                .rev()
                .map(|bit| if (index >> bit) & 1 == 1 { '1' } else { '0' })
                .collect();
            format!(
                "\n      {{\"case\": \"index bits {bits}, read from the highest bit\", {}, \
                 \"siblings\": {}}}",
                leaf_json(env, tree, *index),
                siblings_json(&siblings)
            )
        })
        .collect();

    let json = format!(
        "{{\"case\": \"{case}\", \"depth\": {depth}, \"root\": \"{}\"{listed},\n    \
         \"paths\": [{}\n    ]\n  }}",
        fr_hex(&to_big(&root)),
        paths.join(",")
    );
    (json, root, levels)
}

fn package_json(
    env: &Env,
    levels: &[Vec<U256>],
    tree: usize,
    index: u64,
    ledger: u32,
    case: &str,
) -> String {
    let (id, balance, salt) = leaf_parts(env, tree, index);
    let package = Package {
        network: NETWORK.to_string(),
        registry: strkey(env, REGISTRY_PAYLOAD),
        asset: strkey(env, ASSET_PAYLOAD),
        snapshot_ledger: ledger,
        leaf_index: index as u32,
        id,
        balance,
        salt,
        siblings: path_in_levels(levels, index as usize)
            .iter()
            .map(to_big)
            .collect(),
    };
    let text = package.to_json();
    let lines: Vec<String> = text
        .strip_suffix('\n')
        .expect("the file ends with one line feed")
        .lines()
        .map(|line| format!("\n      {}", json_string(line)))
        .collect();
    format!(
        "{{\"case\": \"{case}\", \"tree\": {tree}, \"filename\": {},\n    \"lines\": [{}\n    ]\n  }}",
        json_string(&package_filename(index as u32)),
        lines.join(",")
    )
}

fn vectors(env: &Env) -> String {
    let mut trees = Vec::new();
    let mut all_levels = Vec::new();
    for tree in 0..TREES.len() {
        let (json, _, levels) = tree_json(env, tree);
        trees.push(json);
        all_levels.push(levels);
    }

    let packages: Vec<String> = PACKAGES
        .iter()
        .map(|(tree, index, ledger, case)| {
            package_json(env, &all_levels[*tree], *tree, *index, *ledger, case)
        })
        .collect();

    format!(
        "{{\n  \"constants\": {{\n    \"package_format\": {},\n    \
         \"package_extension\": {},\n    \"json_indent\": {},\n    \
         \"package_index_digits\": {}\n  }},\n  \
         \"leaf_rule\": {},\n  \
         \"file_rule\": {},\n  \
         \"trees\": [\n  {}\n  ],\n  \"packages\": [\n  {}\n  ]\n}}\n",
        json_string(PACKAGE_FORMAT),
        json_string(PACKAGE_EXTENSION),
        JSON_INDENT,
        PACKAGE_INDEX_DIGITS,
        json_string(LEAF_RULE),
        json_string(
            "the package file equals the lines joined by one line feed, and one line feed at the end"
        ),
        trees.join(",\n  "),
        packages.join(",\n  ")
    )
}

fn vector_path() -> PathBuf {
    PathBuf::from(std_env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(VECTOR_FILE)
}

#[test]
fn the_committed_vectors_match_this_implementation() {
    let env = new_env();
    let produced = vectors(&env);
    let path = vector_path();

    if std_env::var(UPDATE_FLAG).is_ok() {
        fs::create_dir_all(path.parent().expect("the fixtures directory")).expect("the directory");
        fs::write(&path, &produced).expect("the file");
        return;
    }

    let committed = fs::read_to_string(&path)
        .unwrap_or_else(|_| panic!("{VECTOR_FILE} is missing; run the test with {UPDATE_FLAG}=1"));
    assert_eq!(
        committed, produced,
        "{VECTOR_FILE} does not match this implementation"
    );
}

/// The sampled indices must cover an index of only zero bits, an index of only
/// one bits, the lowest bit alone and the highest bit alone. A walk with an
/// inverted direction rule survives any smaller sample.
#[test]
fn the_sampled_indices_cover_the_bit_positions() {
    for (depth, sampled, _) in TREES {
        let capacity = 1u64 << depth;
        for required in [0, 1, capacity - 1, capacity / 2] {
            assert!(
                sampled.contains(&required),
                "the tree of depth {depth} does not sample the index {required}"
            );
        }
        for index in sampled {
            assert!(*index < capacity);
        }
    }
}

/// One tree must stand at the depth that the deployments file records, so the
/// vectors check the walk at the length the customer flow uses.
#[test]
fn one_tree_stands_at_the_recorded_deployment_depth() {
    let text = fs::read_to_string(
        PathBuf::from(std_env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join("scripts/deployments.json"),
    )
    .expect("the deployments file");
    let records: serde_json::Value = serde_json::from_str(&text).expect("the deployments JSON");
    let recorded = records
        .as_array()
        .expect("an array of records")
        .iter()
        .map(|record| record["tree_depth"].as_u64().expect("a tree depth") as usize)
        .max()
        .expect("at least one record");
    assert_eq!(TREES[DEPLOYMENT_TREE].0, recorded);
}
