//! The read of the chain.
//!
//! The verifier reads two values from the network: the attestation that the
//! registry holds for the asset, and the sequence number of the last ledger.
//! Both reads are read-only. This tool signs nothing and sends nothing.

use num_bigint::BigUint;
use serde_json::Value;
use std::{env, process::Command};
use zkpor_package::fr::parse_fr;
use zkpor_registry::Error as RegistryError;

/// The verifier reached no verdict. This says nothing about the package.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NoVerdict(pub String);

impl std::fmt::Display for NoVerdict {
    fn fmt(&self, out: &mut std::fmt::Formatter) -> std::fmt::Result {
        write!(out, "{}", self.0)
    }
}

/// The attestation record that the registry holds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Attestation {
    pub final_root: BigUint,
    pub total_liabilities: u128,
    pub snapshot_ledger: u32,
    /// The ledger at which the registry read the reserve balances. The age of
    /// the solvency claim counts from here.
    pub attested_ledger: u32,
}

/// What the registry answers for one asset.
///
/// The two empty answers stay apart, because they tell the customer different
/// things: an asset with no entry never reached this registry, and an asset
/// with an entry and no attestation reached it and holds no proof yet.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Entry {
    NoEntry,
    NoAttestation,
    Attested(Attestation),
}

pub trait Chain {
    /// The attestation of one asset, from the registry that the verifier
    /// resolved from its own deployments file.
    fn attestation(&self, registry: &str, asset: &str) -> Result<Entry, NoVerdict>;
    /// The sequence number of the last closed ledger.
    fn latest_ledger(&self) -> Result<u32, NoVerdict>;
}

/// Name of the environment variable that names the identity of the read.
const SOURCE_VAR: &str = "STELLAR_SOURCE_ACCOUNT";
/// Names of the two variables that name an endpoint directly. The stellar
/// command line reads the same two names.
const RPC_URL_VAR: &str = "STELLAR_RPC_URL";
const PASSPHRASE_VAR: &str = "STELLAR_NETWORK_PASSPHRASE";

/// The stellar command line as the reader of the chain.
///
/// The endpoint comes from the environment of the customer, and the network
/// name comes from the deployment record that the verifier resolved. Neither
/// one comes from the package. The configuration reaches this reader at the
/// first read, so a package that never needs the chain never needs it.
pub struct StellarCli {
    network: String,
}

impl StellarCli {
    pub fn new(network: &str) -> Self {
        Self {
            network: network.to_string(),
        }
    }

    /// The identity of the read. The read is read-only, and the simulation
    /// still needs an account that the network knows.
    fn source(&self) -> Result<String, NoVerdict> {
        env::var(SOURCE_VAR).map_err(|_| {
            NoVerdict(format!(
                "set {SOURCE_VAR} to an identity that the network knows"
            ))
        })
    }

    /// Where the reader looks.
    ///
    /// The environment has the first place, because a customer who names an
    /// endpoint states where they read. Without an endpoint, the network name
    /// selects a network that the stellar command line already holds.
    fn endpoint_args(&self) -> Result<Vec<String>, NoVerdict> {
        match (env::var(RPC_URL_VAR), env::var(PASSPHRASE_VAR)) {
            (Ok(url), Ok(passphrase)) => Ok(vec![
                "--rpc-url".to_string(),
                url,
                "--network-passphrase".to_string(),
                passphrase,
            ]),
            (Ok(_), Err(_)) => Err(NoVerdict(format!(
                "{RPC_URL_VAR} is set and {PASSPHRASE_VAR} is not. An endpoint needs both."
            ))),
            _ => Ok(vec!["--network".to_string(), self.network.clone()]),
        }
    }

    fn run(&self, args: &[String]) -> Result<std::process::Output, NoVerdict> {
        Command::new("stellar")
            .args(args)
            .output()
            .map_err(|error| {
                NoVerdict(format!(
                    "the stellar command line did not run: {error}. Install it and put it on PATH."
                ))
            })
    }
}

/// The number of the contract error that a failed call reports, when the text
/// holds one.
fn contract_error(text: &str) -> Option<u32> {
    let start = text.find("Error(Contract, #")? + "Error(Contract, #".len();
    let digits: String = text[start..]
        .chars()
        .take_while(char::is_ascii_digit)
        .collect();
    digits.parse().ok()
}

impl Chain for StellarCli {
    fn attestation(&self, registry: &str, asset: &str) -> Result<Entry, NoVerdict> {
        let mut args = vec![
            "contract".to_string(),
            "invoke".to_string(),
            "--id".to_string(),
            registry.to_string(),
            "--source".to_string(),
            self.source()?,
        ];
        args.extend(self.endpoint_args()?);
        args.extend([
            "--".to_string(),
            "entry".to_string(),
            "--asset".to_string(),
            asset.to_string(),
        ]);
        let output = self.run(&args)?;
        if !output.status.success() {
            let text = String::from_utf8_lossy(&output.stderr).to_string();
            if contract_error(&text) == Some(RegistryError::AssetNotRegistered as u32) {
                return Ok(Entry::NoEntry);
            }
            return Err(NoVerdict(format!(
                "the read of the registry failed: {text}"
            )));
        }
        parse_entry(&String::from_utf8_lossy(&output.stdout))
    }

    fn latest_ledger(&self) -> Result<u32, NoVerdict> {
        let mut args = vec![
            "ledger".to_string(),
            "latest".to_string(),
            "--output".to_string(),
            "json".to_string(),
        ];
        args.extend(self.endpoint_args()?);
        let output = self.run(&args)?;
        if !output.status.success() {
            return Err(NoVerdict(format!(
                "the read of the last ledger failed: {}",
                String::from_utf8_lossy(&output.stderr)
            )));
        }
        let json: Value = serde_json::from_str(&String::from_utf8_lossy(&output.stdout))
            .map_err(|error| NoVerdict(format!("the answer of the node is not JSON: {error}")))?;
        match json["sequence"].as_u64() {
            Some(sequence) if sequence <= u64::from(u32::MAX) => Ok(sequence as u32),
            _ => Err(NoVerdict(
                "the answer of the node states no ledger sequence".to_string(),
            )),
        }
    }
}

/// The attestation inside the answer of the registry.
///
/// The answer is the JSON that the command line writes for the contract type,
/// and no part of this protocol fixes how it writes a number. The reader
/// therefore accepts a JSON number and a JSON string for one value, and it
/// refuses everything else with a reason.
pub fn parse_entry(text: &str) -> Result<Entry, NoVerdict> {
    let json: Value = serde_json::from_str(text)
        .map_err(|error| NoVerdict(format!("the answer of the registry is not JSON: {error}")))?;
    let slot = &json["attestation"];
    if slot.is_null() {
        return Err(NoVerdict(
            "the answer of the registry holds no attestation slot".to_string(),
        ));
    }
    // The empty slot carries no value, and the filled slot carries the record.
    if slot.as_str() == Some("Empty") || !slot["Empty"].is_null() {
        return Ok(Entry::NoAttestation);
    }
    let filled = match &slot["Filled"] {
        Value::Null => {
            return Err(NoVerdict(format!(
                "the attestation slot of the answer reads as none of the two cases: {slot}"
            )))
        }
        // One payload behind a variant name reaches the reader either alone or
        // inside a list of one.
        Value::Array(values) => values
            .first()
            .cloned()
            .ok_or_else(|| NoVerdict("the filled attestation slot is empty".to_string()))?,
        value => value.clone(),
    };

    let number = |name: &str| -> Result<u128, NoVerdict> {
        let value = &filled[name];
        let text = match value {
            Value::String(text) => text.clone(),
            Value::Number(number) => number.to_string(),
            _ => return Err(NoVerdict(format!("the attestation holds no {name}"))),
        };
        text.parse().map_err(|_| {
            NoVerdict(format!(
                "the {name} of the attestation is not a number: {text}"
            ))
        })
    };
    let ledger = |name: &str| -> Result<u32, NoVerdict> {
        u32::try_from(number(name)?)
            .map_err(|_| NoVerdict(format!("the {name} of the attestation is not a u32")))
    };
    let root = match &filled["final_root"] {
        Value::String(text) => text.clone(),
        Value::Number(number) => number.to_string(),
        _ => return Err(NoVerdict("the attestation holds no final_root".to_string())),
    };
    // The root travels as a decimal number, and a hexadecimal text stays
    // readable, because both name one integer.
    let final_root = if root.starts_with("0x") {
        parse_fr(&zkpor_package::new_env(), &root)
            .map_err(|reason| NoVerdict(format!("the attested root does not read: {reason}")))?
    } else {
        root.parse::<BigUint>()
            .map_err(|_| NoVerdict(format!("the attested root does not read: {root}")))?
    };

    Ok(Entry::Attested(Attestation {
        final_root,
        total_liabilities: number("total_liabilities")?,
        snapshot_ledger: ledger("snapshot_ledger")?,
        attested_ledger: ledger("attested_ledger")?,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_number_of_a_contract_error_reads_out_of_the_answer() {
        assert_eq!(
            contract_error("error: HostError: Error(Contract, #7)\n"),
            Some(7)
        );
        assert_eq!(contract_error("Error(Contract, #16)"), Some(16));
        assert_eq!(contract_error("connection refused"), None);
    }

    #[test]
    fn the_empty_slot_and_the_filled_slot_stay_apart() {
        assert_eq!(
            parse_entry(r#"{"attestation": "Empty"}"#).unwrap(),
            Entry::NoAttestation
        );
        assert_eq!(
            parse_entry(r#"{"attestation": {"Empty": []}}"#).unwrap(),
            Entry::NoAttestation
        );
    }

    #[test]
    fn a_filled_slot_reads_the_record() {
        let expected = Attestation {
            final_root: BigUint::from(123u32),
            total_liabilities: 40,
            snapshot_ledger: 100,
            attested_ledger: 101,
        };
        let object = r#"{"attestation": {"Filled": {"final_root": "123",
            "total_liabilities": "40", "snapshot_ledger": 100, "attested_ledger": 101,
            "reserve_sum": "50"}}}"#;
        assert_eq!(
            parse_entry(object).unwrap(),
            Entry::Attested(expected.clone())
        );

        // The same record inside a list of one, and with numbers instead of
        // strings, names the same values.
        let list = r#"{"attestation": {"Filled": [{"final_root": 123,
            "total_liabilities": 40, "snapshot_ledger": 100, "attested_ledger": 101}]}}"#;
        assert_eq!(parse_entry(list).unwrap(), Entry::Attested(expected));
    }

    #[test]
    fn a_root_in_hexadecimal_names_the_same_value() {
        let text = r#"{"attestation": {"Filled": {"final_root": "0x000000000000000000000000000000000000000000000000000000000000007b",
            "total_liabilities": "40", "snapshot_ledger": 100, "attested_ledger": 101}}}"#;
        match parse_entry(text).unwrap() {
            Entry::Attested(attestation) => {
                assert_eq!(attestation.final_root, BigUint::from(123u32))
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn an_answer_that_the_reader_cannot_read_is_not_a_verdict() {
        assert!(parse_entry("not json").is_err());
        assert!(parse_entry("{}").is_err());
        assert!(parse_entry(r#"{"attestation": {"Filled": {"final_root": "1"}}}"#).is_err());
        assert!(parse_entry(r#"{"attestation": {"Other": {}}}"#).is_err());
    }
}
