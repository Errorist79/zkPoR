//! Inner batch circuit for recursive proof aggregation.
//!
//! Proves one customer batch: hashes BATCH_B (id, balance) leaves into a full
//! Poseidon2 binary subtree and sums the balances, binding the result to the
//! public (batch_slot, subroot, subtotal). An aggregator recursively verifies
//! many of these and composes their subroots / subtotals into one on-chain
//! proof.
//!
//! Public inputs : batch_slot, subroot, subtotal
//! Private inputs: per customer { id, balance: u64 }
//!
//! Leaf definition matches the off-circuit generator:
//!   leaf = Poseidon2([id, balance], 2)
//!
//! This is proven with the poseidon2 oracle + honk_recursion so the aggregator
//! can verify it in-circuit (the bb flags live in the proving orchestrator).
//!
//! Security: balance is u64, not a bare Field (a Field wraps mod p and is not
//! non-negative, so a wrapped/negative balance would pass silently); the sum
//! accumulates in u128 so BATCH_B u64 additions cannot overflow. batch_slot is
//! a public input with no in-batch constraint: it commits the slot into the
//! proof so the aggregator can pin each proof to one slot and reject replays.

use dep::recursion_common::{leaf_hash, subtree_root};

mod params;
use params::BATCH_B;

fn main(
    batch_slot: pub Field,
    subroot: pub Field,
    subtotal: pub Field,
    ids: [Field; BATCH_B],
    balances: [u64; BATCH_B],
) {
    let _ = batch_slot; // bound as a public input (anti-replay); see header
    let mut leaves = [0; BATCH_B];
    let mut sum: u128 = 0;
    for j in 0..BATCH_B {
        let balance = balances[j]; // u64: non-negative, < 2^64
        leaves[j] = leaf_hash(ids[j], balance as Field);
        sum += balance as u128; // u128 accumulator, no overflow
    }
    assert(subtree_root(leaves) == subroot); // leaves hash to the committed subroot
    assert(sum == subtotal as u128); // committed subtotal equals the batch sum
}

#[test]
fn accepts_consistent_batch() {
    let mut ids = [0; BATCH_B];
    let mut balances = [0; BATCH_B];
    let mut leaves = [0; BATCH_B];
    let mut sum: u128 = 0;
    for j in 0..BATCH_B {
        ids[j] = (j as Field) + 1;
        balances[j] = (j as u64) + 1;
        leaves[j] = leaf_hash(ids[j], balances[j] as Field);
        sum += balances[j] as u128;
    }
    main(0, subtree_root(leaves), sum as Field, ids, balances);
}

#[test(should_fail)]
fn rejects_wrong_subtotal() {
    let mut ids = [0; BATCH_B];
    let mut balances = [0; BATCH_B];
    let mut leaves = [0; BATCH_B];
    for j in 0..BATCH_B {
        ids[j] = (j as Field) + 1;
        balances[j] = (j as u64) + 1;
        leaves[j] = leaf_hash(ids[j], balances[j] as Field);
    }
    // Correct subroot but a deliberately wrong subtotal must fail.
    main(0, subtree_root(leaves), 0, ids, balances);
}
