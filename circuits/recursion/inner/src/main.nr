//! Inner batch circuit for recursive proof aggregation.
//!
//! Proves one customer batch: hashes BATCH_B (id, balance, salt) leaves into a
//! full Poseidon2 binary subtree and sums the balances, binding the result to
//! the public (batch_slot, subroot, subtotal). An aggregator recursively
//! verifies many of these and composes their subroots / subtotals into one
//! on-chain proof.
//!
//! Public inputs : batch_slot, subroot, subtotal
//! Private inputs: per customer { id, balance: u64, salt }
//!
//! Leaf definition matches the off-circuit generator:
//!   leaf = Poseidon2([id, balance, salt], 3)
//!
//! The salt is an unconstrained Field on purpose. It is a commitment input and
//! not an amount, so a range constraint would only shrink the entropy that the
//! salt exists to give. The generator derives it from a secret the circuit
//! never sees.
//!
//! This is proven with the poseidon2 oracle + honk_recursion so the aggregator
//! can verify it in-circuit (the bb flags live in the proving orchestrator).
//!
//! Security: balance is u64, not a bare Field (a Field wraps mod p and is not
//! non-negative, so a wrapped/negative balance would pass silently); the sum
//! accumulates in u128 so BATCH_B u64 additions cannot overflow. batch_slot is
//! a public input with no in-batch constraint: it commits the slot into the
//! proof so the aggregator can pin each proof to one slot and reject replays.

use dep::recursion_common::params::BATCH_B;
use dep::recursion_common::{leaf_hash, subtree_root};

fn main(
    batch_slot: pub Field,
    subroot: pub Field,
    subtotal: pub Field,
    ids: [Field; BATCH_B],
    balances: [u64; BATCH_B],
    salts: [Field; BATCH_B],
) {
    let _ = batch_slot; // bound as a public input (anti-replay); see header
    let mut leaves = [0; BATCH_B];
    let mut sum: u128 = 0;
    for j in 0..BATCH_B {
        let balance = balances[j]; // u64: non-negative, < 2^64
        leaves[j] = leaf_hash(ids[j], balance as Field, salts[j]);
        sum += balance as u128; // u128 accumulator, no overflow
    }
    assert(subtree_root(leaves) == subroot, "the leaves do not hash to the subroot");
    // The comparison happens in the field, and not after a cast of subtotal to
    // u128. A cast truncates, so it would also accept sum + t * 2^128 for any
    // t, and the public input would then carry a value that is not the sum.
    assert(subtotal == sum as Field, "the subtotal is not the batch sum");
}

/// One consistent batch: identifiers, balances, salts, leaves, and the sum.
fn sample_batch() -> ([Field; BATCH_B], [u64; BATCH_B], [Field; BATCH_B], [Field; BATCH_B], u128) {
    let mut ids = [0; BATCH_B];
    let mut balances = [0; BATCH_B];
    let mut salts = [0; BATCH_B];
    let mut leaves = [0; BATCH_B];
    let mut sum: u128 = 0;
    for j in 0..BATCH_B {
        ids[j] = (j as Field) + 1;
        balances[j] = (j as u64) + 1;
        salts[j] = (j as Field) + 1000;
        leaves[j] = leaf_hash(ids[j], balances[j] as Field, salts[j]);
        sum += balances[j] as u128;
    }
    (ids, balances, salts, leaves, sum)
}

#[test]
fn accepts_consistent_batch() {
    let (ids, balances, salts, leaves, sum) = sample_batch();
    main(0, subtree_root(leaves), sum as Field, ids, balances, salts);
}

#[test(should_fail_with = "the subtotal is not the batch sum")]
fn rejects_wrong_subtotal() {
    let (ids, balances, salts, leaves, _) = sample_batch();
    // Correct subroot but a deliberately wrong subtotal must fail.
    main(0, subtree_root(leaves), 0, ids, balances, salts);
}

#[test(should_fail_with = "the subtotal is not the batch sum")]
fn rejects_non_canonical_subtotal() {
    let (ids, balances, salts, leaves, sum) = sample_batch();
    // sum + 2^128 truncates to sum in a u128 cast, so the field comparison is
    // the only thing that rejects this value.
    let shifted = (sum as Field) + 0x100000000000000000000000000000000;
    main(0, subtree_root(leaves), shifted, ids, balances, salts);
}

#[test(should_fail_with = "the leaves do not hash to the subroot")]
fn rejects_wrong_salt() {
    let (ids, balances, mut salts, leaves, sum) = sample_batch();
    // The committed subroot holds the leaves of the derived salts, so one
    // changed salt must break the subroot equality.
    salts[0] += 1;
    main(0, subtree_root(leaves), sum as Field, ids, balances, salts);
}
