//! Every outcome that the protocol names, each one reached for its own
//! reason, and each one next to a control that differs only in that reason.

use num_bigint::BigUint;
use soroban_sdk::{Env, U256};
use std::cell::RefCell;
use zkpor_context::{leaf_hash, ATTESTATION_MAX_AGE_LEDGERS};
use zkpor_inclusion_verify::{
    chain::{Attestation, Chain, Entry, NoVerdict},
    exit_code, verify, Verdict,
};
use zkpor_package::{
    fr::{to_big, to_fr},
    new_env,
    schema::{Package, PACKAGE_FORMAT},
    tree::{path_in_levels, subtree_root, tree_levels},
};

/// The tree of the deployment generation that the package names.
const DEPTH: usize = 4;
const CAPACITY: usize = 1 << DEPTH;
/// Customer rows of the fixture. The rest of the tree is padding.
const CUSTOMERS: usize = 5;
/// The leaf that the package under test names.
const LEAF: u32 = 3;
const SNAPSHOT: u32 = 500;
const ATTESTED: u32 = 505;
const TOTAL: u128 = 1290;

const NETWORK: &str = "local";
/// The registry of the retired generation, which the package names, and the
/// registry of the current one. A package of an earlier generation stays
/// verifiable, so the two must both sit in the file.
const RETIRED: &str = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const CURRENT: &str = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const OTHER_NETWORK_REGISTRY: &str = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
const ASSET: &str = "CDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD";

fn deployments() -> String {
    format!(
        r#"[
          {{"network": "{NETWORK}", "registry": "{RETIRED}", "tree_depth": {DEPTH}}},
          {{"network": "testnet", "registry": "{OTHER_NETWORK_REGISTRY}", "tree_depth": {DEPTH}}},
          {{"network": "{NETWORK}", "registry": "{CURRENT}", "tree_depth": 8}}
        ]"#
    )
}

/// The identifier, the balance, and the salt of one row. The verifier derives
/// no salt, so the fixture states one.
fn row(index: usize) -> (BigUint, u64, BigUint) {
    if index < CUSTOMERS {
        (
            BigUint::from(index as u64 + 1),
            index as u64 * 100 + 90,
            BigUint::from(index as u64 + 7000),
        )
    } else {
        // A padding leaf: the identifier and the balance are zero, and the
        // salt is real.
        (BigUint::from(0u32), 0, BigUint::from(index as u64 + 7000))
    }
}

fn leaf(env: &Env, index: usize) -> U256 {
    let (id, balance, salt) = row(index);
    leaf_hash(env, &to_fr(env, &id), balance, &to_fr(env, &salt))
}

/// The package of leaf `LEAF` and the attestation that the chain holds.
fn fixture(env: &Env) -> (Package, Attestation) {
    let leaves: Vec<U256> = (0..CAPACITY).map(|index| leaf(env, index)).collect();
    let siblings = path_in_levels(&tree_levels(env, &leaves), LEAF as usize);
    let (id, balance, salt) = row(LEAF as usize);
    let package = Package {
        network: NETWORK.to_string(),
        registry: RETIRED.to_string(),
        asset: ASSET.to_string(),
        snapshot_ledger: SNAPSHOT,
        leaf_index: LEAF,
        id,
        balance,
        salt,
        siblings: siblings.iter().map(to_big).collect(),
    };
    let attestation = Attestation {
        final_root: to_big(&subtree_root(env, &leaves)),
        total_liabilities: TOTAL,
        snapshot_ledger: SNAPSHOT,
        attested_ledger: ATTESTED,
    };
    (package, attestation)
}

/// A chain that answers what the test states, and records which registry the
/// verifier asked.
struct FakeChain {
    entry: Result<Entry, NoVerdict>,
    latest_ledger: u32,
    asked: RefCell<Vec<String>>,
}

impl FakeChain {
    fn holding(attestation: Attestation) -> Self {
        Self {
            entry: Ok(Entry::Attested(attestation)),
            latest_ledger: ATTESTED + 1,
            asked: RefCell::new(Vec::new()),
        }
    }

    fn answering(entry: Entry) -> Self {
        Self {
            entry: Ok(entry),
            latest_ledger: ATTESTED + 1,
            asked: RefCell::new(Vec::new()),
        }
    }
}

impl Chain for FakeChain {
    fn attestation(&self, registry: &str, _asset: &str) -> Result<Entry, NoVerdict> {
        self.asked.borrow_mut().push(registry.to_string());
        self.entry.clone()
    }

    fn latest_ledger(&self) -> Result<u32, NoVerdict> {
        Ok(self.latest_ledger)
    }
}

fn check(env: &Env, package: &Package, chain: &FakeChain) -> Verdict {
    verify(env, &package.to_json(), &deployments(), chain).expect("a verdict")
}

/// The positive path: the leaf sits under the root that the chain accepted.
#[test]
fn a_package_of_a_retired_generation_verifies_against_the_attested_root() {
    let env = new_env();
    let (package, attestation) = fixture(&env);
    let chain = FakeChain::holding(attestation);
    let verdict = check(&env, &package, &chain);
    assert!(
        matches!(verdict, Verdict::Included { .. }),
        "{:?}",
        verdict.lines()
    );
    assert_eq!(exit_code(&verdict), 0);
    assert!(!verdict.solvency_lapsed());
    // The verifier asked the registry of its own deployment record.
    assert_eq!(chain.asked.borrow().as_slice(), [RETIRED.to_string()]);
}

#[test]
fn every_customer_leaf_of_the_tree_verifies() {
    let env = new_env();
    let (package, attestation) = fixture(&env);
    let leaves: Vec<U256> = (0..CAPACITY).map(|index| leaf(&env, index)).collect();
    let levels = tree_levels(&env, &leaves);
    for index in 0..CUSTOMERS {
        let (id, balance, salt) = row(index);
        let one = Package {
            leaf_index: index as u32,
            id,
            balance,
            salt,
            siblings: path_in_levels(&levels, index).iter().map(to_big).collect(),
            ..package.clone()
        };
        let verdict = check(&env, &one, &FakeChain::holding(attestation.clone()));
        assert!(
            matches!(verdict, Verdict::Included { .. }),
            "leaf {index}: {:?}",
            verdict.lines()
        );
    }
}

/// Inclusion and solvency currency are different claims, and the verifier
/// states them apart.
#[test]
fn a_stale_attestation_holds_the_inclusion_and_reports_the_solvency_as_lapsed() {
    let env = new_env();
    let (package, attestation) = fixture(&env);

    let mut fresh = FakeChain::holding(attestation.clone());
    fresh.latest_ledger = ATTESTED + ATTESTATION_MAX_AGE_LEDGERS;
    let current = check(&env, &package, &fresh);

    let mut old = FakeChain::holding(attestation);
    old.latest_ledger = ATTESTED + ATTESTATION_MAX_AGE_LEDGERS + 1;
    let lapsed = check(&env, &package, &old);

    // One ledger of difference, and nothing else. The inclusion holds in both
    // cases, and the second one reports the lapse in a statement of its own.
    assert!(matches!(current, Verdict::Included { .. }));
    assert!(matches!(lapsed, Verdict::Included { .. }));
    assert!(!current.solvency_lapsed());
    assert!(lapsed.solvency_lapsed());
    assert_eq!(exit_code(&lapsed), 0);
    assert_eq!(current.lines()[0], lapsed.lines()[0]);
    assert!(current.lines()[2].starts_with("SOLVENCY CURRENT"));
    assert!(lapsed.lines()[2].starts_with("SOLVENCY LAPSED"));
}

#[test]
fn a_format_that_the_reader_does_not_know_stops_the_read() {
    let env = new_env();
    let (package, attestation) = fixture(&env);
    let text = package
        .to_json()
        .replace(PACKAGE_FORMAT, "zkpor-inclusion/2");
    let chain = FakeChain::holding(attestation);
    let verdict = verify(&env, &text, &deployments(), &chain).expect("a verdict");
    assert!(matches!(verdict, Verdict::UnsupportedFormat(_)));
    assert_eq!(exit_code(&verdict), 3);
    // The gate runs before any other field, so no read of the chain happened.
    assert!(chain.asked.borrow().is_empty());
}

#[test]
fn a_package_of_the_known_format_passes_the_gate() {
    let env = new_env();
    let (package, attestation) = fixture(&env);
    assert!(package.to_json().contains(PACKAGE_FORMAT));
    assert!(matches!(
        check(&env, &package, &FakeChain::holding(attestation)),
        Verdict::Included { .. }
    ));
}

#[test]
fn the_padding_identifier_is_a_malformed_package() {
    let env = new_env();
    let (package, attestation) = fixture(&env);
    let padding = Package {
        id: BigUint::from(0u32),
        ..package
    };
    let verdict = check(&env, &padding, &FakeChain::holding(attestation));
    assert!(matches!(verdict, Verdict::Malformed(_)), "{verdict:?}");
    assert_eq!(exit_code(&verdict), 4);
}

#[test]
fn a_leaf_index_at_the_capacity_is_a_malformed_package() {
    let env = new_env();
    let (package, attestation) = fixture(&env);
    let outside = Package {
        leaf_index: CAPACITY as u32,
        ..package.clone()
    };
    let inside = Package {
        leaf_index: CAPACITY as u32 - 1,
        ..package
    };
    assert!(matches!(
        check(&env, &outside, &FakeChain::holding(attestation.clone())),
        Verdict::Malformed(_)
    ));
    // The control differs only in the index. It is inside the tree, so the
    // walk runs and reaches another root than the attested one.
    assert!(matches!(
        check(&env, &inside, &FakeChain::holding(attestation)),
        Verdict::RootMismatch { .. }
    ));
}

#[test]
fn a_sibling_count_that_is_not_the_depth_of_the_generation_is_a_malformed_package() {
    let env = new_env();
    let (package, attestation) = fixture(&env);
    for count in [DEPTH - 1, DEPTH + 1] {
        let mut siblings = package.siblings.clone();
        siblings.resize(count, BigUint::from(1u32));
        let changed = Package {
            siblings,
            ..package.clone()
        };
        let verdict = check(&env, &changed, &FakeChain::holding(attestation.clone()));
        assert!(
            matches!(verdict, Verdict::Malformed(_)),
            "a path of {count} siblings: {verdict:?}"
        );
    }
    assert_eq!(package.siblings.len(), DEPTH);
    assert!(matches!(
        check(&env, &package, &FakeChain::holding(attestation)),
        Verdict::Included { .. }
    ));
}

/// The package points somewhere the verifier does not trust. The verifier
/// reads no chain for it.
#[test]
fn a_registry_and_a_network_that_no_record_names_together_are_untrusted() {
    let env = new_env();
    let (package, attestation) = fixture(&env);
    let cases = [
        // A registry that the file does not hold at all.
        Package {
            registry: ASSET.to_string(),
            ..package.clone()
        },
        // A registry of the file under the network of another record.
        Package {
            registry: OTHER_NETWORK_REGISTRY.to_string(),
            ..package.clone()
        },
        // A network that the file does not hold.
        Package {
            network: "mainnet".to_string(),
            ..package.clone()
        },
    ];
    for case in cases {
        let chain = FakeChain::holding(attestation.clone());
        let verdict = check(&env, &case, &chain);
        assert!(
            matches!(verdict, Verdict::UntrustedDeployment { .. }),
            "{verdict:?}"
        );
        assert_eq!(exit_code(&verdict), 5);
        assert!(chain.asked.borrow().is_empty());
    }
    // The control names a pair that one record holds.
    assert!(matches!(
        check(&env, &package, &FakeChain::holding(attestation)),
        Verdict::Included { .. }
    ));
}

/// The current generation builds deeper trees, so a package of this tree does
/// not belong to it. The pair is trusted and the shape refuses.
#[test]
fn a_package_under_the_current_generation_does_not_match_its_depth() {
    let env = new_env();
    let (package, attestation) = fixture(&env);
    let moved = Package {
        registry: CURRENT.to_string(),
        ..package
    };
    let verdict = check(&env, &moved, &FakeChain::holding(attestation));
    assert!(matches!(verdict, Verdict::Malformed(_)), "{verdict:?}");
}

#[test]
fn an_asset_without_an_entry_and_an_asset_without_an_attestation_stay_apart() {
    let env = new_env();
    let (package, attestation) = fixture(&env);
    for entry in [Entry::NoEntry, Entry::NoAttestation] {
        let verdict = check(&env, &package, &FakeChain::answering(entry));
        assert!(
            matches!(verdict, Verdict::NoMatchingAttestation(_)),
            "{verdict:?}"
        );
        assert_eq!(exit_code(&verdict), 6);
    }
    let first = check(&env, &package, &FakeChain::answering(Entry::NoEntry));
    let second = check(&env, &package, &FakeChain::answering(Entry::NoAttestation));
    assert_ne!(first, second, "the two reasons must not read the same");
    assert!(matches!(
        check(&env, &package, &FakeChain::holding(attestation)),
        Verdict::Included { .. }
    ));
}

#[test]
fn a_snapshot_that_the_attestation_does_not_name_matches_no_attestation() {
    let env = new_env();
    let (package, attestation) = fixture(&env);
    let other = Attestation {
        snapshot_ledger: SNAPSHOT + 1,
        ..attestation.clone()
    };
    let verdict = check(&env, &package, &FakeChain::holding(other));
    assert!(
        matches!(verdict, Verdict::NoMatchingAttestation(_)),
        "{verdict:?}"
    );
    // The control differs only in the snapshot of the record.
    assert!(matches!(
        check(&env, &package, &FakeChain::holding(attestation)),
        Verdict::Included { .. }
    ));
}

/// A wrong balance, a wrong salt, and a changed path all reach another root.
/// The verifier cannot tell them apart, and it says so.
#[test]
fn a_changed_leaf_value_or_a_changed_path_reaches_another_root() {
    let env = new_env();
    let (package, attestation) = fixture(&env);
    let mut tampered = package.siblings.clone();
    tampered[0] += 1u32;
    let cases = [
        Package {
            balance: package.balance + 1,
            ..package.clone()
        },
        Package {
            salt: &package.salt + 1u32,
            ..package.clone()
        },
        Package {
            id: &package.id + 1u32,
            ..package.clone()
        },
        Package {
            siblings: tampered,
            ..package.clone()
        },
    ];
    for case in cases {
        let verdict = check(&env, &case, &FakeChain::holding(attestation.clone()));
        assert!(
            matches!(verdict, Verdict::RootMismatch { .. }),
            "{verdict:?}"
        );
        assert_eq!(exit_code(&verdict), 7);
        assert!(verdict.lines()[1].contains("look the same from here"));
    }
    assert!(matches!(
        check(&env, &package, &FakeChain::holding(attestation)),
        Verdict::Included { .. }
    ));
}

/// The root of another attestation is a mismatch and not a missing record.
#[test]
fn a_root_that_the_chain_did_not_attest_is_a_mismatch() {
    let env = new_env();
    let (package, attestation) = fixture(&env);
    let other = Attestation {
        final_root: &attestation.final_root + 1u32,
        ..attestation
    };
    assert!(matches!(
        check(&env, &package, &FakeChain::holding(other)),
        Verdict::RootMismatch { .. }
    ));
}

#[test]
fn a_read_that_fails_is_not_a_verdict() {
    let env = new_env();
    let (package, _) = fixture(&env);
    let chain = FakeChain {
        entry: Err(NoVerdict("the node did not answer".to_string())),
        latest_ledger: ATTESTED,
        asked: RefCell::new(Vec::new()),
    };
    assert!(verify(&env, &package.to_json(), &deployments(), &chain).is_err());
}

#[test]
fn a_deployments_file_that_does_not_read_is_not_a_verdict() {
    let env = new_env();
    let (package, attestation) = fixture(&env);
    let chain = FakeChain::holding(attestation);
    assert!(verify(&env, &package.to_json(), "not json", &chain).is_err());
}

/// A caller must be able to tell the classes apart without a read of the text.
#[test]
fn every_class_has_its_own_status() {
    let codes = [
        exit_code(&Verdict::UnsupportedFormat(String::new())),
        exit_code(&Verdict::Malformed(String::new())),
        exit_code(&Verdict::UntrustedDeployment {
            network: String::new(),
            registry: String::new(),
        }),
        exit_code(&Verdict::NoMatchingAttestation(String::new())),
        exit_code(&Verdict::RootMismatch {
            recomputed: String::new(),
            attested: String::new(),
        }),
    ];
    let mut sorted = codes.to_vec();
    sorted.sort_unstable();
    sorted.dedup();
    assert_eq!(sorted.len(), codes.len());
    assert!(
        !codes.contains(&0),
        "no failure shares the status of success"
    );
}
