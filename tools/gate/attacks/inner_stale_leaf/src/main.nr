//! Adversarial inner batch circuit (negative tests only; NOT production).
//!
//! It keeps every constraint of the pinned inner circuit and changes one
//! thing: the leaf stays the old two-input hash of the identifier and the
//! balance, so the circuit takes the salts and ignores them. An unsalted leaf
//! has low entropy, so a customer who holds an inclusion package can search
//! the sibling hashes for the balances of other customers.
//!
//! This is the pinning attack. The circuit is honest about the total, so no
//! in-circuit constraint of the aggregator can catch it. Only the pinned inner
//! verification key hash rejects it, which is the property under test.
//!
//! subroot/subtotal are computed and returned (rather than asserted against
//! inputs) so the batch is self-consistent without an off-circuit oracle.

use dep::recursion_common::params::BATCH_B;
use dep::recursion_common::{hash2, subtree_root};

fn main(
    batch_slot: pub Field,
    ids: [Field; BATCH_B],
    balances: [u64; BATCH_B],
    salts: [Field; BATCH_B],
) -> pub (Field, Field) {
    let _ = batch_slot;
    let _ = salts; // the attack: the salt enters the witness and not the leaf
    let mut leaves = [0; BATCH_B];
    let mut sum: u128 = 0;
    for j in 0..BATCH_B {
        let balance = balances[j];
        leaves[j] = hash2(ids[j], balance as Field); // the old two-input leaf
        sum += balance as u128;
    }
    (subtree_root(leaves), sum as Field)
}
