//! Off-circuit driver for the recursive-aggregation circuits (inner + agg).
//!
//! Two subcommands split the work around the bb proving step:
//!
//!   witness   Reads params.toml + fixtures/customers.csv, splits the first
//!             K*B customers into K batches of B, computes each batch's
//!             Poseidon2 subroot and u128 subtotal, and writes
//!               - inner/src/params.nr        (BATCH_B)
//!               - inner/Prover_<k>.toml       (one per batch)
//!
//!   assemble  Run AFTER bb has proven every inner batch. Reads the bb field
//!             outputs (out/vk_fields.json + out/batch_<k>/*_fields.json) and writes
//!               - agg/src/params.nr           (K + observed inner pub layout +
//!                                              the pinned inner-vk hash)
//!               - agg/Prover.toml             (vk, K proofs+pubs)
//!             The inner public-input vector that bb emits for a
//!             honk_recursion proof may carry a pairing-point accumulator, so
//!             (batch_slot, subroot, subtotal) are LOCATED BY VALUE rather than
//!             assumed at fixed indices; their positions and the vector length
//!             are written back into agg/src/params.nr. The pinned inner-vk hash
//!             is the Poseidon2 binary-tree hash of the zero-padded vk fields.
//!
//! Poseidon2 is soroban-poseidon (the same permutation the on-chain side and
//! the noir poseidon v0.2.0 dependency use), so the subroot computed here equals
//! the one the inner circuit rebuilds.
//!
//! Leaf formula MUST stay identical to the inner circuit's leaf_hash:
//!   leaf = Poseidon2([id, balance], 2)

use num_bigint::BigUint;
use soroban_poseidon::{poseidon2_hash, Field};
use soroban_sdk::{crypto::BnScalar, Bytes, Env, Vec as SorobanVec, U256};
use std::{collections::HashMap, env, fs, path::Path, path::PathBuf};

// Resolve a path relative to the repo root. CARGO_MANIFEST_DIR is
// <repo>/tools/recursion-gen, so ../.. is the repo root and `rel` is taken
// from there (e.g. circuits/recursion/...).
fn repo_path(rel: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..").join(rel)
}

fn read_kv(path: &Path) -> HashMap<String, u64> {
    let mut m = HashMap::new();
    for line in fs::read_to_string(path).expect("read config").lines() {
        let line = line.split('#').next().unwrap_or("").trim();
        if let Some((k, v)) = line.split_once('=') {
            m.insert(k.trim().to_string(), v.trim().parse::<u64>().expect("u64 value"));
        }
    }
    m
}

/// (id, balance) rows from the customers fixture, header skipped.
fn read_customers(path: &Path) -> Vec<(BigUint, u64)> {
    let mut rows = Vec::new();
    for (i, line) in fs::read_to_string(path).expect("read customers.csv").lines().enumerate() {
        let line = line.trim();
        if i == 0 || line.is_empty() {
            continue; // header / blank
        }
        let (id, bal) = line.split_once(',').expect("id,balance");
        let id = id.trim().parse::<BigUint>().expect("id is a non-negative integer");
        let bal = bal.trim().parse::<u64>().expect("balance is u64");
        rows.push((id, bal));
    }
    rows
}

fn be32(x: &BigUint) -> [u8; 32] {
    let mut be = x.to_bytes_be();
    if be.len() > 32 {
        be = be[be.len() - 32..].to_vec();
    }
    let mut out = [0u8; 32];
    out[32 - be.len()..].copy_from_slice(&be);
    out
}

fn field_hash2(env: &Env, a: &BigUint, b: &BigUint) -> BigUint {
    let a_bytes = Bytes::from_array(env, &be32(a));
    let b_bytes = Bytes::from_array(env, &be32(b));
    let modulus = <BnScalar as Field>::modulus(env);
    let mut inputs = SorobanVec::new(env);
    inputs.push_back(U256::from_be_bytes(env, &a_bytes).rem_euclid(&modulus));
    inputs.push_back(U256::from_be_bytes(env, &b_bytes).rem_euclid(&modulus));
    let out = poseidon2_hash::<4, BnScalar>(env, &inputs);
    let mut out_arr = [0u8; 32];
    out.to_be_bytes().copy_into_slice(&mut out_arr);
    BigUint::from_bytes_be(&out_arr)
}

/// Root of a full binary tree over `leaves` (len a power of two, >= 2).
/// Pairwise bottom-up; identical pairing order to common/lib.nr subtree_root.
fn subtree_root(env: &Env, leaves: &[BigUint]) -> BigUint {
    let mut level: Vec<BigUint> = leaves.to_vec();
    while level.len() > 1 {
        level = (0..level.len() / 2)
            .map(|k| field_hash2(env, &level[2 * k], &level[2 * k + 1]))
            .collect();
    }
    level.into_iter().next().expect("non-empty tree")
}

fn fmt_field_array(values: &[BigUint]) -> String {
    let items: Vec<String> = values.iter().map(|v| format!("\"{v}\"")).collect();
    format!("[{}]", items.join(", "))
}

/// (subroots, subtotals) for the K batches, computed from the fixture.
/// Shared by `witness` (to fill Prover.toml) and `assemble` (to locate the
/// subroot/subtotal positions inside bb's public-input vector by value).
fn batch_commitments(env: &Env, b: usize, k: usize) -> (Vec<BigUint>, Vec<BigUint>) {
    let customers = read_customers(&repo_path("circuits/recursion/inner/fixtures/customers.csv"));
    assert!(customers.len() >= b * k, "fixture has {} customers, need {}", customers.len(), b * k);

    let mut subroots = Vec::with_capacity(k);
    let mut subtotals = Vec::with_capacity(k);
    for batch in 0..k {
        let mut leaves = Vec::with_capacity(b);
        let mut sum: u128 = 0;
        for j in 0..b {
            let (id, bal) = &customers[batch * b + j];
            leaves.push(field_hash2(env, id, &BigUint::from(*bal)));
            sum += *bal as u128;
        }
        subroots.push(subtree_root(env, &leaves));
        subtotals.push(BigUint::from(sum));
    }
    (subroots, subtotals)
}

fn new_env() -> Env {
    let env = Env::default();
    env.cost_estimate().budget().reset_unlimited();
    env
}

fn cmd_witness() {
    let cfg = read_kv(&repo_path("circuits/recursion/params.toml"));
    let b = *cfg.get("batch_b").expect("missing batch_b") as usize;
    let k = *cfg.get("num_batches_k").expect("missing num_batches_k") as usize;
    let arity = *cfg.get("hash_arity").expect("missing hash_arity") as usize;
    assert_eq!(arity, 2, "only binary (arity 2) Poseidon2 is supported");
    assert!(b >= 2 && b.is_power_of_two(), "batch_b must be a power of two >= 2");
    assert!(k >= 2 && k.is_power_of_two(), "num_batches_k must be a power of two >= 2");

    fs::write(
        repo_path("circuits/recursion/inner/src/params.nr"),
        format!(
            "// Generated from params.toml by tools/recursion-gen. Do not edit by hand.\n\
             pub global BATCH_B: u32 = {b};\n"
        ),
    )
    .expect("write inner/src/params.nr");

    let customers = read_customers(&repo_path("circuits/recursion/inner/fixtures/customers.csv"));
    let env = new_env();
    let (subroots, subtotals) = batch_commitments(&env, b, k);

    for batch in 0..k {
        let ids: Vec<BigUint> = (0..b).map(|j| customers[batch * b + j].0.clone()).collect();
        let balances: Vec<String> =
            (0..b).map(|j| format!("\"{}\"", customers[batch * b + j].1)).collect();
        let toml = format!(
            "batch_slot = \"{batch}\"\nsubroot = \"{}\"\nsubtotal = \"{}\"\nids = {}\nbalances = [{}]\n",
            subroots[batch],
            subtotals[batch],
            fmt_field_array(&ids),
            balances.join(", "),
        );
        fs::write(repo_path(&format!("circuits/recursion/inner/Prover_{batch}.toml")), toml)
            .expect("write inner Prover_<k>.toml");
    }
    println!("witness: B={b} K={k} -> inner/src/params.nr + {k} inner Prover_<k>.toml");
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

fn find_index(v: &[BigUint], target: &BigUint, what: &str) -> usize {
    v.iter().position(|x| x == target).unwrap_or_else(|| panic!("{what} not found in public inputs"))
}

fn cmd_assemble(out: &Path) {
    let cfg = read_kv(&repo_path("circuits/recursion/params.toml"));
    let b = *cfg.get("batch_b").expect("missing batch_b") as usize;
    let k = *cfg.get("num_batches_k").expect("missing num_batches_k") as usize;

    let env = new_env();
    let (subroots, subtotals) = batch_commitments(&env, b, k);

    let vk = read_field_json(&out.join("vk_fields.json"));

    let mut proofs: Vec<Vec<BigUint>> = Vec::with_capacity(k);
    let mut pubs: Vec<Vec<BigUint>> = Vec::with_capacity(k);
    let (mut pub_len, mut slot_idx, mut subroot_idx, mut subtotal_idx) =
        (0usize, 0usize, 0usize, 0usize);
    for batch in 0..k {
        let proof = read_field_json(&out.join(format!("batch_{batch}/proof_fields.json")));
        let pi = read_field_json(&out.join(format!("batch_{batch}/public_inputs_fields.json")));
        // batch_slot value is the batch index; located by value like the others
        // so any pairing points bb may append do not shift the layout.
        let l_idx = find_index(&pi, &BigUint::from(batch), "batch_slot");
        let s_idx = find_index(&pi, &subroots[batch], "subroot");
        let t_idx = find_index(&pi, &subtotals[batch], "subtotal");
        if batch == 0 {
            pub_len = pi.len();
            slot_idx = l_idx;
            subroot_idx = s_idx;
            subtotal_idx = t_idx;
        } else {
            assert_eq!(pi.len(), pub_len, "inner public-input length differs across batches");
            assert_eq!(l_idx, slot_idx, "batch_slot index differs across batches");
            assert_eq!(s_idx, subroot_idx, "subroot index differs across batches");
            assert_eq!(t_idx, subtotal_idx, "subtotal index differs across batches");
        }
        proofs.push(proof);
        pubs.push(pi);
    }

    // Constraint 1 commitment: Poseidon2 binary-tree hash of the inner vk fields,
    // zero-padded to a power of two, matching the aggregator's in-circuit hash.
    let vk_commit_width = vk.len().next_power_of_two();
    let mut padded = vk.clone();
    padded.resize(vk_commit_width, BigUint::from(0u32));
    let pinned_vk_hash = subtree_root(&env, &padded);

    fs::write(
        repo_path("circuits/recursion/agg/src/params.nr"),
        format!(
            "// Generated from params.toml + observed bb output by tools/recursion-gen.\n\
             // Do not edit by hand.\n\
             pub global NUM_BATCHES_K: u32 = {k};\n\
             // Inner public-input vector length and the positions of (batch_slot,\n\
             // subroot, subtotal) within it. The generator locates these by value, so\n\
             // the layout bb emits for a honk_recursion proof (with any appended pairing\n\
             // points) is handled without editing circuit logic.\n\
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
    let mut toml = String::new();
    toml.push_str(&format!("inner_vk = {}\n", fmt_field_array(&vk)));
    let proof_rows: Vec<String> = proofs.iter().map(|p| fmt_field_array(p)).collect();
    toml.push_str(&format!("proofs = [{}]\n", proof_rows.join(", ")));
    let pub_rows: Vec<String> = pubs.iter().map(|p| fmt_field_array(p)).collect();
    toml.push_str(&format!("pub_inputs = [{}]\n", pub_rows.join(", ")));
    fs::write(repo_path("circuits/recursion/agg/Prover.toml"), toml).expect("write agg/Prover.toml");

    println!(
        "assemble: K={k} VK_LEN={} PROOF_LEN={} INNER_PUB_LEN={pub_len} \
         SLOT_IDX={slot_idx} SUBROOT_IDX={subroot_idx} SUBTOTAL_IDX={subtotal_idx} \
         VK_COMMIT_WIDTH={vk_commit_width} -> agg/src/params.nr + agg/Prover.toml",
        vk.len(),
        proofs[0].len(),
    );
}

fn main() {
    let args: Vec<String> = env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("witness") => cmd_witness(),
        Some("assemble") => {
            let out = args.get(2).map(PathBuf::from).unwrap_or_else(|| {
                repo_path("circuits/recursion/inner/out")
            });
            cmd_assemble(&out);
        }
        _ => {
            eprintln!("usage: recursion-gen <witness | assemble [out_dir]>");
            std::process::exit(2);
        }
    }
}
