//! Off-circuit driver for the recursive-aggregation circuits (inner + agg).
//!
//! Three subcommands split the work around the bb proving step. Two more read
//! the same tree again for the customers: one prints a single path, and one
//! writes the customer files after the attestation lands.
//!
//!   witness   Reads params.toml, the attestation context, and a customer
//!             file, pads the customer list to the tree capacity, derives one
//!             salt per leaf, computes each batch's Poseidon2 subroot and u128
//!             subtotal, and writes
//!               - common/src/params.nr       (BATCH_B)
//!               - inner/Prover_<k>.toml      (one per batch)
//!
//!   path      Rebuilds the same tree from the same two files and prints the
//!             authentication path of one customer: the global leaf index and
//!             one sibling hash for each level, from the leaf level upward.
//!             The direction of each step comes from the index, so the path
//!             holds no direction bit.
//!
//!   packages  Run AFTER the attestation transaction is confirmed. Writes one
//!             inclusion package for each customer row, and one bookkeeping
//!             record beside them. This tool has no network access: the caller
//!             reads the registry entry and passes the attested root and the
//!             attested snapshot. Nothing reaches the disk until the
//!             recomputed root equals the attested one, because a package
//!             holds a balance.
//!
//!   assemble  Run AFTER bb has proven every inner batch. Reads the bb field
//!             outputs (out/vk_fields.json + out/batch_<k>/*_fields.json) and
//!             the compiled inner program, then writes
//!               - agg/src/params.nr          (K + the inner public input
//!                                             layout + the pinned inner-vk
//!                                             hash)
//!               - agg/Prover.toml            (context_hash, vk, K proofs+pubs)
//!
//!   manifest  Run AFTER the aggregator is compiled and its key is written. It
//!             records the shape, both key hashes, and the public input schema
//!             of the release artifact, and it writes the two constants that
//!             the registry contract compiles in. It refuses every other
//!             shape, and the deploy path needs the file, so a development
//!             artifact cannot reach a contract.
//!
//! The positions of (batch_slot, subroot, subtotal) inside the vector that bb
//! emits come from the compiled program's ABI, and never from a search by
//! value. Two public inputs can hold one value, so a search by value can find
//! the wrong position.
//!
//! The master secret arrives in ZKPOR_MASTER_SECRET, and never in a file of
//! this repository. It never enters a circuit witness.
//!
//! Every hash comes from zkpor-context, which is the one Rust definition of
//! the leaf, the node, the salt, and the context hash.

use num_bigint::BigUint;
use soroban_poseidon::Field;
use soroban_sdk::{
    crypto::BnScalar, Address, Bytes, Env, String as SorobanString, Vec as SorobanVec, U256,
};
use std::{
    collections::{HashMap, HashSet},
    env, fs,
    io::Write,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::Path,
    path::PathBuf,
    process::Command,
};
use zkpor_context::{
    context_hash, derive_salt, fr_modulus, fr_reduce, leaf_hash, node_hash, reserve_set_hash,
    FR_BYTES, PADDING_LEAF_BALANCE, PADDING_LEAF_ID,
};

/// The generated record of the release artifact.
const MANIFEST_FILE: &str = "circuits/recursion/manifest.json";
/// The committed aggregator verification key. The tooling writes it and no
/// person edits it. A deployment must carry these bytes.
const AGG_KEY_FILE: &str = "circuits/recursion/agg/vk";
/// The generated constants of the registry contract. The registry compares the
/// key that a verifier stores against these bytes at its own deployment, so
/// they come from the built artifact and never from a person.
const REGISTRY_PARAMS_FILE: &str = "contracts/registry/src/params.rs";
/// The pinned toolchain.
const VERSIONS_FILE: &str = "scripts/versions.env";
/// Scratch directory for the key that the manifest command writes again to
/// compare with the key on disk. It never survives a run.
const KEY_CHECK_DIR: &str = "circuits/recursion/.key-check";
/// Name of the environment variable that carries the master secret.
const MASTER_SECRET_VAR: &str = "ZKPOR_MASTER_SECRET";
/// Names of the three public inputs of the inner circuit, in the order that
/// agg/src/params.nr records their positions.
const INNER_PUBLIC_INPUTS: [&str; 3] = ["batch_slot", "subroot", "subtotal"];
/// The committed record of the deployment generations, in order. A package
/// names a registry, and that pointer comes from the file every client trusts.
const DEPLOYMENTS_FILE: &str = "scripts/deployments.json";
/// The version gate of the package schema. A reader that does not know this
/// exact string refuses to read any other field.
const PACKAGE_FORMAT: &str = "zkpor-inclusion/1";
/// Extension of a package file.
const PACKAGE_EXTENSION: &str = "zkpor.json";
/// Digits of the zero-padded leaf index in a package filename.
const PACKAGE_INDEX_DIGITS: usize = 6;
/// The authority-side record of one generation run. It holds the root, so it
/// is bookkeeping and it reaches no customer.
const GENERATION_FILE: &str = "generation.json";
/// Mode of every directory that the generation step creates, and of every file
/// it writes. A package holds one customer's balance.
const PACKAGE_DIR_MODE: u32 = 0o700;
const PACKAGE_FILE_MODE: u32 = 0o600;
/// Indentation of the package layout, in spaces.
const JSON_INDENT: usize = 2;

// Resolve a path relative to the repo root. CARGO_MANIFEST_DIR is
// <repo>/tools/recursion-gen, so ../.. is the repo root and `rel` is taken
// from there (e.g. circuits/recursion/...).
fn repo_path(rel: &str) -> PathBuf {
    fs::canonicalize(Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."))
        .expect("the repository root")
        .join(rel)
}

/// Key and value text of every assignment in a simple TOML file. A comment and
/// a blank line are dropped. The value keeps its quotes and its brackets.
fn read_pairs(path: &Path) -> HashMap<String, String> {
    let mut m = HashMap::new();
    let text = fs::read_to_string(path).unwrap_or_else(|_| panic!("read {}", path.display()));
    for line in text.lines() {
        let line = line.split('#').next().unwrap_or("").trim();
        if let Some((k, v)) = line.split_once('=') {
            m.insert(k.trim().to_string(), v.trim().to_string());
        }
    }
    m
}

fn u64_value(pairs: &HashMap<String, String>, key: &str) -> u64 {
    pairs
        .get(key)
        .unwrap_or_else(|| panic!("missing {key}"))
        .parse()
        .unwrap_or_else(|_| panic!("{key} must be an unsigned integer"))
}

fn text_value(pairs: &HashMap<String, String>, key: &str) -> String {
    pairs
        .get(key)
        .unwrap_or_else(|| panic!("missing {key}"))
        .trim_matches('"')
        .to_string()
}

fn list_value(pairs: &HashMap<String, String>, key: &str) -> Vec<String> {
    pairs
        .get(key)
        .unwrap_or_else(|| panic!("missing {key}"))
        .trim_matches(|c| c == '[' || c == ']')
        .split(',')
        .map(|item| item.trim().trim_matches('"').to_string())
        .filter(|item| !item.is_empty())
        .collect()
}

/// Rejects a liability list that breaks an identifier rule.
///
/// An identifier must be a field element, must not be zero, and must not
/// appear twice. Zero is the padding identifier, so a zero row would produce
/// the exact padding leaf of its position. A repeated identifier would let the
/// authority split one liability across two leaves that each show a partial
/// balance, and the total would still reconcile.
///
/// The circuits cannot enforce either rule. An inner circuit sees one batch,
/// so it cannot see a repeated identifier in another batch.
fn assert_identifier_rules(env: &Env, rows: &[(BigUint, u64)]) {
    let padding = BigUint::from(PADDING_LEAF_ID);
    let modulus = to_big(&fr_modulus(env));
    let mut seen: HashSet<BigUint> = HashSet::with_capacity(rows.len());
    for (row, (id, _)) in rows.iter().enumerate() {
        assert!(
            *id != padding,
            "row {row} carries identifier {id}, and a customer identifier must not be zero"
        );
        assert!(
            *id < modulus,
            "row {row} carries identifier {id}, which is not below the field modulus"
        );
        assert!(
            seen.insert(id.clone()),
            "row {row} repeats identifier {id}, and an identifier appears once"
        );
    }
}

/// (id, balance) rows from a customer file. A comment line and the header line
/// are dropped.
///
/// Every command that builds the tree reads the list here, and the identifier
/// rules run before the reader returns. An invalid list therefore never
/// becomes a tree: a tree that a wrong list builds is already wrong, and an
/// attestation over it can leave a customer without a provable leaf.
fn read_customers(env: &Env, path: &Path) -> Vec<(BigUint, u64)> {
    let mut rows = Vec::new();
    let text = fs::read_to_string(path).unwrap_or_else(|_| panic!("read {}", path.display()));
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with("id,") {
            continue;
        }
        let (id, bal) = line.split_once(',').expect("id,balance");
        let id = id
            .trim()
            .parse::<BigUint>()
            .expect("id is a non-negative integer");
        let bal = bal.trim().parse::<u64>().expect("balance is u64");
        rows.push((id, bal));
    }
    assert_identifier_rules(env, &rows);
    rows
}

/// Fills the customer list up to the tree capacity with padding leaves.
///
/// A padding leaf carries the defined identifier and balance, and it later
/// takes a real derived salt, so it is indistinguishable from a customer leaf
/// and the tree does not reveal the customer count.
fn pad_to_capacity(mut rows: Vec<(BigUint, u64)>, capacity: usize) -> Vec<(BigUint, u64)> {
    assert!(
        rows.len() <= capacity,
        "the customer file holds {} rows and the tree holds {capacity}; \
         raise batch_b or num_batches_k. The generator does not cut the list, \
         because a cut removes liabilities from the total",
        rows.len()
    );
    while rows.len() < capacity {
        rows.push((BigUint::from(PADDING_LEAF_ID), PADDING_LEAF_BALANCE));
    }
    rows
}

fn be32(x: &BigUint) -> [u8; FR_BYTES] {
    let be = x.to_bytes_be();
    assert!(
        be.len() <= FR_BYTES,
        "value does not fit in a field element"
    );
    let mut out = [0u8; FR_BYTES];
    out[FR_BYTES - be.len()..].copy_from_slice(&be);
    out
}

fn to_fr(env: &Env, x: &BigUint) -> U256 {
    let value = U256::from_be_bytes(env, &Bytes::from_array(env, &be32(x)));
    assert!(
        value < <BnScalar as Field>::modulus(env),
        "value is not below the field modulus"
    );
    value
}

fn to_big(value: &U256) -> BigUint {
    let mut bytes = [0u8; FR_BYTES];
    value.to_be_bytes().copy_into_slice(&mut bytes);
    BigUint::from_bytes_be(&bytes)
}

/// One step of the bottom-up fold: each adjacent pair becomes its parent.
fn fold_level(env: &Env, level: &[U256]) -> Vec<U256> {
    (0..level.len() / 2)
        .map(|k| node_hash(env, &level[2 * k], &level[2 * k + 1]))
        .collect()
}

/// Root of a full binary tree over `leaves` (len a power of two, >= 2).
/// Pairwise bottom-up; identical pairing order to common/lib.nr subtree_root.
fn subtree_root(env: &Env, leaves: &[U256]) -> U256 {
    let mut level: Vec<U256> = leaves.to_vec();
    while level.len() > 1 {
        level = fold_level(env, &level);
    }
    level.into_iter().next().expect("non-empty tree")
}

/// The root that the two circuit stages produce: each inner circuit folds one
/// batch of `batch_size` leaves, and the aggregator folds the batch subroots
/// with the same node hash.
///
/// The two stages give the root of one uniform tree over every leaf, so a
/// customer follows a single path and never needs to know where a batch
/// boundary is.
fn folded_root(env: &Env, leaves: &[U256], batch_size: usize) -> U256 {
    let subroots: Vec<U256> = leaves
        .chunks(batch_size)
        .map(|batch| subtree_root(env, batch))
        .collect();
    subtree_root(env, &subroots)
}

/// Every level of the tree, from the leaves up to the root. A caller that
/// needs more than one path folds the tree once and reads each path from here.
fn tree_levels(env: &Env, leaves: &[U256]) -> Vec<Vec<U256>> {
    let mut levels = std::vec![leaves.to_vec()];
    while levels.last().expect("the leaf level").len() > 1 {
        levels.push(fold_level(env, levels.last().expect("the level below")));
    }
    levels
}

/// The sibling hashes of one leaf, from the leaf level up to the level below
/// the root.
///
/// The path holds no direction bit. The bit of the index at each level states
/// whether the current node is the left input or the right input, so no stored
/// bit can disagree with the index.
fn path_in_levels(levels: &[Vec<U256>], global_index: usize) -> Vec<U256> {
    let leaf_count = levels.first().expect("the leaf level").len();
    assert!(
        global_index < leaf_count,
        "leaf index {global_index} is outside a tree of {leaf_count} leaves"
    );
    let mut index = global_index;
    let mut siblings = Vec::new();
    for level in &levels[..levels.len() - 1] {
        siblings.push(level[index ^ 1].clone());
        index >>= 1;
    }
    siblings
}

/// Recomputes the root from one leaf and its authentication path.
///
/// `depth` comes from the tree shape, which is public. A path of another
/// length fails here, so a short path cannot produce a value that looks like a
/// root.
fn root_from_path(
    env: &Env,
    leaf: &U256,
    global_index: usize,
    siblings: &[U256],
    depth: usize,
) -> U256 {
    assert_eq!(
        siblings.len(),
        depth,
        "the path does not hold one sibling for each of the {depth} levels"
    );
    assert!(
        global_index < (1usize << depth),
        "leaf index {global_index} is outside a tree of depth {depth}"
    );
    let mut node = leaf.clone();
    for (level, sibling) in siblings.iter().enumerate() {
        node = if (global_index >> level) & 1 == 0 {
            node_hash(env, &node, sibling)
        } else {
            node_hash(env, sibling, &node)
        };
    }
    node
}

fn fmt_field_array(values: &[BigUint]) -> String {
    let items: Vec<String> = values.iter().map(|v| format!("\"{v}\"")).collect();
    format!("[{}]", items.join(", "))
}

fn new_env() -> Env {
    let env = Env::default();
    env.cost_estimate().budget().reset_unlimited();
    env
}

fn address(env: &Env, strkey: &str) -> Address {
    Address::from_string(&SorobanString::from_str(env, strkey))
}

/// The attestation context of one context file.
///
/// The hash binds the proof to one authority, one asset, one reserve address
/// set, and one snapshot. The asset and the snapshot travel with it, because
/// a package names both and the tree that the snapshot shaped must be the
/// tree that the chain attested.
struct AttestationContext {
    hash: U256,
    asset: String,
    snapshot_ledger: u32,
}

fn read_context(env: &Env, path: &Path) -> AttestationContext {
    let pairs = read_pairs(path);
    let mut reserves = SorobanVec::new(env);
    for strkey in list_value(&pairs, "reserves") {
        reserves.push_back(address(env, &strkey));
    }
    let set = reserve_set_hash(env, &reserves).expect("the reserve set is not valid");
    let snapshot_ledger = u64_value(&pairs, "snapshot_ledger");
    let snapshot_ledger = u32::try_from(snapshot_ledger).expect("snapshot_ledger is a u32");
    let asset = text_value(&pairs, "asset");
    let hash = context_hash(
        env,
        &address(env, &text_value(&pairs, "authority")),
        &address(env, &asset),
        &set,
        snapshot_ledger,
    )
    .expect("the context addresses are not valid");
    AttestationContext {
        hash,
        asset,
        snapshot_ledger,
    }
}

/// The master secret that seeds every salt.
///
/// It arrives in the environment, so it never sits in a file of this
/// repository, and only the step that derives the salts asks for it.
fn read_master_secret(env: &Env) -> U256 {
    let raw = env::var(MASTER_SECRET_VAR)
        .unwrap_or_else(|_| panic!("set {MASTER_SECRET_VAR} to 32 bytes of hex"));
    let raw = raw.trim();
    let raw = raw.strip_prefix("0x").unwrap_or(raw);
    fr_reduce(env, &hex_bytes(MASTER_SECRET_VAR, raw))
}

fn hex_bytes(label: &str, text: &str) -> [u8; FR_BYTES] {
    assert_eq!(
        text.len(),
        FR_BYTES * 2,
        "{label} must be {FR_BYTES} bytes of hex"
    );
    let mut out = [0u8; FR_BYTES];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&text[2 * i..2 * i + 2], 16)
            .unwrap_or_else(|_| panic!("{label} is not hex"));
    }
    out
}

/// The names of the public inputs of a compiled Noir program, in the order
/// that the prover emits them: the public parameters in declaration order,
/// then the public return value.
///
/// This replaces a search by value. Two public inputs can hold one value, so a
/// search by value can find the wrong position.
fn public_input_layout(program: &Path) -> Vec<String> {
    let text = fs::read_to_string(program)
        .unwrap_or_else(|_| panic!("read {}; compile the circuit first", program.display()));
    let json: serde_json::Value = serde_json::from_str(&text).expect("compiled program is JSON");
    let abi = &json["abi"];

    let mut names = Vec::new();
    let parameters = abi["parameters"]
        .as_array()
        .expect("abi.parameters is a list");
    for parameter in parameters {
        if parameter["visibility"] != "public" {
            continue;
        }
        let name = parameter["name"].as_str().expect("a parameter has a name");
        assert_eq!(
            parameter["type"]["kind"], "field",
            "public parameter {name} is not one field element"
        );
        names.push(name.to_string());
    }

    let ret = &abi["return_type"];
    if !ret.is_null() {
        assert_eq!(
            ret["visibility"], "public",
            "a private return value is not supported"
        );
        let kind = &ret["abi_type"]["kind"];
        if kind == "field" {
            names.push("return".to_string());
        } else if kind == "tuple" {
            let fields = ret["abi_type"]["fields"].as_array().expect("tuple fields");
            for (i, field) in fields.iter().enumerate() {
                assert_eq!(
                    field["kind"], "field",
                    "return value {i} is not one field element"
                );
                names.push(format!("return.{i}"));
            }
        } else {
            panic!("return kind {kind} is not supported");
        }
    }
    names
}

/// The outer array length of one private parameter of a compiled program.
///
/// The shape of the artifact comes from the artifact itself, so a stale build
/// output cannot be described as a current one.
fn parameter_array_length(program: &Path, name: &str) -> usize {
    let text = fs::read_to_string(program)
        .unwrap_or_else(|_| panic!("read {}; compile the circuit first", program.display()));
    let json: serde_json::Value = serde_json::from_str(&text).expect("compiled program is JSON");
    let parameters = json["abi"]["parameters"]
        .as_array()
        .expect("abi.parameters is a list");
    let parameter = parameters
        .iter()
        .find(|p| p["name"] == name)
        .unwrap_or_else(|| panic!("the compiled program has no parameter {name}"));
    parameter["type"]["length"]
        .as_u64()
        .unwrap_or_else(|| panic!("parameter {name} is not an array")) as usize
}

/// Runs a command from the repository root and returns its output.
///
/// bb runs in a container on some hosts, and that container mounts the working
/// directory, so every path must sit under the repository root.
fn run(program: &str, args: &[&str]) -> std::process::Output {
    let output = Command::new(program)
        .args(args)
        .current_dir(repo_path("."))
        .output()
        .unwrap_or_else(|_| panic!("run {program}; is it on PATH?"));
    assert!(
        output.status.success(),
        "{program} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    output
}

/// The first line of a command's output.
fn first_line(program: &str, args: &[&str]) -> String {
    let output = run(program, args);
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .next()
        .unwrap_or_default()
        .trim()
        .to_string()
}

/// Writes the key of a compiled program again and fails when the result differs
/// from the key on disk.
///
/// This ties a key to its program by content. A modification time does not: a
/// stale key that someone touched would pass, and that is the failure this
/// check exists to stop.
fn assert_key_matches_program(
    program: &Path,
    key_dir: &Path,
    scheme: &str,
    oracle_hash: &str,
    recursive: bool,
) {
    let scratch = repo_path(KEY_CHECK_DIR);
    let _ = fs::remove_dir_all(&scratch);
    fs::create_dir_all(&scratch).expect("create the scratch directory");
    let scratch_arg = scratch.to_string_lossy().to_string();
    // bb runs from the repository root, so a path that the caller gave
    // relative to another directory must become absolute first.
    let program_arg = fs::canonicalize(program)
        .unwrap_or_else(|_| panic!("read {}", program.display()))
        .to_string_lossy()
        .to_string();
    let mut args = std::vec![
        "write_vk",
        "--scheme",
        scheme,
        "--oracle_hash",
        oracle_hash,
        "--bytecode_path",
        &program_arg,
        "--output_path",
        &scratch_arg,
        "--output_format",
        "bytes_and_fields",
    ];
    if recursive {
        args.extend_from_slice(&["--honk_recursion", "1", "--verifier_type", "standalone"]);
    }
    run("bb", &args);

    // Read both files, then remove the scratch directory before the comparison,
    // so a mismatch leaves nothing behind. A read that fails, or a signal,
    // still leaves the directory, which git ignores.
    let pairs: Vec<(&str, Vec<u8>, Vec<u8>)> = ["vk", "vk_fields.json"]
        .iter()
        .map(|name| {
            let produced = fs::read(scratch.join(name)).expect("read the produced key");
            let stored = fs::read(key_dir.join(name))
                .unwrap_or_else(|_| panic!("read {}", key_dir.join(name).display()));
            (*name, produced, stored)
        })
        .collect();
    fs::remove_dir_all(&scratch).expect("remove the scratch directory");

    for (name, produced, stored) in pairs {
        assert!(
            produced == stored,
            "{} does not come from {}; rebuild before you describe the artifact",
            key_dir.join(name).display(),
            program.display()
        );
    }
}

/// The version that a tool reports, which can differ from the pin when another
/// copy of the tool sits earlier on PATH.
fn assert_tool_version(tool: &str, reported: &str, pinned: &str) {
    assert_eq!(
        reported, pinned,
        "{tool} reports {reported}, and the pin is {pinned}; \
         the manifest must not record a version that did not build the artifact"
    );
}

/// The position of one public input. It fails when the name is absent or when
/// the layout holds it more than once.
fn position_of(layout: &[String], name: &str) -> usize {
    let found: Vec<usize> = layout
        .iter()
        .enumerate()
        .filter(|(_, n)| *n == name)
        .map(|(i, _)| i)
        .collect();
    assert_eq!(
        found.len(),
        1,
        "the public input layout does not hold {name} exactly once"
    );
    found[0]
}

/// The release configuration. An artifact of another shape looks the same but
/// proves nothing about the release artifact, so the pin path and the manifest
/// refuse to produce one.
///
/// These two values repeat params.toml on purpose, and neither one is a
/// configuration value here. params.toml states the shape that the tooling
/// builds, and these state the only shape that may become a release. The two
/// meet in one comparison that fails loudly, so an edit of params.toml alone
/// cannot turn a development shape into a release. Do not delete them as a
/// duplicate.
const RELEASE_BATCH_B: usize = 1024;
const RELEASE_NUM_BATCHES_K: usize = 4;
/// Set this variable to build an artifact of another shape while you work. No
/// manifest is written then, and the deploy path needs the manifest, so a
/// development artifact cannot reach a contract.
const DEVELOPMENT_VAR: &str = "ZKPOR_DEVELOPMENT_ARTIFACT";

/// The public inputs of the terminal proof, in the order that the protocol
/// fixes, with the name that the compiled ABI gives each one.
const OUTER_PUBLIC_INPUTS: [(&str, &str); 4] = [
    ("context_hash", "context_hash"),
    ("inner_key_hash", "return.0"),
    ("final_root", "return.1"),
    ("L", "return.2"),
];
/// The verifier appends the limbs of the pairing point accumulator itself, so
/// the key counts them and the public input byte string does not carry them.
const PAIRING_POINT_LIMBS: usize = 16;
/// Position of the public input count inside the field vector of an UltraHonk
/// verification key. Read from the bb 0.87.0 output of the aggregator key.
const VK_PUBLIC_INPUTS_SIZE_INDEX: usize = 1;

fn is_release(b: usize, k: usize) -> bool {
    b == RELEASE_BATCH_B && k == RELEASE_NUM_BATCHES_K
}

fn describe_release() -> String {
    format!("batch_b = {RELEASE_BATCH_B} and num_batches_k = {RELEASE_NUM_BATCHES_K}")
}

/// B, K, and the tree capacity from params.toml.
fn read_shape() -> (usize, usize, usize) {
    let cfg = read_pairs(&repo_path("circuits/recursion/params.toml"));
    let b = u64_value(&cfg, "batch_b") as usize;
    let k = u64_value(&cfg, "num_batches_k") as usize;
    let arity = u64_value(&cfg, "node_hash_arity") as usize;
    assert_eq!(arity, 2, "only binary (arity 2) Poseidon2 is supported");
    assert!(
        b >= 2 && b.is_power_of_two(),
        "batch_b must be a power of two >= 2"
    );
    assert!(
        k >= 2 && k.is_power_of_two(),
        "num_batches_k must be a power of two >= 2"
    );
    (b, k, b * k)
}

/// The salt and the leaf hash of one row at its global index.
fn leaf_of_row(
    env: &Env,
    master_secret: &U256,
    context: &U256,
    row: &(BigUint, u64),
    global_index: usize,
) -> (U256, U256) {
    let (id, balance) = row;
    let salt = derive_salt(env, master_secret, context, global_index as u64);
    let leaf = leaf_hash(env, &to_fr(env, id), *balance, &salt);
    (salt, leaf)
}

fn cmd_witness(context_file: &Path, customers_file: &Path) {
    let (b, k, capacity) = read_shape();
    let env = new_env();
    let context = read_context(&env, context_file).hash;
    let master_secret = read_master_secret(&env);
    let rows = pad_to_capacity(read_customers(&env, customers_file), capacity);

    fs::write(
        repo_path("circuits/recursion/common/src/params.nr"),
        format!(
            "// Generated from params.toml by tools/recursion-gen. Do not edit by hand.\n\
             pub global BATCH_B: u32 = {b};\n"
        ),
    )
    .expect("write common/src/params.nr");

    for batch in 0..k {
        let mut ids = Vec::with_capacity(b);
        let mut balances = Vec::with_capacity(b);
        let mut salts = Vec::with_capacity(b);
        let mut leaves = Vec::with_capacity(b);
        let mut sum: u128 = 0;
        for j in 0..b {
            let global_index = batch * b + j;
            let row = &rows[global_index];
            let (id, balance) = row;
            let (salt, leaf) = leaf_of_row(&env, &master_secret, &context, row, global_index);
            leaves.push(leaf);
            ids.push(id.clone());
            balances.push(*balance);
            salts.push(to_big(&salt));
            sum += *balance as u128;
        }
        let balance_items: Vec<String> = balances.iter().map(|v| format!("\"{v}\"")).collect();
        let toml = format!(
            "batch_slot = \"{batch}\"\nsubroot = \"{}\"\nsubtotal = \"{sum}\"\n\
             ids = {}\nbalances = [{}]\nsalts = {}\n",
            to_big(&subtree_root(&env, &leaves)),
            fmt_field_array(&ids),
            balance_items.join(", "),
            fmt_field_array(&salts),
        );
        fs::write(
            repo_path(&format!("circuits/recursion/inner/Prover_{batch}.toml")),
            toml,
        )
        .expect("write inner Prover_<k>.toml");
    }
    println!("witness: B={b} K={k} -> common/src/params.nr + {k} inner Prover_<k>.toml");
}

/// The global leaf index of one customer identifier: the position of the row
/// in the frozen list, counted from zero.
///
/// The reader already rejected a zero identifier and a repeated identifier, so
/// only an absent identifier fails here.
fn index_of_customer(rows: &[(BigUint, u64)], id: &BigUint) -> usize {
    rows.iter()
        .position(|(row_id, _)| row_id == id)
        .unwrap_or_else(|| panic!("the customer file holds no row with identifier {id}"))
}

/// The leaves that the path command checks against the fold: the first leaf,
/// the two leaves on the sides of the first batch boundary, the last customer
/// row, and the leaf that the caller asked for. An index error shows at an
/// edge, so the check reads the edges rather than arbitrary positions.
fn self_check_indices(batch_size: usize, customer_count: usize, requested: usize) -> Vec<usize> {
    let mut indices = std::vec![0, batch_size - 1, batch_size, customer_count - 1, requested];
    indices.sort_unstable();
    indices.dedup();
    indices
}

/// Prints the authentication path of one customer.
///
/// The command rebuilds the same tree from the same two files as the witness
/// command, so the path it prints belongs to the root that the proof carries.
/// It recomputes the root from the path it produced and fails on a
/// disagreement, so a drift between the fold and the path cannot leave this
/// command.
fn cmd_path(context_file: &Path, customers_file: &Path, customer_id: &str) {
    let (b, _, capacity) = read_shape();
    let depth = capacity.trailing_zeros() as usize;
    let env = new_env();
    let context = read_context(&env, context_file).hash;
    let master_secret = read_master_secret(&env);

    let customers = read_customers(&env, customers_file);
    let customer_count = customers.len();
    let id = customer_id
        .trim()
        .parse::<BigUint>()
        .expect("the customer identifier is a non-negative integer");
    let global_index = index_of_customer(&customers, &id);
    let rows = pad_to_capacity(customers, capacity);
    let balance = rows[global_index].1;

    let mut leaves = Vec::with_capacity(capacity);
    let mut salt = None;
    for (index, row) in rows.iter().enumerate() {
        let (row_salt, leaf) = leaf_of_row(&env, &master_secret, &context, row, index);
        if index == global_index {
            salt = Some(row_salt);
        }
        leaves.push(leaf);
    }
    let salt = salt.expect("the leaf of the customer");

    // The levels come from the uniform fold and the root comes from the two
    // circuit stages. The two computations stay separate, so the comparison
    // below is evidence and not a restatement.
    let levels = tree_levels(&env, &leaves);
    let root = to_big(&folded_root(&env, &leaves, b));
    for index in self_check_indices(b, customer_count, global_index) {
        let path = path_in_levels(&levels, index);
        assert_eq!(
            to_big(&root_from_path(&env, &leaves[index], index, &path, depth)),
            root,
            "the path of leaf {index} does not recompute the root that the fold produces"
        );
    }

    let siblings: Vec<BigUint> = path_in_levels(&levels, global_index)
        .iter()
        .map(to_big)
        .collect();
    println!("global_index = {global_index}");
    println!("depth = {depth}");
    println!("id = {id}");
    println!("balance = {balance}");
    println!("salt = {}", to_big(&salt));
    println!("leaf = {}", to_big(&leaves[global_index]));
    println!("root = {root}");
    println!("siblings = {}", fmt_field_array(&siblings));
}

/// A field element as a package holds it: `0x` and exactly 64 lowercase
/// hexadecimal characters, the 32-byte big-endian serialization.
fn fr_hex(value: &BigUint) -> String {
    let body: String = be32(value)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    format!("0x{body}")
}

/// A field element from its hexadecimal text, with or without the `0x` prefix.
fn fr_from_hex(env: &Env, label: &str, text: &str) -> BigUint {
    let text = text.trim();
    let text = text.strip_prefix("0x").unwrap_or(text);
    let value = BigUint::from_bytes_be(&hex_bytes(label, text));
    assert!(
        value < to_big(&fr_modulus(env)),
        "{label} is not below the field modulus"
    );
    value
}

/// One deployment generation of the committed deployments file.
struct Generation {
    registry: String,
    tree_depth: usize,
}

/// The current generation of one network: the last record that names it,
/// because the file lists the generations in order.
fn select_generation(text: &str, network: &str) -> Generation {
    let json: serde_json::Value = serde_json::from_str(text).expect("the deployments file is JSON");
    let records = json
        .as_array()
        .expect("the deployments file is a list of generations");
    let record = records
        .iter()
        .rfind(|record| record["network"] == network)
        .unwrap_or_else(|| {
            panic!("{DEPLOYMENTS_FILE} records no deployment generation for network {network}")
        });
    let field = |name: &str| -> &serde_json::Value {
        let value = &record[name];
        assert!(
            !value.is_null(),
            "the {network} generation records no {name}"
        );
        value
    };
    Generation {
        registry: field("registry")
            .as_str()
            .expect("the registry is a string")
            .to_string(),
        tree_depth: field("tree_depth")
            .as_u64()
            .expect("the tree depth is a number") as usize,
    }
}

/// The fields of one package, in the order that the schema fixes.
struct Package<'a> {
    network: &'a str,
    registry: &'a str,
    asset: &'a str,
    snapshot_ledger: u32,
    leaf_index: usize,
    id: &'a BigUint,
    balance: u64,
    salt: &'a BigUint,
    siblings: &'a [BigUint],
}

/// A JSON string value, with the escaping that JSON requires.
fn json_string(text: &str) -> String {
    serde_json::Value::String(text.to_string()).to_string()
}

/// The bytes of one package file.
///
/// The layout is part of the format, so two implementations write the same
/// bytes: the keys in schema order, two-space indentation, LF line ends, and
/// one LF at the end of the file.
fn package_json(package: &Package) -> String {
    let pad = " ".repeat(JSON_INDENT);
    let mut lines = std::vec![
        format!("{pad}\"format\": {}", json_string(PACKAGE_FORMAT)),
        format!("{pad}\"network\": {}", json_string(package.network)),
        format!("{pad}\"registry\": {}", json_string(package.registry)),
        format!("{pad}\"asset\": {}", json_string(package.asset)),
        format!("{pad}\"snapshot_ledger\": {}", package.snapshot_ledger),
        format!("{pad}\"leaf_index\": {}", package.leaf_index),
        format!("{pad}\"id\": {}", json_string(&fr_hex(package.id))),
        format!(
            "{pad}\"balance\": {}",
            json_string(&package.balance.to_string())
        ),
        format!("{pad}\"salt\": {}", json_string(&fr_hex(package.salt))),
    ];
    let siblings: Vec<String> = package
        .siblings
        .iter()
        .map(|sibling| format!("{pad}{pad}{}", json_string(&fr_hex(sibling))))
        .collect();
    lines.push(format!(
        "{pad}\"siblings\": [\n{}\n{pad}]",
        siblings.join(",\n")
    ));
    format!("{{\n{}\n}}\n", lines.join(",\n"))
}

/// The authority-side record of one generation run. It holds the root, so it
/// stays with the authority and reaches no customer.
fn generation_json(count: usize, root: &BigUint, transaction_hash: &str) -> String {
    let pad = " ".repeat(JSON_INDENT);
    format!(
        "{{\n{pad}\"count\": {count},\n{pad}\"format\": {},\n{pad}\"root\": {},\n\
         {pad}\"transaction_hash\": {}\n}}\n",
        json_string(PACKAGE_FORMAT),
        json_string(&fr_hex(root)),
        json_string(transaction_hash),
    )
}

fn package_filename(leaf_index: usize) -> String {
    format!(
        "package-{leaf_index:0width$}.{PACKAGE_EXTENSION}",
        width = PACKAGE_INDEX_DIGITS
    )
}

/// Creates one directory that only the owner can enter.
fn create_dir_private(path: &Path) {
    if !path.is_dir() {
        fs::create_dir(path).unwrap_or_else(|_| panic!("create {}", path.display()));
    }
    fs::set_permissions(path, fs::Permissions::from_mode(PACKAGE_DIR_MODE))
        .unwrap_or_else(|_| panic!("set the mode of {}", path.display()));
}

/// Writes one file that only the owner can read.
///
/// The open sets the mode of a new file. An earlier file at the path keeps its
/// own mode through the open, so the mode is set again on the open file before
/// any content reaches it. The open truncated that file, so no byte of the new
/// content ever sits at the earlier mode.
fn write_private(path: &Path, text: &str) {
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(PACKAGE_FILE_MODE)
        .open(path)
        .unwrap_or_else(|_| panic!("write {}", path.display()));
    file.set_permissions(fs::Permissions::from_mode(PACKAGE_FILE_MODE))
        .unwrap_or_else(|_| panic!("set the mode of {}", path.display()));
    file.write_all(text.as_bytes())
        .unwrap_or_else(|_| panic!("write {}", path.display()));
}

/// The values that a read of the registry entry supplies. No value here comes
/// from a person: a typed ledger number proves nothing about the chain.
struct AttestedEntry {
    root: BigUint,
    snapshot_ledger: u32,
    transaction_hash: String,
}

/// The inputs of one generation run that do not come from the context file.
struct GenerationRequest<'a> {
    customers_file: &'a Path,
    deployments_file: &'a Path,
    out: &'a Path,
    network: &'a str,
    attested: &'a AttestedEntry,
}

/// Writes one package for each customer row.
///
/// The generator has no network access. The caller reads the registry entry
/// and passes the attested root and the attested snapshot, unaltered. Nothing
/// reaches the disk before both comparisons pass, because a package holds a
/// balance and an attestation that never landed must leave no file behind.
fn write_packages(
    env: &Env,
    context: &AttestationContext,
    master_secret: &U256,
    request: &GenerationRequest,
) {
    let (b, _, capacity) = read_shape();
    let depth = capacity.trailing_zeros() as usize;

    let deployments = fs::read_to_string(request.deployments_file)
        .unwrap_or_else(|_| panic!("read {}", request.deployments_file.display()));
    let generation = select_generation(&deployments, request.network);
    assert_eq!(
        generation.tree_depth, depth,
        "the {} generation holds trees of depth {}, and this tree has depth {depth}",
        request.network, generation.tree_depth
    );

    // The first half of the gate. This comparison needs no tree, and it names
    // a wrong context file directly, so it runs before the fold.
    assert_eq!(
        context.snapshot_ledger, request.attested.snapshot_ledger,
        "the context file names snapshot {}, and the registry attested {}",
        context.snapshot_ledger, request.attested.snapshot_ledger
    );

    let customers = read_customers(env, request.customers_file);
    let customer_count = customers.len();
    let rows = pad_to_capacity(customers, capacity);

    let mut leaves = Vec::with_capacity(capacity);
    let mut salts = Vec::with_capacity(customer_count);
    for (index, row) in rows.iter().enumerate() {
        let (salt, leaf) = leaf_of_row(env, master_secret, &context.hash, row, index);
        if index < customer_count {
            salts.push(to_big(&salt));
        }
        leaves.push(leaf);
    }

    // The load-bearing half of the gate. The snapshot enters the context hash,
    // the context derives every salt, and every leaf holds its salt, so an
    // equal root means the chain accepted this exact tree.
    let root = to_big(&folded_root(env, &leaves, b));
    assert!(
        root == request.attested.root,
        "the recomputed root is {}, and the registry attested {}; \
         no package may exist for a root that the chain did not accept",
        fr_hex(&root),
        fr_hex(&request.attested.root)
    );

    let directory = request
        .out
        .join("packages")
        .join(&context.asset)
        .join(context.snapshot_ledger.to_string());
    // The output directory belongs to the operator, so it keeps its own mode.
    // Every directory below it holds packages, and the tool owns those.
    fs::create_dir_all(request.out).unwrap_or_else(|_| panic!("create {}", request.out.display()));
    for level in [
        request.out.join("packages"),
        request.out.join("packages").join(&context.asset),
        directory.clone(),
    ] {
        create_dir_private(&level);
    }

    let levels = tree_levels(env, &leaves);
    for (index, salt) in salts.iter().enumerate() {
        let siblings: Vec<BigUint> = path_in_levels(&levels, index).iter().map(to_big).collect();
        let package = Package {
            network: request.network,
            registry: &generation.registry,
            asset: &context.asset,
            snapshot_ledger: context.snapshot_ledger,
            leaf_index: index,
            id: &rows[index].0,
            balance: rows[index].1,
            salt,
            siblings: &siblings,
        };
        write_private(
            &directory.join(package_filename(index)),
            &package_json(&package),
        );
    }
    write_private(
        &directory.join(GENERATION_FILE),
        &generation_json(customer_count, &root, &request.attested.transaction_hash),
    );
    println!(
        "packages: {customer_count} files in {}",
        directory.display()
    );
    println!(
        "NOTICE: {} holds one balance for each customer. Give one file to \
         one customer, and to nobody else.",
        directory.display()
    );
}

fn cmd_packages(context_file: &Path, request: &GenerationRequest) {
    let env = new_env();
    let context = read_context(&env, context_file);
    let master_secret = read_master_secret(&env);
    write_packages(&env, &context, &master_secret, request);
}

/// bb `--output_format fields` emits a JSON array of 0x-prefixed field strings
/// (proof_fields.json / public_inputs_fields.json / vk_fields.json).
fn read_field_json(path: &Path) -> Vec<BigUint> {
    let raw = fs::read_to_string(path).unwrap_or_else(|_| panic!("read {}", path.display()));
    raw.split(['[', ']', ',', '"', '\n', '\r', ' ', '\t'])
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(|t| {
            let hex = t.strip_prefix("0x").unwrap_or(t);
            BigUint::parse_bytes(hex.as_bytes(), 16).expect("hex field element")
        })
        .collect()
}

fn cmd_assemble(context_file: &Path, out: &Path) {
    let (b, k, _) = read_shape();
    if !is_release(b, k) {
        // The pin binds the aggregator to one inner circuit shape, so a pin of
        // another shape must be a deliberate act and must stay visible.
        assert!(
            env::var(DEVELOPMENT_VAR).is_ok(),
            "the pin needs the release configuration, {}; this tree holds \
             batch_b = {b} and num_batches_k = {k}. Set {DEVELOPMENT_VAR}=1 to \
             pin a development artifact, which gets no manifest and cannot deploy",
            describe_release()
        );
        println!("WARNING: this pin is a development artifact of shape B={b} K={k}");
    }
    let env = new_env();
    let context = read_context(&env, context_file).hash;

    let layout = public_input_layout(&repo_path(
        "circuits/recursion/inner/target/recursion_inner.json",
    ));
    let [slot_idx, subroot_idx, subtotal_idx] =
        INNER_PUBLIC_INPUTS.map(|name| position_of(&layout, name));
    let pub_len = layout.len();

    let vk = read_field_json(&out.join("vk_fields.json"));
    let mut proofs: Vec<Vec<BigUint>> = Vec::with_capacity(k);
    let mut pubs: Vec<Vec<BigUint>> = Vec::with_capacity(k);
    for batch in 0..k {
        let proof = read_field_json(&out.join(format!("batch_{batch}/proof_fields.json")));
        let pi = read_field_json(&out.join(format!("batch_{batch}/public_inputs_fields.json")));
        assert_eq!(
            pi.len(),
            pub_len,
            "the emitted vector does not match the compiled layout"
        );
        // The slot value is the batch index, so this confirms the layout that
        // the ABI reports against the vector that bb emits.
        assert_eq!(
            pi[slot_idx],
            BigUint::from(batch),
            "batch {batch} does not carry its slot at the position the ABI reports"
        );
        proofs.push(proof);
        pubs.push(pi);
    }

    // Constraint 1 commitment: Poseidon2 binary-tree hash of the inner vk fields,
    // zero-padded to a power of two, matching the aggregator's in-circuit hash.
    let vk_commit_width = vk.len().next_power_of_two();
    let zero = BigUint::from(0u32);
    let padded: Vec<U256> = (0..vk_commit_width)
        .map(|i| to_fr(&env, vk.get(i).unwrap_or(&zero)))
        .collect();
    let pinned_vk_hash = to_big(&subtree_root(&env, &padded));

    fs::write(
        repo_path("circuits/recursion/agg/src/params.nr"),
        format!(
            "// Generated from params.toml + the compiled inner program by\n\
             // tools/recursion-gen. Do not edit by hand.\n\
             pub global NUM_BATCHES_K: u32 = {k};\n\
             // Inner public-input vector length and the positions of (batch_slot,\n\
             // subroot, subtotal) within it. The generator reads the positions from\n\
             // the compiled program's ABI, so a value that appears twice cannot move\n\
             // a position.\n\
             pub global INNER_PUB_LEN: u32 = {pub_len};\n\
             pub global SLOT_IDX: u32 = {slot_idx};\n\
             pub global SUBROOT_IDX: u32 = {subroot_idx};\n\
             pub global SUBTOTAL_IDX: u32 = {subtotal_idx};\n\
             // bb 0.87.0 UltraHonk field encodings (version-coupled; regenerate with bb).\n\
             pub global VK_LEN: u32 = {};\n\
             pub global PROOF_LEN: u32 = {};\n\
             // Inner-vk pin (constraint 1): width the vk is zero-padded to (power of\n\
             // two) and the Poseidon2 binary-tree hash of the padded vk. The aggregator\n\
             // recomputes this hash over the witnessed vk and asserts equality.\n\
             pub global VK_COMMIT_WIDTH: u32 = {vk_commit_width};\n\
             pub global PINNED_INNER_VK_HASH: Field = {pinned_vk_hash};\n",
            vk.len(),
            proofs[0].len(),
        ),
    )
    .expect("write agg/src/params.nr");

    // No inner_key_hash input: the aggregator derives key_hash by hashing the
    // witnessed inner_vk in-circuit and asserts it equals PINNED_INNER_VK_HASH,
    // then exposes that hash as a public output for the caller to bind.
    let mut toml = format!("context_hash = \"{}\"\n", to_big(&context));
    toml.push_str(&format!("inner_vk = {}\n", fmt_field_array(&vk)));
    let proof_rows: Vec<String> = proofs.iter().map(|p| fmt_field_array(p)).collect();
    toml.push_str(&format!("proofs = [{}]\n", proof_rows.join(", ")));
    let pub_rows: Vec<String> = pubs.iter().map(|p| fmt_field_array(p)).collect();
    toml.push_str(&format!("pub_inputs = [{}]\n", pub_rows.join(", ")));
    fs::write(repo_path("circuits/recursion/agg/Prover.toml"), toml)
        .expect("write agg/Prover.toml");

    println!(
        "assemble: K={k} VK_LEN={} PROOF_LEN={} INNER_PUB_LEN={pub_len} \
         SLOT_IDX={slot_idx} SUBROOT_IDX={subroot_idx} SUBTOTAL_IDX={subtotal_idx} \
         VK_COMMIT_WIDTH={vk_commit_width} -> agg/src/params.nr + agg/Prover.toml",
        vk.len(),
        proofs[0].len(),
    );
}

/// Records the identity of the release artifact.
///
/// A reader of the manifest can tell which artifact a deployment holds without
/// trusting the person who produced it: the shape, both key hashes, and the
/// public input schema all come from the built files. The manifest exists only
/// for the release configuration, and the deploy path needs it.
fn cmd_manifest(inner_out: &Path, agg_target: &Path) {
    let (b, k, _) = read_shape();
    assert!(
        is_release(b, k),
        "a manifest needs the release configuration, {}; this tree holds \
         batch_b = {b} and num_batches_k = {k}",
        describe_release()
    );
    let env = new_env();
    let versions = read_pairs(&repo_path(VERSIONS_FILE));
    let scheme = text_value(&versions, "PROOF_SCHEME");
    let inner_oracle = text_value(&versions, "INNER_ORACLE_HASH");
    let terminal_oracle = text_value(&versions, "TERMINAL_ORACLE_HASH");

    // The tools answer for themselves. A copy earlier on PATH would otherwise
    // build the artifact while the manifest recorded the pinned version.
    let bb_version = first_line("bb", &["--version"]);
    let nargo_version = first_line("nargo", &["--version"])
        .split_whitespace()
        .last()
        .unwrap_or_default()
        .to_string();
    assert_tool_version(
        "bb",
        &bb_version,
        text_value(&versions, "BB_VERSION").trim_start_matches('v'),
    );
    assert_tool_version(
        "nargo",
        &nargo_version,
        &text_value(&versions, "NARGO_VERSION"),
    );

    // The artifacts must describe this configuration, and each key must come
    // from the program it belongs to. Without both checks a run over stale
    // outputs would label a development key as the release key.
    let inner_program = repo_path("circuits/recursion/inner/target/recursion_inner.json");
    let agg_program = agg_target.join("recursion_agg.json");
    let inner_key = inner_out.join("vk_fields.json");
    let agg_key = agg_target.join("vk");
    assert_eq!(
        parameter_array_length(&inner_program, "ids"),
        b,
        "the compiled inner program does not hold batch_b leaves"
    );
    assert_eq!(
        parameter_array_length(&agg_program, "proofs"),
        k,
        "the compiled aggregator does not fold num_batches_k proofs"
    );
    assert_key_matches_program(&inner_program, inner_out, &scheme, &inner_oracle, true);
    assert_key_matches_program(&agg_program, agg_target, &scheme, &terminal_oracle, false);

    let inner_vk = read_field_json(&inner_key);
    let width = inner_vk.len().next_power_of_two();
    let zero = BigUint::from(0u32);
    let padded: Vec<U256> = (0..width)
        .map(|i| to_fr(&env, inner_vk.get(i).unwrap_or(&zero)))
        .collect();
    let inner_key_hash = to_big(&subtree_root(&env, &padded));

    let key_bytes = fs::read(&agg_key).expect("read the aggregator key bytes");
    let key_sha256 = env
        .crypto()
        .sha256(&Bytes::from_slice(&env, &key_bytes))
        .to_array();
    let key_sha256: String = key_sha256
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();

    let layout = public_input_layout(&agg_program);
    let positions: Vec<(&str, usize)> = OUTER_PUBLIC_INPUTS
        .iter()
        .map(|(name, abi_name)| (*name, position_of(&layout, abi_name)))
        .collect();
    assert_eq!(
        layout.len(),
        positions.len(),
        "the terminal proof does not carry exactly {} public inputs",
        positions.len()
    );

    // The key counts the pairing point accumulator, and the public input byte
    // string does not carry it, so the two counts differ by those limbs.
    let agg_vk = read_field_json(&agg_target.join("vk_fields.json"));
    let key_count = &agg_vk[VK_PUBLIC_INPUTS_SIZE_INDEX];
    assert_eq!(
        *key_count,
        BigUint::from(layout.len() + PAIRING_POINT_LIMBS),
        "the key counts {key_count} public inputs, and the layout holds {}",
        layout.len()
    );

    // The pin binds the aggregator to this inner key, so the two must agree.
    let pinned = fs::read_to_string(repo_path("circuits/recursion/agg/src/params.nr"))
        .expect("read agg/src/params.nr");
    assert!(
        pinned.contains(&format!("PINNED_INNER_VK_HASH: Field = {inner_key_hash};")),
        "the aggregator pins another inner key than the one in {}",
        inner_key.display()
    );

    let schema: Vec<String> = positions
        .iter()
        .map(|(name, index)| format!("    \"{name}\": {index}"))
        .collect();
    let manifest = format!(
        "{{\n  \"batch_b\": {b},\n  \"num_batches_k\": {k},\n  \
         \"bb_version\": \"{}\",\n  \"nargo_version\": \"{}\",\n  \
         \"proof_scheme\": \"{}\",\n  \"terminal_oracle_hash\": \"{}\",\n  \
         \"inner_oracle_hash\": \"{}\",\n  \
         \"inner_key_hash\": \"{inner_key_hash}\",\n  \
         \"aggregator_key_file\": \"{AGG_KEY_FILE}\",\n  \
         \"aggregator_key_sha256\": \"{key_sha256}\",\n  \
         \"aggregator_key_bytes\": {},\n  \
         \"public_input_count\": {},\n  \"public_input_bytes\": {},\n  \
         \"public_input_positions\": {{\n{}\n  }}\n}}\n",
        bb_version,
        nargo_version,
        scheme,
        terminal_oracle,
        inner_oracle,
        key_bytes.len(),
        layout.len(),
        layout.len() * FR_BYTES,
        schema.join(",\n")
    );
    fs::write(repo_path(MANIFEST_FILE), manifest).expect("write the manifest");
    // The key travels with the manifest, so a reader can hash it and compare.
    fs::write(repo_path(AGG_KEY_FILE), &key_bytes).expect("write the aggregator key");
    write_registry_params(&key_sha256, &inner_key_hash, &positions);
    println!("manifest: B={b} K={k} -> {MANIFEST_FILE} + {AGG_KEY_FILE} + {REGISTRY_PARAMS_FILE}");
}

/// Rust source of a 32-byte array, eight bytes to a line.
fn byte_array_source(bytes: &[u8; FR_BYTES]) -> String {
    bytes
        .chunks(8)
        .map(|row| {
            let cells: Vec<String> = row.iter().map(|byte| format!("0x{byte:02x},")).collect();
            format!("    {}\n", cells.join(" "))
        })
        .collect()
}

/// Writes the two constants that the registry compiles in.
///
/// The registry must not trust a verifier address by configuration alone, so
/// it needs the hash of the key that this artifact produced. The inner key
/// hash travels with it, because the terminal proof carries that value as a
/// public input.
/// Rust name of the position constant of one public input.
fn position_constant(name: &str) -> String {
    format!("{}_INDEX", name.to_uppercase())
}

fn write_registry_params(key_sha256: &str, inner_key_hash: &BigUint, positions: &[(&str, usize)]) {
    let mut key_bytes = [0u8; FR_BYTES];
    for (index, cell) in key_bytes.iter_mut().enumerate() {
        *cell = u8::from_str_radix(&key_sha256[index * 2..index * 2 + 2], 16)
            .expect("the key hash is hexadecimal");
    }
    let mut hash_bytes = [0u8; FR_BYTES];
    let be = inner_key_hash.to_bytes_be();
    hash_bytes[FR_BYTES - be.len()..].copy_from_slice(&be);

    fs::write(
        repo_path(REGISTRY_PARAMS_FILE),
        format!(
            "//! Generated from the built artifacts by tools/recursion-gen. Do not\n\
             //! edit by hand.\n\
             \n\
             /// SHA-256 of the aggregator verification key that this build expects a\n\
             /// verifier to hold: {key_sha256}.\n\
             #[rustfmt::skip]\n\
             pub const AGGREGATOR_KEY_SHA256: [u8; {FR_BYTES}] = [\n{}];\n\
             \n\
             /// The Poseidon2 tree hash of the pinned inner verification key, as {FR_BYTES}\n\
             /// big-endian bytes. The terminal proof carries this value as a public\n\
             /// input, and the aggregator asserts it in the circuit.\n\
             #[rustfmt::skip]\n\
             pub const INNER_KEY_HASH: [u8; {FR_BYTES}] = [\n{}];\n\
             \n\
             /// Number of elements of the public input byte string of the terminal\n\
             /// proof. Each element is {FR_BYTES} bytes big-endian.\n\
             pub const PUBLIC_INPUT_COUNT: u32 = {};\n\
             \n\
             /// Position of each element inside that byte string. A consumer reads\n\
             /// the positions here, because two elements can hold one value and a\n\
             /// search by value can find the wrong one.\n\
             {}",
            byte_array_source(&key_bytes),
            byte_array_source(&hash_bytes),
            positions.len(),
            positions
                .iter()
                .map(|(name, index)| format!(
                    "pub const {}: u32 = {index};\n",
                    position_constant(name)
                ))
                .collect::<String>(),
        ),
    )
    .expect("write the registry parameters");
}

const USAGE: &str = "usage: recursion-gen witness <context.toml> <customers.csv>\n\
                            recursion-gen path <context.toml> <customers.csv> <customer_id>\n\
                            recursion-gen packages <context.toml> <customers.csv> <out_dir> \
                            --network <name> --attested-root <hex> \
                            --attested-snapshot <ledger> --transaction <hash>\n\
                            recursion-gen assemble <context.toml> [out_dir]\n\
                            recursion-gen manifest <inner_out_dir> <agg_target_dir>";

/// The value of one required named argument.
fn flag_value(args: &[String], name: &str) -> String {
    let position = args
        .iter()
        .position(|arg| arg == name)
        .unwrap_or_else(|| panic!("missing {name}"));
    args.get(position + 1)
        .unwrap_or_else(|| panic!("{name} needs a value"))
        .clone()
}

fn main() {
    let args: Vec<String> = env::args().collect();
    let arg = |i: usize| args.get(i).map(PathBuf::from);
    match args.get(1).map(String::as_str) {
        Some("witness") => match (arg(2), arg(3)) {
            (Some(context), Some(customers)) => cmd_witness(&context, &customers),
            _ => usage(),
        },
        Some("path") => match (arg(2), arg(3), args.get(4)) {
            (Some(context), Some(customers), Some(id)) => cmd_path(&context, &customers, id),
            _ => usage(),
        },
        Some("packages") => match (arg(2), arg(3), arg(4)) {
            (Some(context), Some(customers), Some(out)) => {
                let snapshot = flag_value(&args, "--attested-snapshot");
                let attested = AttestedEntry {
                    root: fr_from_hex(
                        &new_env(),
                        "the attested root",
                        &flag_value(&args, "--attested-root"),
                    ),
                    snapshot_ledger: snapshot
                        .trim()
                        .parse()
                        .expect("the attested snapshot is a u32"),
                    transaction_hash: flag_value(&args, "--transaction"),
                };
                cmd_packages(
                    &context,
                    &GenerationRequest {
                        customers_file: &customers,
                        deployments_file: &repo_path(DEPLOYMENTS_FILE),
                        out: &out,
                        network: &flag_value(&args, "--network"),
                        attested: &attested,
                    },
                );
            }
            _ => usage(),
        },
        Some("assemble") => match arg(2) {
            Some(context) => {
                let out = arg(3).unwrap_or_else(|| repo_path("circuits/recursion/inner/out"));
                cmd_assemble(&context, &out);
            }
            None => usage(),
        },
        Some("manifest") => match (arg(2), arg(3)) {
            (Some(inner_out), Some(agg_target)) => cmd_manifest(&inner_out, &agg_target),
            _ => usage(),
        },
        _ => usage(),
    }
}

fn usage() -> ! {
    eprintln!("{USAGE}");
    std::process::exit(2);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rows(count: usize) -> Vec<(BigUint, u64)> {
        (0..count)
            .map(|i| (BigUint::from(i as u64 + 1), i as u64 + 1))
            .collect()
    }

    #[test]
    fn a_count_below_the_capacity_is_padded() {
        let padded = pad_to_capacity(rows(3), 8);
        assert_eq!(padded.len(), 8);
        for row in padded.iter().skip(3) {
            assert_eq!(*row, (BigUint::from(PADDING_LEAF_ID), PADDING_LEAF_BALANCE));
        }
        // A padding leaf adds nothing to the total.
        let total: u64 = padded.iter().map(|(_, balance)| balance).sum();
        assert_eq!(
            total,
            rows(3).iter().map(|(_, balance)| balance).sum::<u64>()
        );
    }

    #[test]
    fn a_count_at_the_capacity_is_unchanged() {
        assert_eq!(pad_to_capacity(rows(8), 8), rows(8));
    }

    #[test]
    #[should_panic(expected = "does not cut the list")]
    fn a_count_above_the_capacity_fails() {
        pad_to_capacity(rows(9), 8);
    }

    /// The abi block of a compiled program, with one public parameter and a
    /// public tuple return value.
    const ABI: &str = r#"{"abi": {
        "parameters": [
            {"name": "context_hash", "type": {"kind": "field"}, "visibility": "public"},
            {"name": "inner_vk", "type": {"kind": "array", "length": 2,
             "type": {"kind": "field"}}, "visibility": "private"}],
        "return_type": {"abi_type": {"kind": "tuple", "fields": [
            {"kind": "field"}, {"kind": "field"}]}, "visibility": "public"}}}"#;

    fn write_temp(name: &str, text: &str) -> PathBuf {
        let path = env::temp_dir().join(name);
        fs::write(&path, text).expect("write the temporary program");
        path
    }

    #[test]
    fn the_layout_holds_the_public_parameters_and_then_the_return_values() {
        let layout = public_input_layout(&write_temp("zkpor_layout_ok.json", ABI));
        assert_eq!(layout, ["context_hash", "return.0", "return.1"]);
        assert_eq!(position_of(&layout, "context_hash"), 0);
        assert_eq!(position_of(&layout, "return.1"), 2);
    }

    #[test]
    #[should_panic(expected = "exactly once")]
    fn an_absent_public_input_fails() {
        let layout = public_input_layout(&write_temp("zkpor_layout_absent.json", ABI));
        position_of(&layout, "subroot");
    }

    /// Shapes that the path tests cover. Each pair is (B, K), and both values
    /// are powers of two of at least 2, as params.toml requires.
    const SHAPES: [(usize, usize); 5] = [(2, 2), (2, 4), (4, 2), (4, 4), (8, 2)];

    /// Distinct leaves of a tree of `count` positions. The values only have to
    /// differ, so the test builds them from the leaf hash directly instead of
    /// from a context and a master secret.
    fn leaves(env: &Env, count: usize) -> Vec<U256> {
        (0..count)
            .map(|i| {
                let id = to_fr(env, &BigUint::from(i as u64 + 1));
                let salt = to_fr(env, &BigUint::from(i as u64 + 1000));
                leaf_hash(env, &id, i as u64 * 7 + 1, &salt)
            })
            .collect()
    }

    fn depth_of(capacity: usize) -> usize {
        capacity.trailing_zeros() as usize
    }

    /// The path of one leaf. A test that reads a single path folds the tree
    /// for that path, and a test that reads many folds it once.
    fn path_of(env: &Env, leaves: &[U256], global_index: usize) -> Vec<U256> {
        path_in_levels(&tree_levels(env, leaves), global_index)
    }

    /// The drift guard. The generator holds the path extraction next to the
    /// fold, so this test fails as soon as one of the two moves.
    #[test]
    fn every_path_recomputes_the_root_that_the_fold_produces() {
        let env = new_env();
        for (b, k) in SHAPES {
            let capacity = b * k;
            let tree = leaves(&env, capacity);
            let root = to_big(&folded_root(&env, &tree, b));
            let levels = tree_levels(&env, &tree);
            for (g, leaf) in tree.iter().enumerate() {
                let siblings = path_in_levels(&levels, g);
                assert_eq!(
                    to_big(&root_from_path(
                        &env,
                        leaf,
                        g,
                        &siblings,
                        depth_of(capacity)
                    )),
                    root,
                    "leaf {g} of the tree of B={b} K={k}"
                );
            }
        }
    }

    #[test]
    fn the_path_holds_one_sibling_for_each_level() {
        let env = new_env();
        for (b, k) in SHAPES {
            let capacity = b * k;
            let tree = leaves(&env, capacity);
            let levels = tree_levels(&env, &tree);
            for g in 0..capacity {
                assert_eq!(path_in_levels(&levels, g).len(), depth_of(capacity));
            }
        }
    }

    /// The first leaf is the left input at every level, and the last leaf is
    /// the right input at every level. The first sibling is the neighbour leaf
    /// in both cases.
    #[test]
    fn the_first_and_the_last_leaf_sit_at_the_two_edges() {
        let env = new_env();
        let (b, capacity) = (4, 16);
        let tree = leaves(&env, capacity);
        let first = path_of(&env, &tree, 0);
        let last = path_of(&env, &tree, capacity - 1);
        assert_eq!(to_big(&first[0]), to_big(&tree[1]));
        assert_eq!(to_big(&last[0]), to_big(&tree[capacity - 2]));

        // Every step of the first leaf pairs the node on the left, and every
        // step of the last leaf pairs it on the right.
        let mut left = tree[0].clone();
        let mut right = tree[capacity - 1].clone();
        for level in 0..depth_of(capacity) {
            left = node_hash(&env, &left, &first[level]);
            right = node_hash(&env, &last[level], &right);
        }
        let root = to_big(&folded_root(&env, &tree, b));
        assert_eq!(to_big(&left), root);
        assert_eq!(to_big(&right), root);
    }

    /// The index alone states the direction, so the same siblings under
    /// another index give another value.
    #[test]
    fn another_index_over_the_same_path_gives_another_root() {
        let env = new_env();
        let (b, capacity) = (4, 16);
        let tree = leaves(&env, capacity);
        let root = to_big(&folded_root(&env, &tree, b));
        let depth = depth_of(capacity);
        let siblings = path_of(&env, &tree, 5);
        for wrong in [0, 4, 7, 13, capacity - 1] {
            assert_ne!(
                to_big(&root_from_path(&env, &tree[5], wrong, &siblings, depth)),
                root,
                "index {wrong} must not reach the root of leaf 5"
            );
        }
    }

    #[test]
    #[should_panic(expected = "one sibling for each")]
    fn a_truncated_path_fails() {
        let env = new_env();
        let capacity = 16;
        let tree = leaves(&env, capacity);
        let siblings = path_of(&env, &tree, 5);
        root_from_path(&env, &tree[5], 5, &siblings[..2], depth_of(capacity));
    }

    #[test]
    #[should_panic(expected = "outside a tree")]
    fn an_index_outside_the_tree_fails() {
        let env = new_env();
        let tree = leaves(&env, 8);
        path_of(&env, &tree, 8);
    }

    /// One changed bit in one sibling breaks the recomputation at every level.
    #[test]
    fn a_sibling_that_changed_by_one_bit_gives_another_root() {
        let env = new_env();
        let (b, capacity) = (4, 16);
        let tree = leaves(&env, capacity);
        let root = to_big(&folded_root(&env, &tree, b));
        let depth = depth_of(capacity);
        let siblings = path_of(&env, &tree, 5);
        for level in 0..depth {
            let mut changed = siblings.clone();
            changed[level] = to_fr(&env, &(to_big(&siblings[level]) ^ BigUint::from(1u32)));
            assert_ne!(
                to_big(&root_from_path(&env, &tree[5], 5, &changed, depth)),
                root,
                "a changed sibling at level {level} must not reach the root"
            );
        }
    }

    #[test]
    fn the_index_of_a_customer_is_the_row_of_the_identifier() {
        let rows = rows(4);
        assert_eq!(index_of_customer(&rows, &BigUint::from(1u32)), 0);
        assert_eq!(index_of_customer(&rows, &BigUint::from(4u32)), 3);
    }

    #[test]
    #[should_panic(expected = "no row with identifier")]
    fn an_absent_identifier_gets_no_path() {
        index_of_customer(&rows(4), &BigUint::from(9u32));
    }

    /// A liability list of three rows. Only the identifier of the last row
    /// changes, so a rejected list and its control differ in one value.
    fn list_with_last_identifier(id: &str) -> String {
        format!("id,balance\n1,10\n2,20\n{id},30\n")
    }

    /// Reads the list through the same reader that the witness command calls,
    /// so an invalid list fails before any tree exists.
    fn read_list(name: &str, id: &str) -> Vec<(BigUint, u64)> {
        let env = new_env();
        let path = write_temp(name, &list_with_last_identifier(id));
        read_customers(&env, &path)
    }

    /// The control of the three rejections below.
    #[test]
    fn the_reader_accepts_distinct_nonzero_identifiers() {
        let rows = read_list("zkpor_rows_ok.csv", "3");
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[2], (BigUint::from(3u32), 30));
    }

    #[test]
    #[should_panic(expected = "must not be zero")]
    fn the_reader_rejects_the_padding_identifier() {
        read_list("zkpor_rows_zero.csv", "0");
    }

    #[test]
    #[should_panic(expected = "repeats identifier")]
    fn the_reader_rejects_a_repeated_identifier() {
        read_list("zkpor_rows_repeat.csv", "2");
    }

    #[test]
    #[should_panic(expected = "below the field modulus")]
    fn the_reader_rejects_an_identifier_that_is_not_a_field_element() {
        let modulus = to_big(&fr_modulus(&new_env()));
        read_list("zkpor_rows_modulus.csv", &modulus.to_string());
    }

    #[test]
    fn the_self_check_reads_the_edges_of_the_tree() {
        // The batch boundary, the first leaf, the last customer row, and the
        // leaf that the caller asked for.
        assert_eq!(
            self_check_indices(1024, 1000, 499),
            [0, 499, 999, 1023, 1024]
        );
        // A request at an edge adds no position.
        assert_eq!(self_check_indices(4, 4, 0), [0, 3, 4]);
    }

    // ---- the inclusion package ----

    const TEST_NETWORK: &str = "test-only-network";
    /// A valid contract StrKey. It stands for a registry in these tests only.
    const TEST_REGISTRY: &str = "CBCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEJ5HZ";
    const TEST_TRANSACTION: &str =
        "3a1f0000000000000000000000000000000000000000000000000000000000ff";
    const CUSTOMERS_FIXTURE: &str = "fixtures/test_only_customers.csv";

    fn fixture_context(env: &Env) -> AttestationContext {
        read_context(env, &repo_path("fixtures/test_only_context.toml"))
    }

    /// The master secret of the committed fixture. The tests read the file
    /// rather than the process environment, so no test changes the process.
    fn fixture_master_secret(env: &Env) -> U256 {
        let pairs = read_pairs(&repo_path("fixtures/test_only_master_secret.env"));
        let raw = pairs
            .get("TEST_ONLY_MASTER_SECRET")
            .expect("the fixture holds the test secret")
            .clone();
        let raw = raw.trim().trim_start_matches("0x");
        fr_reduce(env, &hex_bytes("the fixture secret", raw))
    }

    fn fixture_rows(env: &Env) -> Vec<(BigUint, u64)> {
        read_customers(env, &repo_path(CUSTOMERS_FIXTURE))
    }

    fn deployments_with_depth(name: &str, depth: usize) -> PathBuf {
        write_temp(
            name,
            &format!(
                "[\n  {{\n    \"network\": \"{TEST_NETWORK}\",\n    \
                 \"registry\": \"{TEST_REGISTRY}\",\n    \
                 \"verifier\": \"{TEST_REGISTRY}\",\n    \
                 \"verification_key_sha256\": \"{TEST_TRANSACTION}\",\n    \
                 \"tree_depth\": {depth}\n  }}\n]\n"
            ),
        )
    }

    /// The attestation that the fixture produces. One process computes it once,
    /// because the tree of the release shape is expensive to fold.
    fn fixture_attestation() -> &'static AttestedEntry {
        static ATTESTED: std::sync::OnceLock<AttestedEntry> = std::sync::OnceLock::new();
        ATTESTED.get_or_init(|| {
            let env = new_env();
            let context = fixture_context(&env);
            let (b, _, capacity) = read_shape();
            let master_secret = fixture_master_secret(&env);
            let rows = pad_to_capacity(fixture_rows(&env), capacity);
            let leaves: Vec<U256> = rows
                .iter()
                .enumerate()
                .map(|(index, row)| leaf_of_row(&env, &master_secret, &context.hash, row, index).1)
                .collect();
            AttestedEntry {
                root: to_big(&folded_root(&env, &leaves, b)),
                snapshot_ledger: context.snapshot_ledger,
                transaction_hash: TEST_TRANSACTION.to_string(),
            }
        })
    }

    /// Writes the packages of the fixture into a fresh directory and returns
    /// the directory that holds them.
    fn generate_into(out_name: &str, attested: &AttestedEntry, deployments: &Path) -> PathBuf {
        let env = new_env();
        let context = fixture_context(&env);
        let out = env::temp_dir().join(out_name);
        let _ = fs::remove_dir_all(&out);
        write_packages(
            &env,
            &context,
            &fixture_master_secret(&env),
            &GenerationRequest {
                customers_file: &repo_path(CUSTOMERS_FIXTURE),
                deployments_file: deployments,
                out: &out,
                network: TEST_NETWORK,
                attested,
            },
        );
        out.join("packages")
            .join(&context.asset)
            .join(context.snapshot_ledger.to_string())
    }

    /// One generation over the fixture, done once for every test that reads it.
    fn generated() -> &'static PathBuf {
        static DIRECTORY: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
        DIRECTORY.get_or_init(|| {
            let depth = read_shape().2.trailing_zeros() as usize;
            generate_into(
                "zkpor_packages",
                fixture_attestation(),
                &deployments_with_depth("zkpor_deployments_ok.json", depth),
            )
        })
    }

    fn package_files(directory: &Path) -> Vec<PathBuf> {
        let mut files: Vec<PathBuf> = fs::read_dir(directory)
            .expect("read the package directory")
            .map(|entry| entry.expect("a directory entry").path())
            .filter(|path| path.to_string_lossy().ends_with(PACKAGE_EXTENSION))
            .collect();
        files.sort();
        files
    }

    fn mode_of(path: &Path) -> u32 {
        fs::metadata(path)
            .expect("the metadata")
            .permissions()
            .mode()
            & 0o777
    }

    #[test]
    fn a_field_element_is_sixty_four_lowercase_hexadecimal_characters() {
        // The expected text comes from the standard library, not from fr_hex.
        assert_eq!(fr_hex(&BigUint::from(255u32)), format!("0x{:0>64}", "ff"));
        assert_eq!(
            fr_hex(&BigUint::from(0xabcdefu32)),
            format!("0x{:0>64}", "abcdef")
        );
        // Big endian: a value of one byte sits at the end of the text.
        let high = BigUint::from(1u32) << 248;
        assert_eq!(fr_hex(&high), format!("0x01{}", "0".repeat(62)));
    }

    #[test]
    fn the_filename_pads_the_leaf_index_to_six_digits() {
        assert_eq!(package_filename(42), "package-000042.zkpor.json");
        assert_eq!(package_filename(0), "package-000000.zkpor.json");
        assert_eq!(package_filename(1234567), "package-1234567.zkpor.json");
    }

    /// The layout is part of the format, so this pins the key order, the
    /// indentation, and the line ends.
    #[test]
    fn the_package_layout_is_fixed() {
        let package = Package {
            network: "testnet",
            registry: "CBCE",
            asset: "CARC",
            snapshot_ledger: 1000,
            leaf_index: 42,
            id: &BigUint::from(7u32),
            balance: u64::MAX,
            salt: &BigUint::from(1u32),
            siblings: &[BigUint::from(2u32), BigUint::from(3u32)],
        };
        // The expected hexadecimal comes from the standard library, so the
        // test does not restate the padding rule of fr_hex.
        let id = format!("{:0>64}", "07");
        let salt = format!("{:0>64}", "01");
        let first = format!("{:0>64}", "02");
        let second = format!("{:0>64}", "03");
        let expected = format!(
            "{{\n  \"format\": \"zkpor-inclusion/1\",\n  \"network\": \"testnet\",\n  \
             \"registry\": \"CBCE\",\n  \"asset\": \"CARC\",\n  \"snapshot_ledger\": 1000,\n  \
             \"leaf_index\": 42,\n  \"id\": \"0x{id}\",\n  \
             \"balance\": \"18446744073709551615\",\n  \"salt\": \"0x{salt}\",\n  \
             \"siblings\": [\n    \"0x{first}\",\n    \"0x{second}\"\n  ]\n}}\n"
        );
        assert_eq!(package_json(&package), expected);
    }

    #[test]
    fn the_generation_is_the_last_record_of_the_network() {
        let text = r#"[
          {"network": "a", "registry": "R1", "tree_depth": 4},
          {"network": "b", "registry": "R2", "tree_depth": 8},
          {"network": "a", "registry": "R3", "tree_depth": 12}
        ]"#;
        let generation = select_generation(text, "a");
        assert_eq!(generation.registry, "R3");
        assert_eq!(generation.tree_depth, 12);
        assert_eq!(select_generation(text, "b").registry, "R2");
    }

    #[test]
    #[should_panic(expected = "no deployment generation for network")]
    fn a_network_without_a_generation_fails() {
        let text = r#"[{"network": "a", "registry": "R", "tree_depth": 4}]"#;
        select_generation(text, "b");
    }

    #[test]
    fn the_committed_deployments_file_is_an_ordered_list() {
        let text = fs::read_to_string(repo_path(DEPLOYMENTS_FILE)).expect("the deployments file");
        let json: serde_json::Value = serde_json::from_str(&text).expect("the file is JSON");
        assert!(json.is_array(), "the deployments file is a list");
    }

    #[test]
    fn one_package_exists_for_each_customer_row_and_none_for_a_padding_leaf() {
        let directory = generated();
        let rows = fixture_rows(&new_env());
        assert_eq!(package_files(directory).len(), rows.len());
        assert!(directory.join(package_filename(0)).is_file());
        assert!(directory.join(package_filename(rows.len() - 1)).is_file());
        // The first padding position holds no package.
        assert!(!directory.join(package_filename(rows.len())).exists());
        assert!(directory.join(GENERATION_FILE).is_file());
    }

    /// The load-bearing test. Every package verifies against the root that the
    /// fold produced, and every field holds what section 10.2 fixes.
    #[test]
    fn every_package_holds_the_fixed_fields_and_verifies_against_the_attested_root() {
        let env = new_env();
        let context = fixture_context(&env);
        let rows = fixture_rows(&env);
        let depth = read_shape().2.trailing_zeros() as usize;
        let attested = &fixture_attestation().root;
        let directory = generated();

        let hex_value = |text: &str| -> BigUint {
            assert_eq!(text.len(), 2 + FR_BYTES * 2, "an Fr field is 0x and 64 hex");
            assert!(text.starts_with("0x"));
            let body = &text[2..];
            assert_eq!(body, body.to_lowercase(), "an Fr field is lowercase");
            BigUint::parse_bytes(body.as_bytes(), 16).expect("hexadecimal")
        };

        for (index, (id, balance)) in rows.iter().enumerate() {
            let text = fs::read_to_string(directory.join(package_filename(index)))
                .expect("read the package");
            assert!(text.ends_with("}\n") && !text.contains('\r'));
            let json: serde_json::Value = serde_json::from_str(&text).expect("the package is JSON");
            let object = json.as_object().expect("the package is an object");

            // Presence and absence. The root and the total never appear.
            assert_eq!(
                object.keys().collect::<Vec<_>>(),
                std::vec![
                    "asset",
                    "balance",
                    "format",
                    "id",
                    "leaf_index",
                    "network",
                    "registry",
                    "salt",
                    "siblings",
                    "snapshot_ledger"
                ],
                "the package holds exactly the fields of the schema"
            );

            assert_eq!(json["format"], PACKAGE_FORMAT);
            assert_eq!(json["network"], TEST_NETWORK);
            assert_eq!(json["registry"], TEST_REGISTRY);
            assert_eq!(json["asset"], context.asset);
            assert_eq!(json["snapshot_ledger"], context.snapshot_ledger);
            assert_eq!(json["leaf_index"], index);
            assert_eq!(json["balance"], balance.to_string());
            assert_eq!(hex_value(json["id"].as_str().expect("id is a string")), *id);

            let siblings = json["siblings"].as_array().expect("siblings is a list");
            assert_eq!(siblings.len(), depth);
            let siblings: Vec<U256> = siblings
                .iter()
                .map(|value| to_fr(&env, &hex_value(value.as_str().expect("a sibling"))))
                .collect();
            let salt = to_fr(&env, &hex_value(json["salt"].as_str().expect("salt")));
            let leaf = leaf_hash(&env, &to_fr(&env, id), *balance, &salt);
            assert_eq!(
                to_big(&root_from_path(&env, &leaf, index, &siblings, depth)),
                *attested,
                "package {index} does not verify against the attested root"
            );
        }
    }

    #[test]
    fn the_bookkeeping_record_holds_the_count_and_the_root() {
        let text = fs::read_to_string(generated().join(GENERATION_FILE)).expect("the record");
        let json: serde_json::Value = serde_json::from_str(&text).expect("the record is JSON");
        assert_eq!(json["count"], fixture_rows(&new_env()).len());
        assert_eq!(json["format"], PACKAGE_FORMAT);
        assert_eq!(json["root"], fr_hex(&fixture_attestation().root));
        assert_eq!(json["transaction_hash"], TEST_TRANSACTION);
    }

    #[test]
    fn the_directory_and_the_files_are_private() {
        let directory = generated();
        // Every directory that the tool creates, from `packages` downward.
        let asset = directory.parent().expect("the asset directory");
        assert_eq!(mode_of(directory), PACKAGE_DIR_MODE);
        assert_eq!(mode_of(asset), PACKAGE_DIR_MODE);
        assert_eq!(
            mode_of(asset.parent().expect("the packages directory")),
            PACKAGE_DIR_MODE
        );
        assert_eq!(
            mode_of(&directory.join(package_filename(0))),
            PACKAGE_FILE_MODE
        );
        assert_eq!(mode_of(&directory.join(GENERATION_FILE)), PACKAGE_FILE_MODE);
    }

    /// A file that already exists takes the private mode before the new
    /// content reaches it, so no byte ever sits at the earlier mode.
    #[test]
    fn a_rewritten_file_is_private_from_the_first_byte() {
        let path = write_temp("zkpor_rewrite.json", "an earlier file");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).expect("the wide mode");
        write_private(&path, "the new content\n");
        assert_eq!(mode_of(&path), PACKAGE_FILE_MODE);
        assert_eq!(
            fs::read_to_string(&path).expect("read"),
            "the new content\n"
        );
    }

    /// Two writers must produce the same bytes, so a second run over the same
    /// inputs reproduces every file exactly.
    #[test]
    fn a_second_generation_writes_the_same_bytes() {
        let depth = read_shape().2.trailing_zeros() as usize;
        let again = generate_into(
            "zkpor_packages_again",
            fixture_attestation(),
            &deployments_with_depth("zkpor_deployments_again.json", depth),
        );
        let first = package_files(generated());
        let second = package_files(&again);
        assert_eq!(first.len(), second.len());
        for (one, two) in first.iter().zip(second.iter()) {
            assert_eq!(
                one.file_name(),
                two.file_name(),
                "the two runs name their files differently"
            );
            assert_eq!(
                fs::read(one).expect("read"),
                fs::read(two).expect("read"),
                "{} differs between two runs",
                one.display()
            );
        }
    }

    #[test]
    #[should_panic(expected = "names snapshot")]
    fn a_snapshot_that_the_chain_did_not_attest_is_refused() {
        let depth = read_shape().2.trailing_zeros() as usize;
        let attested = AttestedEntry {
            root: fixture_attestation().root.clone(),
            snapshot_ledger: fixture_attestation().snapshot_ledger + 1,
            transaction_hash: TEST_TRANSACTION.to_string(),
        };
        generate_into(
            "zkpor_packages_snapshot",
            &attested,
            &deployments_with_depth("zkpor_deployments_snapshot.json", depth),
        );
    }

    #[test]
    #[should_panic(expected = "holds trees of depth")]
    fn a_generation_of_another_tree_depth_is_refused() {
        generate_into(
            "zkpor_packages_depth",
            fixture_attestation(),
            &deployments_with_depth("zkpor_deployments_depth.json", 3),
        );
    }

    /// A refused generation must leave nothing behind: a package holds a
    /// balance, and a root the chain did not accept must produce no file.
    #[test]
    fn a_root_that_the_chain_did_not_attest_writes_no_file() {
        let depth = read_shape().2.trailing_zeros() as usize;
        let deployments = deployments_with_depth("zkpor_deployments_root.json", depth);
        let out = env::temp_dir().join("zkpor_packages_root");
        let _ = fs::remove_dir_all(&out);

        let refused = std::panic::catch_unwind(|| {
            let env = new_env();
            let context = fixture_context(&env);
            let attested = AttestedEntry {
                root: &fixture_attestation().root + BigUint::from(1u32),
                snapshot_ledger: fixture_attestation().snapshot_ledger,
                transaction_hash: TEST_TRANSACTION.to_string(),
            };
            write_packages(
                &env,
                &context,
                &fixture_master_secret(&env),
                &GenerationRequest {
                    customers_file: &repo_path(CUSTOMERS_FIXTURE),
                    deployments_file: &deployments,
                    out: &out,
                    network: TEST_NETWORK,
                    attested: &attested,
                },
            );
        });
        assert!(refused.is_err(), "a wrong root must refuse");
        assert!(!out.exists(), "a refused generation left files behind");
    }

    #[test]
    #[should_panic(expected = "is not one field element")]
    fn a_public_parameter_that_is_not_one_field_element_fails() {
        let abi = ABI.replace(
            "{\"name\": \"context_hash\", \"type\": {\"kind\": \"field\"}, \"visibility\": \"public\"}",
            "{\"name\": \"context_hash\", \"type\": {\"kind\": \"array\", \"length\": 2, \
             \"type\": {\"kind\": \"field\"}}, \"visibility\": \"public\"}",
        );
        public_input_layout(&write_temp("zkpor_layout_array.json", &abi));
    }
}
