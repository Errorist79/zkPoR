//! The committed record of the deployment generations.
//!
//! A circuit change produces a new verifier and a new registry, so the file
//! lists the generations in order. Every client reads the contract addresses
//! from here, and a package never says where a client looks.

use serde_json::Value;

/// One deployment generation.
pub struct Generation {
    pub network: String,
    pub registry: String,
    /// The tree depth of section 5.3 for this generation. A package verifier
    /// needs it, because the sibling count and the leaf index bound depend on
    /// it, and the package must not state its own bound.
    pub tree_depth: usize,
}

/// Every generation of the file, in the order that the file lists them.
pub fn generations(text: &str) -> Result<Vec<Generation>, String> {
    let json: Value = serde_json::from_str(text).map_err(|error| error.to_string())?;
    let records = json
        .as_array()
        .ok_or("the deployments file is not a list of generations")?;
    records.iter().map(generation).collect()
}

fn generation(record: &Value) -> Result<Generation, String> {
    let text = |name: &str| -> Result<String, String> {
        record[name]
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| format!("a generation record holds no {name}"))
    };
    Ok(Generation {
        network: text("network")?,
        registry: text("registry")?,
        tree_depth: record["tree_depth"]
            .as_u64()
            .ok_or("a generation record holds no tree_depth")? as usize,
    })
}

/// The current generation of one network: the last record that names it,
/// because the file lists the generations in order.
pub fn current(text: &str, network: &str) -> Result<Generation, String> {
    generations(text)?
        .into_iter()
        .rfind(|generation| generation.network == network)
        .ok_or_else(|| format!("no deployment generation for network {network}"))
}

/// The generation that one network name and one registry address name
/// together, from any generation.
///
/// A retired generation stays deployed and stays the record of the
/// attestations that it accepted, so a package of an earlier generation stays
/// verifiable.
pub fn find(text: &str, network: &str, registry: &str) -> Result<Option<Generation>, String> {
    Ok(generations(text)?
        .into_iter()
        .find(|generation| generation.network == network && generation.registry == registry))
}

#[cfg(test)]
mod tests {
    use super::*;

    const FILE: &str = r#"[
      {"network": "testnet", "registry": "CFIRST", "verifier": "CV1",
       "aggregator_key_sha256": "aa", "tree_depth": 10},
      {"network": "local", "registry": "CLOCAL", "verifier": "CV2",
       "aggregator_key_sha256": "bb", "tree_depth": 4},
      {"network": "testnet", "registry": "CSECOND", "verifier": "CV3",
       "aggregator_key_sha256": "cc", "tree_depth": 12}
    ]"#;

    #[test]
    fn the_current_generation_is_the_last_record_of_the_network() {
        let generation = current(FILE, "testnet").unwrap();
        assert_eq!(generation.registry, "CSECOND");
        assert_eq!(generation.tree_depth, 12);
    }

    #[test]
    fn a_network_without_a_generation_has_no_current_record() {
        assert!(current(FILE, "mainnet").is_err());
    }

    #[test]
    fn an_earlier_generation_stays_findable() {
        let generation = find(FILE, "testnet", "CFIRST").unwrap().unwrap();
        assert_eq!(generation.tree_depth, 10);
    }

    #[test]
    fn a_pair_that_no_record_names_is_not_found() {
        assert!(find(FILE, "testnet", "CLOCAL").unwrap().is_none());
        assert!(find(FILE, "local", "CFIRST").unwrap().is_none());
        assert!(find(FILE, "mainnet", "CSECOND").unwrap().is_none());
    }

    #[test]
    fn a_record_without_a_tree_depth_fails() {
        let text = r#"[{"network": "local", "registry": "C1"}]"#;
        assert!(generations(text).is_err());
    }

    #[test]
    fn a_file_that_is_not_a_list_fails() {
        assert!(generations("{}").is_err());
        assert!(generations("not json").is_err());
    }
}
