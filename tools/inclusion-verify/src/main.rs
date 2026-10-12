//! Checks one inclusion package against the chain.
//!
//! usage: verify-inclusion <package.zkpor.json> [deployments.json] [--identity-file <private.json>]
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
//! The command returns a distinct status for each verdict. A read failure
//! returns status 8 because it does not give a verdict.

use std::{env, fs, path::PathBuf, process::exit};
use zkpor_inclusion_verify::{chain::StellarCli, exit_code, verify_with_identity};
use zkpor_package::{new_env, schema};

/// The committed record of the deployment generations. A package names a
/// registry, and this file is the only place where the verifier looks it up.
const DEPLOYMENTS_FILE: &str = "scripts/deployments.json";
/// The status of a run that reached no verdict. It is not a verdict, so it
/// takes a number of its own.
const EXIT_NO_VERDICT: i32 = 8;
/// The status of a run that nobody asked for correctly.
const EXIT_USAGE: i32 = 2;

const USAGE: &str = "usage: verify-inclusion <package.zkpor.json> [deployments.json] [--identity-file <private.json>]";

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
    if args.len() < 2 {
        eprintln!("{USAGE}");
        exit(EXIT_USAGE);
    }
    let mut deployments_arg = None;
    let mut identity_arg = None;
    let mut index = 2;
    while index < args.len() {
        if args[index] == "--identity-file" {
            if identity_arg.is_some() || index + 1 >= args.len() {
                eprintln!("{USAGE}");
                exit(EXIT_USAGE);
            }
            identity_arg = Some(PathBuf::from(&args[index + 1]));
            index += 2;
        } else if deployments_arg.is_none() && !args[index].starts_with('-') {
            deployments_arg = Some(PathBuf::from(&args[index]));
            index += 1;
        } else {
            eprintln!("{USAGE}");
            exit(EXIT_USAGE);
        }
    }
    let package_file = PathBuf::from(&args[1]);
    let deployments_file = deployments_arg.unwrap_or_else(repo_deployments);
    let package_text = read(&package_file);
    let deployments_text = read(&deployments_file);
    let identity_text = identity_arg.map(|path| {
        fs::read_to_string(path).unwrap_or_else(|_| {
            eprintln!("cannot read the private identity file");
            exit(EXIT_NO_VERDICT);
        })
    });

    let env = new_env();
    // The network name of the package selects a record inside the trusted
    // file, and the endpoint of a customer who names none comes from that
    // name. The reader asks for it only when it reads, so a package that the
    // check refuses before any read never needs a configuration.
    let network = schema::parse(&env, &package_text)
        .map(|package| package.network)
        .unwrap_or_default();
    let chain = StellarCli::new(&network);

    match verify_with_identity(
        &env,
        &package_text,
        &deployments_text,
        &chain,
        identity_text.as_deref(),
    ) {
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
