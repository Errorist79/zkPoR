//! Adversarial inner batch circuit (negative tests only; NOT production).
//!
//! Identical public layout to the pinned inner circuit
//! (batch_slot, subroot, subtotal) and the same salted three-input leaf, but
//! with the u64 range check REMOVED: balances are bare Field and the sum is a
//! Field sum, so a negative / field-wrapped balance passes silently and
//! deflates the subtotal (the Binance-class "dummy user" hole at batch
//! granularity).
//!
//! It adopts the salted leaf on purpose. A rejection then means the attack
//! failed, and not that the leaf format was stale.
//!
//! subroot/subtotal are computed and returned (rather than asserted against
//! inputs) so a cheat batch is self-consistent without an off-circuit oracle.
//! This circuit's verification key differs from the pinned inner circuit's, so
//! the hardened aggregator's vk-hash binding must reject every proof made here.

use dep::recursion_common::params::BATCH_B;
use dep::poseidon::poseidon2::Poseidon2;
use dep::recursion_common::{leaf_hash, subtree_root, BALANCE_DOMAIN_TAG, LEAF_HASH_ARITY};

fn main(
    batch_slot: pub Field,
    ids: [Field; BATCH_B],
    balances: [Field; BATCH_B],
    salts: [Field; BATCH_B],
) -> pub (Field, Field) {
    let _ = batch_slot;
    let mut leaves = [0; BATCH_B];
    let mut sum: Field = 0;
    for j in 0..BATCH_B {
        let commitment = Poseidon2::hash([BALANCE_DOMAIN_TAG, balances[j], salts[j]], LEAF_HASH_ARITY);
        leaves[j] = leaf_hash(ids[j], commitment); // no range check: bare Field
        sum += balances[j];
    }
    (subtree_root(leaves), sum)
}
