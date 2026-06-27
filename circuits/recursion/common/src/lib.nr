//! Shared Poseidon2 hashing and subtree folding for the recursion circuits.
//!
//! Both the inner batch circuit and the aggregator build a full binary
//! Poseidon2 tree (inner: over customer leaves; aggregator: over the batch
//! subroots), so the fold lives here once rather than in each circuit.

use dep::poseidon::poseidon2::Poseidon2;

// Binary Merkle tree => arity 2. This fixes the 2-input hash below; it must
// match `hash_arity` in params.toml (which drives the off-circuit generator).
pub global HASH_ARITY: u32 = 2;

pub fn hash2(a: Field, b: Field) -> Field {
    Poseidon2::hash([a, b], HASH_ARITY)
}

pub fn leaf_hash(id: Field, balance: Field) -> Field {
    Poseidon2::hash([id, balance], HASH_ARITY)
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
    let a = leaf_hash(1, 100);
    let b = leaf_hash(2, 200);
    assert(subtree_root([a, b]) == hash2(a, b));
}

#[test]
fn subtree_root_is_leaf_sensitive() {
    let a = leaf_hash(1, 100);
    let b = leaf_hash(2, 200);
    let c = leaf_hash(2, 201);
    assert(subtree_root([a, b]) != subtree_root([a, c]));
}
