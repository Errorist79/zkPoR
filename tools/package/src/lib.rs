//! The inclusion package: its format, the tree behind it, and the deployment
//! records that say where it points.
//!
//! One customer file travels from the authority to one customer. The authority
//! tooling writes it and the customer tooling reads it, so both sides read the
//! format from here and neither side holds a second copy of it.
//!
//! Every hash comes from zkpor-context, which is the one Rust definition of
//! the leaf, the node, the salt, and the context hash.

pub mod deployments;
pub mod fr;
pub mod schema;
pub mod tree;

use soroban_sdk::Env;

/// The host environment that the hash functions need.
///
/// The host meters every call, and the limit it starts with is the limit of
/// one transaction. A tool folds a whole tree in one process and no
/// transaction carries that work, so the metering does not apply here.
pub fn new_env() -> Env {
    let env = Env::default();
    env.cost_estimate().budget().reset_unlimited();
    env
}
