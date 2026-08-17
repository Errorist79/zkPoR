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

// A leaf takes an identifier, a balance, and a salt. The Poseidon2 sponge
// capacity holds the input count, so the three-input leaf and the two-input
// node cannot collide and the leaf needs no domain tag.
pub global LEAF_HASH_ARITY: u32 = 3;

pub fn hash2(a: Field, b: Field) -> Field {
    Poseidon2::hash([a, b], NODE_HASH_ARITY)
}

pub fn leaf_hash(id: Field, balance: Field, salt: Field) -> Field {
    Poseidon2::hash([id, balance, salt], LEAF_HASH_ARITY)
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
    let a = leaf_hash(1, 100, 11);
    let b = leaf_hash(2, 200, 22);
    assert(subtree_root([a, b]) == hash2(a, b));
}

#[test]
fn subtree_root_is_leaf_sensitive() {
    let a = leaf_hash(1, 100, 11);
    let b = leaf_hash(2, 200, 22);
    let c = leaf_hash(2, 201, 22);
    assert(subtree_root([a, b]) != subtree_root([a, c]));
}

#[test]
fn leaf_hash_is_salt_sensitive() {
    assert(leaf_hash(1, 100, 11) != leaf_hash(1, 100, 12));
}

#[test]
fn leaf_hash_matches_the_committed_vector() {
    // The "a customer leaf" case of "leaves" in
    // fixtures/context_vectors.json. The Rust crate writes that file, so this
    // test pins the two implementations to one value instead of to a
    // procedure that someone must remember to run.
    let leaf = leaf_hash(7, 100, 2);
    assert(leaf == 0x11ba8698c99aed60de41ec057d268ea087fc9e1bcbebee96502a1bd62959bcde);
}

#[test]
fn a_leaf_is_not_a_node() {
    // The capacity separates the two input counts, so a prover cannot present
    // an internal node as a leaf.
    assert(leaf_hash(1, 100, 11) != hash2(1, 100));
}
