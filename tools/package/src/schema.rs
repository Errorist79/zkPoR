//! The inclusion package format.
//!
//! One file carries what one customer needs to check that their leaf sits
//! under an attested root. The authority writes it and the customer reads it,
//! so the writer and the reader stand next to each other here.

use crate::fr::{fr_hex, parse_package_fr};
use num_bigint::BigUint;
use serde_json::Value;
use soroban_sdk::Env;

/// The version gate of the schema. A reader that does not know this exact
/// string refuses to read any other field.
pub const PACKAGE_FORMAT: &str = "zkpor-inclusion/1";
/// Extension of a package file.
pub const PACKAGE_EXTENSION: &str = "zkpor.json";
/// Digits of the zero-padded leaf index in a package filename.
pub const PACKAGE_INDEX_DIGITS: usize = 6;
/// Indentation of the package layout, in spaces.
pub const JSON_INDENT: usize = 2;
/// The keys of the schema, in the order that the format fixes.
const FIELDS: [&str; 10] = [
    "format",
    "network",
    "registry",
    "asset",
    "snapshot_ledger",
    "leaf_index",
    "id",
    "balance",
    "salt",
    "siblings",
];
/// Characters of a contract address in StrKey form. The payload is 32 bytes,
/// one version byte leads it and two checksum bytes follow it, and base32
/// writes those 35 bytes as 56 characters with no padding.
const STRKEY_CONTRACT_CHARS: usize = 56;
/// First character of a contract address in StrKey form.
const STRKEY_CONTRACT_PREFIX: char = 'C';

/// Why a reader refuses a file.
///
/// The two reasons stay apart in every result. An unsupported format says the
/// reader is too old for the file. A malformed package says the file is not a
/// package of this format.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PackageError {
    UnsupportedFormat(String),
    Malformed(String),
}

impl std::fmt::Display for PackageError {
    fn fmt(&self, out: &mut std::fmt::Formatter) -> std::fmt::Result {
        match self {
            Self::UnsupportedFormat(found) => {
                write!(
                    out,
                    "this reader knows the format {PACKAGE_FORMAT}, and the file states {found}"
                )
            }
            Self::Malformed(reason) => write!(out, "{reason}"),
        }
    }
}

fn malformed<T>(reason: impl Into<String>) -> Result<T, PackageError> {
    Err(PackageError::Malformed(reason.into()))
}

/// The fields of one package, in the order that the schema fixes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Package {
    pub network: String,
    pub registry: String,
    pub asset: String,
    pub snapshot_ledger: u32,
    pub leaf_index: u32,
    pub id: BigUint,
    pub balance: u64,
    pub salt: BigUint,
    pub siblings: Vec<BigUint>,
}

/// A JSON string value, with the escaping that JSON requires.
pub fn json_string(text: &str) -> String {
    Value::String(text.to_string()).to_string()
}

impl Package {
    /// The bytes of one package file.
    ///
    /// The layout is part of the format, so two implementations write the same
    /// bytes: the keys in schema order, two-space indentation, LF line ends,
    /// and one LF at the end of the file.
    pub fn to_json(&self) -> String {
        let pad = " ".repeat(JSON_INDENT);
        let mut lines = vec![
            format!("{pad}\"format\": {}", json_string(PACKAGE_FORMAT)),
            format!("{pad}\"network\": {}", json_string(&self.network)),
            format!("{pad}\"registry\": {}", json_string(&self.registry)),
            format!("{pad}\"asset\": {}", json_string(&self.asset)),
            format!("{pad}\"snapshot_ledger\": {}", self.snapshot_ledger),
            format!("{pad}\"leaf_index\": {}", self.leaf_index),
            format!("{pad}\"id\": {}", json_string(&fr_hex(&self.id))),
            format!(
                "{pad}\"balance\": {}",
                json_string(&self.balance.to_string())
            ),
            format!("{pad}\"salt\": {}", json_string(&fr_hex(&self.salt))),
        ];
        let siblings: Vec<String> = self
            .siblings
            .iter()
            .map(|sibling| format!("{pad}{pad}{}", json_string(&fr_hex(sibling))))
            .collect();
        lines.push(format!(
            "{pad}\"siblings\": [\n{}\n{pad}]",
            siblings.join(",\n")
        ));
        format!("{{\n{}\n}}\n", lines.join(",\n"))
    }

    /// The two rules that need the tree depth of the deployment generation.
    ///
    /// The depth comes from the deployments file, never from the package. A
    /// package that stated its own depth would state its own bound, and the
    /// walk would then accept a path of any length.
    pub fn check_depth(&self, tree_depth: usize) -> Result<(), PackageError> {
        if self.siblings.len() != tree_depth {
            return malformed(format!(
                "the package holds {} siblings, and this generation builds trees of depth {tree_depth}",
                self.siblings.len()
            ));
        }
        // A depth of 32 or more holds every u32 index, and the shift below
        // has no result at that width.
        if tree_depth < u32::BITS as usize && self.leaf_index >= 1u32 << tree_depth {
            return malformed(format!(
                "the leaf index {} is at or above the capacity of a tree of depth {tree_depth}",
                self.leaf_index
            ));
        }
        Ok(())
    }
}

/// The name of the package file of one leaf. The name carries no customer
/// identifier.
pub fn package_filename(leaf_index: u32) -> String {
    format!(
        "package-{leaf_index:0width$}.{PACKAGE_EXTENSION}",
        width = PACKAGE_INDEX_DIGITS
    )
}

/// Reads one package file.
///
/// The format gate runs before any other field. Every remaining check is a
/// property of the file alone; the two rules that need the tree depth of the
/// deployment run in `check_depth`, after the caller resolves the deployment.
pub fn parse(env: &Env, text: &str) -> Result<Package, PackageError> {
    let json: Value = match serde_json::from_str(text) {
        Ok(json) => json,
        Err(error) => return malformed(format!("the file is not JSON: {error}")),
    };
    let object = match json.as_object() {
        Some(object) => object,
        None => return malformed("the file is not a JSON object"),
    };
    match object.get("format").and_then(Value::as_str) {
        Some(PACKAGE_FORMAT) => (),
        Some(other) => return Err(PackageError::UnsupportedFormat(other.to_string())),
        None => return malformed("the file states no format"),
    }
    // The format string is the version gate, and every change of the schema
    // changes it. A file of this format therefore holds these keys and no
    // other one. The rule also refuses a file that carries a root, a direction
    // bit, or another customer's data, which no package may hold.
    if let Some(extra) = object.keys().find(|key| !FIELDS.contains(&key.as_str())) {
        return malformed(format!(
            "the package holds the field {extra}, which the format does not name"
        ));
    }

    let text_field = |name: &str| -> Result<String, PackageError> {
        json[name]
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| PackageError::Malformed(format!("{name} is not a string")))
    };
    let contract_field = |name: &str| -> Result<String, PackageError> {
        let value = text_field(name)?;
        let body = value.strip_prefix(STRKEY_CONTRACT_PREFIX);
        let base32 = |text: &str| {
            text.chars()
                .all(|c| c.is_ascii_uppercase() || ('2'..='7').contains(&c))
        };
        match body {
            Some(rest) if value.chars().count() == STRKEY_CONTRACT_CHARS && base32(rest) => {
                Ok(value)
            }
            _ => Err(PackageError::Malformed(format!(
                "{name} is not a contract address in StrKey form"
            ))),
        }
    };
    let u32_field = |name: &str| -> Result<u32, PackageError> {
        match json[name].as_u64() {
            Some(value) if value <= u64::from(u32::MAX) => Ok(value as u32),
            _ => Err(PackageError::Malformed(format!(
                "{name} is not a whole number that a u32 holds"
            ))),
        }
    };
    let fr_field = |name: &str| -> Result<BigUint, PackageError> {
        parse_package_fr(env, &text_field(name)?)
            .map_err(|reason| PackageError::Malformed(format!("{name}: {reason}")))
    };

    let id = fr_field("id")?;
    if id == BigUint::from(0u32) {
        // Zero is the padding identifier, so no customer package names it.
        return malformed("the identifier is zero, which is the padding identifier");
    }
    let balance = text_field("balance")?;
    if balance.is_empty() || !balance.chars().all(|c| c.is_ascii_digit()) {
        return malformed("the balance is not a decimal string");
    }
    let siblings = match json["siblings"].as_array() {
        Some(values) => values,
        None => return malformed("siblings is not an array"),
    };

    Ok(Package {
        network: text_field("network")?,
        registry: contract_field("registry")?,
        asset: contract_field("asset")?,
        snapshot_ledger: u32_field("snapshot_ledger")?,
        leaf_index: u32_field("leaf_index")?,
        id,
        balance: balance
            .parse()
            .map_err(|_| PackageError::Malformed("the balance is above the u64 maximum".into()))?,
        salt: fr_field("salt")?,
        siblings: siblings
            .iter()
            .enumerate()
            .map(|(level, value)| {
                let text = value.as_str().ok_or_else(|| {
                    PackageError::Malformed(format!("sibling {level} is not a string"))
                })?;
                parse_package_fr(env, text)
                    .map_err(|reason| PackageError::Malformed(format!("sibling {level}: {reason}")))
            })
            .collect::<Result<Vec<BigUint>, PackageError>>()?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const REGISTRY: &str = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const ASSET: &str = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

    fn env() -> Env {
        crate::new_env()
    }

    fn package() -> Package {
        Package {
            network: "local".into(),
            registry: REGISTRY.into(),
            asset: ASSET.into(),
            snapshot_ledger: 1234,
            leaf_index: 5,
            id: BigUint::from(7u32),
            balance: u64::MAX,
            salt: BigUint::from(9u32),
            siblings: (0u32..4).map(BigUint::from).collect(),
        }
    }

    /// One field of a written package, changed.
    fn with(field: &str, value: &str) -> String {
        let line = format!("\"{field}\": ");
        package()
            .to_json()
            .lines()
            .map(|text| {
                if text.trim_start().starts_with(&line) {
                    format!("  \"{field}\": {value},")
                } else {
                    text.to_string()
                }
            })
            .collect::<Vec<String>>()
            .join("\n")
    }

    /// The writer follows the list that the reader checks, so the two cannot
    /// drift apart.
    #[test]
    fn the_written_keys_are_the_keys_of_the_schema_in_order() {
        let written: Vec<String> = package()
            .to_json()
            .lines()
            .filter_map(|line| line.trim().split('"').nth(1).map(str::to_string))
            .take(FIELDS.len())
            .collect();
        assert_eq!(written, FIELDS);
    }

    /// A file that carries a root, a direction bit, or any other field is not
    /// a package of this format.
    #[test]
    fn a_field_that_the_format_does_not_name_is_malformed() {
        let text = package()
            .to_json()
            .replace("\"network\":", "\"final_root\": \"0x00\",\n  \"network\":");
        assert!(matches!(
            parse(&env(), &text),
            Err(PackageError::Malformed(_))
        ));
    }

    #[test]
    fn a_written_package_reads_back_as_the_same_package() {
        assert_eq!(parse(&env(), &package().to_json()).unwrap(), package());
    }

    /// The layout is part of the format, so this pins the key order, the
    /// indentation, and the line ends.
    #[test]
    fn the_layout_is_fixed() {
        let written = Package {
            siblings: vec![BigUint::from(2u32), BigUint::from(3u32)],
            id: BigUint::from(7u32),
            salt: BigUint::from(1u32),
            leaf_index: 42,
            snapshot_ledger: 1000,
            ..package()
        };
        // The expected hexadecimal comes from the standard library, so the
        // test does not restate the padding rule of fr_hex.
        let id = format!("{:0>64}", "07");
        let salt = format!("{:0>64}", "01");
        let first = format!("{:0>64}", "02");
        let second = format!("{:0>64}", "03");
        let expected = format!(
            "{{\n  \"format\": \"zkpor-inclusion/1\",\n  \"network\": \"local\",\n  \
             \"registry\": \"{REGISTRY}\",\n  \"asset\": \"{ASSET}\",\n  \
             \"snapshot_ledger\": 1000,\n  \
             \"leaf_index\": 42,\n  \"id\": \"0x{id}\",\n  \
             \"balance\": \"18446744073709551615\",\n  \"salt\": \"0x{salt}\",\n  \
             \"siblings\": [\n    \"0x{first}\",\n    \"0x{second}\"\n  ]\n}}\n"
        );
        assert_eq!(written.to_json(), expected);
    }

    #[test]
    fn the_balance_is_a_decimal_string_because_a_json_number_loses_the_top_bits() {
        assert!(package().to_json().contains(&format!("\"{}\"", u64::MAX)));
        assert_eq!(
            parse(&env(), &package().to_json()).unwrap().balance,
            u64::MAX
        );
    }

    #[test]
    fn a_reader_ignores_the_layout_and_reads_the_fields() {
        let compact =
            serde_json::to_string(&serde_json::from_str::<Value>(&package().to_json()).unwrap())
                .unwrap();
        assert_eq!(parse(&env(), &compact).unwrap(), package());
    }

    #[test]
    fn another_format_is_not_a_malformed_package() {
        let text = with("format", "\"zkpor-inclusion/2\"");
        assert_eq!(
            parse(&env(), &text),
            Err(PackageError::UnsupportedFormat("zkpor-inclusion/2".into()))
        );
    }

    #[test]
    fn a_file_without_a_format_is_malformed() {
        assert!(matches!(
            parse(&env(), "{}"),
            Err(PackageError::Malformed(_))
        ));
        assert!(matches!(
            parse(&env(), "not json"),
            Err(PackageError::Malformed(_))
        ));
    }

    #[test]
    fn the_padding_identifier_is_malformed() {
        let text = with("id", &format!("\"{}\"", fr_hex(&BigUint::from(0u32))));
        assert!(matches!(
            parse(&env(), &text),
            Err(PackageError::Malformed(_))
        ));
    }

    #[test]
    fn a_field_element_of_another_form_is_malformed() {
        for value in [
            "\"0xff\"",
            "\"7\"",
            &format!(
                "\"{}\"",
                fr_hex(&BigUint::from(0xabcu32))
                    .to_uppercase()
                    .replace("0X", "0x")
            ),
        ] {
            assert!(
                matches!(
                    parse(&env(), &with("salt", value)),
                    Err(PackageError::Malformed(_))
                ),
                "{value} must not read as a field element"
            );
        }
    }

    #[test]
    fn a_balance_that_is_not_a_decimal_string_is_malformed() {
        for value in ["18446744073709551616", "-1", "0x10", ""] {
            assert!(
                matches!(
                    parse(&env(), &with("balance", &format!("\"{value}\""))),
                    Err(PackageError::Malformed(_))
                ),
                "{value} must not read as a balance"
            );
        }
        assert!(matches!(
            parse(&env(), &with("balance", "12")),
            Err(PackageError::Malformed(_))
        ));
    }

    #[test]
    fn a_ledger_or_an_index_outside_the_u32_range_is_malformed() {
        for field in ["snapshot_ledger", "leaf_index"] {
            for value in ["4294967296", "-1", "1.5", "\"7\""] {
                assert!(
                    matches!(
                        parse(&env(), &with(field, value)),
                        Err(PackageError::Malformed(_))
                    ),
                    "{field} must not read {value}"
                );
            }
        }
    }

    #[test]
    fn an_address_that_is_not_a_contract_strkey_is_malformed() {
        for value in ["\"G\"", "\"\"", &format!("\"{}\"", &REGISTRY[..55])] {
            assert!(
                matches!(
                    parse(&env(), &with("asset", value)),
                    Err(PackageError::Malformed(_))
                ),
                "{value} must not read as a contract address"
            );
        }
    }

    #[test]
    fn the_sibling_count_must_equal_the_depth_of_the_generation() {
        let package = package();
        assert!(package.check_depth(4).is_ok());
        assert!(package.check_depth(3).is_err());
        assert!(package.check_depth(5).is_err());
    }

    #[test]
    fn a_leaf_index_at_the_capacity_is_malformed() {
        let mut package = package();
        package.leaf_index = 16;
        assert!(package.check_depth(4).is_err());
        package.leaf_index = 15;
        assert!(package.check_depth(4).is_ok());
    }

    #[test]
    fn the_filename_pads_the_leaf_index_to_six_digits() {
        assert_eq!(package_filename(0), "package-000000.zkpor.json");
        assert_eq!(package_filename(1234), "package-001234.zkpor.json");
    }
}
