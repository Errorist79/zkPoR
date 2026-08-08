//! Checks one inclusion package against the chain.
//!
//! usage: verify-inclusion <package.zkpor.json> [deployments.json]
//!
//! The customer holds one package. This command tells the customer whether
//! their balance sits in the liability set that the chain accepted.
//!
//! The command reads the registry address and the tree depth from the
//! deployments file of this repository, and the endpoint from the environment.
//! It reads neither from the package. A package that named its own registry
//! would send the customer to a registry that the writer of the package
//! controls, and the answer would then mean nothing.
//!
//! Environment:
//!   STELLAR_SOURCE_ACCOUNT      an identity that the network knows
//!   STELLAR_RPC_URL             an endpoint, with the passphrase below
//!   STELLAR_NETWORK_PASSPHRASE  the passphrase of that endpoint
//!
//! Without the two endpoint variables, the network name of the deployment
//! record selects a network of the stellar command line.
//!
//! The status of the command names the class of the result: 0 included,
//! 3 unsupported format, 4 malformed package, 5 untrusted registry or
//! network, 6 no matching attestation, 7 root mismatch, and 8 no verdict.

use std::{env, fs, path::PathBuf, process::exit};
use zkpor_inclusion_verify::{chain::StellarCli, exit_code, verify};
use zkpor_package::{new_env, schema};

/// The committed record of the deployment generations. A package names a
/// registry, and this file is the only place where the verifier looks it up.
const DEPLOYMENTS_FILE: &str = "scripts/deployments.json";
/// The status of a run that reached no verdict. It is not a verdict, so it
/// takes a number of its own.
const EXIT_NO_VERDICT: i32 = 8;
/// The status of a run that nobody asked for correctly.
const EXIT_USAGE: i32 = 2;

const USAGE: &str = "usage: verify-inclusion <package.zkpor.json> [deployments.json]";

/// The deployments file of the repository that holds this tool.
fn repo_deployments() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(DEPLOYMENTS_FILE)
}

fn read(path: &PathBuf) -> String {
    fs::read_to_string(path).unwrap_or_else(|error| {
        eprintln!("cannot read {}: {error}", path.display());
        exit(EXIT_NO_VERDICT);
    })
}

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() < 2 || args.len() > 3 {
        eprintln!("{USAGE}");
        exit(EXIT_USAGE);
    }
    let package_file = PathBuf::from(&args[1]);
    let deployments_file = args
        .get(2)
        .map(PathBuf::from)
        .unwrap_or_else(repo_deployments);
    let package_text = read(&package_file);
    let deployments_text = read(&deployments_file);

    let env = new_env();
    // The network name of the package selects a record inside the trusted
    // file, and the endpoint of a customer who names none comes from that
    // name. The reader asks for it only when it reads, so a package that the
    // check refuses before any read never needs a configuration.
    let network = schema::parse(&env, &package_text)
        .map(|package| package.network)
        .unwrap_or_default();
    let chain = StellarCli::new(&network);

    match verify(&env, &package_text, &deployments_text, &chain) {
        Ok(verdict) => {
            for line in verdict.lines() {
                println!("{line}");
            }
            exit(exit_code(&verdict));
        }
        Err(reason) => {
            eprintln!("no verdict: {reason}");
            eprintln!(
                "This says nothing about the package. Repair the configuration or the \
                 connection, and run the command again."
            );
            exit(EXIT_NO_VERDICT);
        }
    }
}
