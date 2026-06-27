//! Adversarial inner batch circuit (negative tests only; NOT production).
//!
//! Identical public layout to the pinned inner circuit
//! (batch_slot, subroot, subtotal) but with the u64 range check REMOVED:
//! balances are bare Field and the sum is a Field sum, so a negative /
//! field-wrapped balance passes silently and deflates the subtotal (the
//! Binance-class "dummy user" hole at batch granularity).
//!
//! subroot/subtotal are computed and returned (rather than asserted against
//! inputs) so a cheat batch is self-consistent without an off-circuit oracle.
//! This circuit's verification key differs from the pinned inner circuit's, so
//! the hardened aggregator's vk-hash binding must reject every proof made here.

use dep::recursion_common::{leaf_hash, subtree_root};

mod params;
use params::BATCH_B;

fn main(
    batch_slot: pub Field,
    ids: [Field; BATCH_B],
    balances: [Field; BATCH_B],
) -> pub (Field, Field) {
    let _ = batch_slot;
    let mut leaves = [0; BATCH_B];
    let mut sum: Field = 0;
    for j in 0..BATCH_B {
        leaves[j] = leaf_hash(ids[j], balances[j]); // no range check: bare Field
        sum += balances[j];
    }
    (subtree_root(leaves), sum)
}
