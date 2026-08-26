//! The customer check of one inclusion package.
//!
//! The check is a recomputation and not a proof. It rebuilds the leaf from the
//! customer's own values, walks the siblings, and compares the result with the
//! root that the registry holds. No circuit runs and no transaction runs.
//!
//! One rule governs every package field that names a place. A package value
//! may select a record inside data that the verifier already trusts. It must
//! never select where trusted data comes from. The registry addresses come
//! from the verifier's own copy of the deployments file, and the endpoint
//! comes from the verifier's own configuration. The `network` and `registry`
//! fields of the package are claims that this module checks against that
//! data, and it reads nothing from a registry that the package alone names.

pub mod chain;

use chain::{Chain, Entry, NoVerdict};
use soroban_sdk::Env;
use zkpor_context::{leaf_hash, ATTESTATION_MAX_AGE_LEDGERS};
use zkpor_package::{
    deployments::{self, DeploymentsError},
    fr::{fr_hex, to_big, to_fr},
    schema::{self, PackageError},
    tree::root_from_path,
};

/// What the verifier concludes about one package.
///
/// Each reason stays distinct. A caller must not merge two of them, because
/// each one asks the customer for a different action.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    /// The leaf sits under the root that the chain accepted.
    Included {
        balance: u64,
        leaf_index: u32,
        asset: String,
        registry: String,
        snapshot_ledger: u32,
        attested_ledger: u32,
        latest_ledger: u32,
        total_liabilities: u128,
    },
    /// The file states a format that this reader does not know.
    UnsupportedFormat(String),
    /// The file is not a package of the format that this reader knows.
    Malformed(String),
    /// The network and the registry of the package match no deployment record
    /// of the verifier.
    UntrustedDeployment { network: String, registry: String },
    /// The deployment records of the verifier contradict themselves, so the
    /// trust root answers nothing. This is a fault of the verifier's own file,
    /// and it says nothing about the package.
    InvalidDeployments(String),
    /// The registry holds no attestation that the package can name.
    NoMatchingAttestation(String),
    /// The walk of the path reaches another value than the attested root.
    RootMismatch {
        recomputed: String,
        attested: String,
    },
}

impl Verdict {
    /// True when the attestation is older than the window of the protocol.
    ///
    /// Inclusion and solvency currency are different claims. A stale
    /// attestation still holds the leaf, and its solvency claim has lapsed
    /// until a fresher attestation replaces it.
    pub fn solvency_lapsed(&self) -> bool {
        match self {
            Self::Included {
                attested_ledger,
                latest_ledger,
                ..
            } => *latest_ledger > attested_ledger.saturating_add(ATTESTATION_MAX_AGE_LEDGERS),
            _ => false,
        }
    }

    /// The verdict as the customer reads it, one statement to a line.
    pub fn lines(&self) -> Vec<String> {
        match self {
            Self::Included {
                balance,
                leaf_index,
                asset,
                registry,
                snapshot_ledger,
                attested_ledger,
                latest_ledger,
                total_liabilities,
            } => {
                let mut lines = vec![
                    format!(
                        "INCLUDED: the balance {balance} sits at leaf {leaf_index} of the \
                         liabilities tree that the registry {registry} accepted for the asset \
                         {asset}."
                    ),
                    format!(
                        "The attestation freezes the liability set at ledger {snapshot_ledger}, \
                         and its total liabilities are {total_liabilities}."
                    ),
                ];
                // Two statements, because the two claims are different. The
                // first one holds whatever the second one says.
                if self.solvency_lapsed() {
                    lines.push(format!(
                        "SOLVENCY LAPSED: the registry read the reserves at ledger \
                         {attested_ledger}, the network is at ledger {latest_ledger}, and the \
                         window is {ATTESTATION_MAX_AGE_LEDGERS} ledgers. The inclusion above \
                         stays valid. Ask the authority for a fresher attestation."
                    ));
                } else {
                    lines.push(format!(
                        "SOLVENCY CURRENT: the registry read the reserves at ledger \
                         {attested_ledger}, and the network is at ledger {latest_ledger}."
                    ));
                }
                lines
            }
            Self::UnsupportedFormat(reason) => vec![
                format!("UNSUPPORTED FORMAT: {reason}"),
                "Use a verifier of the same generation as the package.".to_string(),
            ],
            Self::Malformed(reason) => vec![
                format!("MALFORMED PACKAGE: {reason}"),
                "The file is not a package of this format. Ask the authority for the file again."
                    .to_string(),
            ],
            Self::UntrustedDeployment { network, registry } => vec![
                format!(
                    "UNTRUSTED REGISTRY: the package names the registry {registry} on the \
                     network {network}, and no deployment record of this verifier names that \
                     pair."
                ),
                "The package points at a registry that this verifier does not trust. Do not \
                 treat it as a check of anything."
                    .to_string(),
            ],
            Self::InvalidDeployments(reason) => vec![
                format!("INVALID DEPLOYMENT RECORDS: {reason}"),
                "The deployment records of this verifier contradict themselves, so it \
                 checked nothing. This says nothing about the package. Repair the records \
                 and run the command again."
                    .to_string(),
            ],
            Self::NoMatchingAttestation(reason) => vec![
                format!("NO MATCHING ATTESTATION: {reason}"),
                "The chain holds no attestation that this package names.".to_string(),
            ],
            Self::RootMismatch {
                recomputed,
                attested,
            } => vec![
                format!(
                    "ROOT MISMATCH: the path reaches {recomputed}, and the registry attested \
                     {attested}."
                ),
                "A wrong balance, a wrong salt, and a changed path look the same from here. \
                 Obtain the package again from the authority before you conclude anything."
                    .to_string(),
            ],
        }
    }
}

/// The status that the command returns. Each class has its own number, so a
/// caller can tell the classes apart without a read of the text.
pub fn exit_code(verdict: &Verdict) -> i32 {
    match verdict {
        Verdict::Included { .. } => 0,
        Verdict::UnsupportedFormat(_) => 3,
        Verdict::Malformed(_) => 4,
        Verdict::UntrustedDeployment { .. } => 5,
        Verdict::NoMatchingAttestation(_) => 6,
        Verdict::RootMismatch { .. } => 7,
        Verdict::InvalidDeployments(_) => 9,
    }
}

/// Checks one package against the chain.
///
/// The five steps run in the order that the protocol fixes: the format gate,
/// the deployment match, the read of the registry entry, the snapshot
/// comparison, and the walk of the path.
pub fn verify(
    env: &Env,
    package_text: &str,
    deployments_text: &str,
    chain: &dyn Chain,
) -> Result<Verdict, NoVerdict> {
    let package = match schema::parse(env, package_text) {
        Ok(package) => package,
        Err(PackageError::UnsupportedFormat(found)) => {
            return Ok(Verdict::UnsupportedFormat(
                PackageError::UnsupportedFormat(found).to_string(),
            ))
        }
        Err(error) => return Ok(Verdict::Malformed(error.to_string())),
    };

    // The verifier resolves the deployment from its own file. A pair that no
    // record names is a signal, not a failure of the infrastructure.
    // A file that does not read is a fault of the configuration, and it
    // reaches no verdict. A file that reads and contradicts itself is a fault
    // of the trust root, and it takes its own outcome, so a reader never
    // confuses it with a package that names a generation the file does not
    // hold.
    let generation = match deployments::find(deployments_text, &package.network, &package.registry)
    {
        Ok(generation) => generation,
        Err(DeploymentsError::Contradictory(reason)) => {
            return Ok(Verdict::InvalidDeployments(reason))
        }
        Err(error) => {
            return Err(NoVerdict(format!(
                "the deployments file does not read: {error}"
            )))
        }
    };
    let generation = match generation {
        Some(generation) => generation,
        None => {
            return Ok(Verdict::UntrustedDeployment {
                network: package.network,
                registry: package.registry,
            })
        }
    };
    if let Err(error) = package.check_depth(generation.tree_depth) {
        return Ok(Verdict::Malformed(error.to_string()));
    }

    // The address comes from the deployment record, never from the package.
    let attestation = match chain.attestation(&generation.registry, &package.asset)? {
        Entry::Attested(attestation) => attestation,
        Entry::NoEntry => {
            return Ok(Verdict::NoMatchingAttestation(format!(
                "the registry {} holds no entry for the asset {}",
                generation.registry, package.asset
            )))
        }
        Entry::NoAttestation => {
            return Ok(Verdict::NoMatchingAttestation(format!(
                "the asset {} has an entry and no attestation",
                package.asset
            )))
        }
    };
    if attestation.snapshot_ledger != package.snapshot_ledger {
        return Ok(Verdict::NoMatchingAttestation(format!(
            "the package names the snapshot ledger {}, and the registry holds an attestation of \
             the snapshot ledger {}",
            package.snapshot_ledger, attestation.snapshot_ledger
        )));
    }

    let leaf = leaf_hash(
        env,
        &to_fr(env, &package.id),
        package.balance,
        &to_fr(env, &package.salt),
    );
    let siblings: Vec<_> = package.siblings.iter().map(|s| to_fr(env, s)).collect();
    // The depth check above already fixed the two shape rules, so a failure
    // here is a defect of this tool.
    let recomputed = root_from_path(
        env,
        &leaf,
        u64::from(package.leaf_index),
        &siblings,
        generation.tree_depth,
    )
    .map_err(NoVerdict)?;
    if to_big(&recomputed) != attestation.final_root {
        return Ok(Verdict::RootMismatch {
            recomputed: fr_hex(&to_big(&recomputed)),
            attested: fr_hex(&attestation.final_root),
        });
    }

    Ok(Verdict::Included {
        balance: package.balance,
        leaf_index: package.leaf_index,
        asset: package.asset,
        registry: generation.registry,
        snapshot_ledger: package.snapshot_ledger,
        attested_ledger: attestation.attested_ledger,
        latest_ledger: chain.latest_ledger()?,
        total_liabilities: attestation.total_liabilities,
    })
}
