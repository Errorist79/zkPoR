//! Off-circuit driver for the recursive-aggregation circuits (inner + agg).
//!
//! Three subcommands split the work around the bb proving step:
//!
//!   witness   Reads params.toml, the attestation context, and a customer
//!             file, pads the customer list to the tree capacity, derives one
//!             salt per leaf, computes each batch's Poseidon2 subroot and u128
//!             subtotal, and writes
//!               - common/src/params.nr       (BATCH_B)
//!               - inner/Prover_<k>.toml      (one per batch)
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
use std::{collections::HashMap, env, fs, path::Path, path::PathBuf, process::Command};
use zkpor_context::{
    context_hash, derive_salt, fr_reduce, leaf_hash, node_hash, reserve_set_hash, FR_BYTES,
    PADDING_LEAF_BALANCE, PADDING_LEAF_ID,
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

/// (id, balance) rows from a customer file. A comment line and the header line
/// are dropped.
fn read_customers(path: &Path) -> Vec<(BigUint, u64)> {
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

/// Root of a full binary tree over `leaves` (len a power of two, >= 2).
/// Pairwise bottom-up; identical pairing order to common/lib.nr subtree_root.
fn subtree_root(env: &Env, leaves: &[U256]) -> U256 {
    let mut level: Vec<U256> = leaves.to_vec();
    while level.len() > 1 {
        level = (0..level.len() / 2)
            .map(|k| node_hash(env, &level[2 * k], &level[2 * k + 1]))
            .collect();
    }
    level.into_iter().next().expect("non-empty tree")
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

/// The value that binds the proof to one authority, one asset, one reserve
/// address set, and one snapshot.
fn read_context_hash(env: &Env, path: &Path) -> U256 {
    let pairs = read_pairs(path);
    let mut reserves = SorobanVec::new(env);
    for strkey in list_value(&pairs, "reserves") {
        reserves.push_back(address(env, &strkey));
    }
    let set = reserve_set_hash(env, &reserves).expect("the reserve set is not valid");
    let snapshot_ledger = u64_value(&pairs, "snapshot_ledger");
    let snapshot_ledger = u32::try_from(snapshot_ledger).expect("snapshot_ledger is a u32");
    context_hash(
        env,
        &address(env, &text_value(&pairs, "authority")),
        &address(env, &text_value(&pairs, "asset")),
        &set,
        snapshot_ledger,
    )
    .expect("the context addresses are not valid")
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
    fr_reduce(env, &hex_bytes(raw))
}

fn hex_bytes(text: &str) -> [u8; FR_BYTES] {
    assert_eq!(
        text.len(),
        FR_BYTES * 2,
        "{MASTER_SECRET_VAR} must be 32 bytes of hex"
    );
    let mut out = [0u8; FR_BYTES];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&text[2 * i..2 * i + 2], 16)
            .unwrap_or_else(|_| panic!("{MASTER_SECRET_VAR} is not hex"));
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

fn cmd_witness(context_file: &Path, customers_file: &Path) {
    let (b, k, capacity) = read_shape();
    let env = new_env();
    let context = read_context_hash(&env, context_file);
    let master_secret = read_master_secret(&env);
    let rows = pad_to_capacity(read_customers(customers_file), capacity);

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
            let global_index = (batch * b + j) as u64;
            let (id, balance) = &rows[batch * b + j];
            let id_fr = to_fr(&env, id);
            let salt = derive_salt(&env, &master_secret, &context, global_index);
            leaves.push(leaf_hash(&env, &id_fr, *balance, &salt));
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
    let context = read_context_hash(&env, context_file);

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
                            recursion-gen assemble <context.toml> [out_dir]\n\
                            recursion-gen manifest <inner_out_dir> <agg_target_dir>";

fn main() {
    let args: Vec<String> = env::args().collect();
    let arg = |i: usize| args.get(i).map(PathBuf::from);
    match args.get(1).map(String::as_str) {
        Some("witness") => match (arg(2), arg(3)) {
            (Some(context), Some(customers)) => cmd_witness(&context, &customers),
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
