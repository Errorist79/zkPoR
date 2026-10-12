//! Shared Poseidon2 hashing and subtree folding for the recursion circuits.
//!
//! Both the inner batch circuit and the aggregator build a full binary
//! Poseidon2 tree (inner: over customer leaves; aggregator: over the batch
//! subroots), so the fold lives here once rather than in each circuit.

use dep::poseidon::poseidon2::Poseidon2;

// The batch size lives here, and not in each circuit, so the inner circuit and
// every adversarial circuit read one generated value and cannot drift apart.
pub mod params;

// Binary Merkle tree => arity 2 for every internal node. This must match
// `node_hash_arity` in params.toml (which drives the off-circuit generator).
pub global NODE_HASH_ARITY: u32 = 2;

// Each commitment and leaf takes three inputs. A node takes two inputs.
pub global LEAF_HASH_ARITY: u32 = 3;
pub global BALANCE_DOMAIN_TAG: Field = 0x7a6b706f722d62616c616e63652d7631;
pub global LEAF_DOMAIN_TAG: Field = 0x7a6b706f722d6c6561662d7632;
pub global PADDING_LEAF_ID: Field = 0;
pub global PADDING_LEAF_BALANCE: u64 = 0;

pub fn hash2(a: Field, b: Field) -> Field {
    Poseidon2::hash([a, b], NODE_HASH_ARITY)
}

pub fn balance_commitment(balance: u64, salt: Field) -> Field {
    Poseidon2::hash([BALANCE_DOMAIN_TAG, balance as Field, salt], LEAF_HASH_ARITY)
}

pub fn leaf_hash(id: Field, commitment: Field) -> Field {
    Poseidon2::hash([LEAF_DOMAIN_TAG, id, commitment], LEAF_HASH_ARITY)
}

/// Root of a full binary tree over M (power-of-two, >= 2) leaves.
///
/// Heap layout in `nodes[1..2M)`: leaves occupy `[M, 2M)` and each internal
/// node `i` is `hash2(nodes[2i], nodes[2i+1])`, filled from `M-1` down to `1`,
/// so every loop bound is a compile-time constant.
pub fn subtree_root<let M: u32>(leaves: [Field; M]) -> Field {
    let mut nodes = [0; 2 * M];
    for j in 0..M {
        nodes[M + j] = leaves[j];
    }
    for i in 0..(M - 1) {
        let idx = M - 1 - i;
        nodes[idx] = hash2(nodes[2 * idx], nodes[2 * idx + 1]);
    }
    nodes[1]
}

#[test]
fn subtree_root_matches_manual_two_leaf() {
    let a = leaf_hash(1, balance_commitment(100, 11));
    let b = leaf_hash(2, balance_commitment(200, 22));
    assert(subtree_root([a, b]) == hash2(a, b));
}

#[test]
fn subtree_root_is_leaf_sensitive() {
    let a = leaf_hash(1, balance_commitment(100, 11));
    let b = leaf_hash(2, balance_commitment(200, 22));
    let c = leaf_hash(2, balance_commitment(201, 22));
    assert(subtree_root([a, b]) != subtree_root([a, c]));
}

#[test]
fn leaf_hash_is_salt_sensitive() {
    assert(balance_commitment(100, 11) != balance_commitment(100, 12));
}

#[test]
fn leaf_hash_matches_the_committed_vector() {
    // The "a customer leaf" case of "leaves" in
    // fixtures/context_vectors.json. The Rust crate writes that file, so this
    // test pins the two implementations to one value instead of to a
    // procedure that someone must remember to run.
    let commitment = balance_commitment(100, 2);
    assert(commitment == 0x0982f67e7435b6aa2e1ff6e716c06d3020a67a35d781682e07b90a8b8f7c019e);
    let leaf = leaf_hash(7, commitment);
    assert(leaf == 0x1d6d63fed6b92b3c2b042e452552a3481e4b4af2aef82dee3fc7e46d96d69d3c);
}

#[test]
fn a_leaf_is_not_a_node() {
    assert(leaf_hash(1, balance_commitment(100, 11)) != hash2(1, 100));
}
