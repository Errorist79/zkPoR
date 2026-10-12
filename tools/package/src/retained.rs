//! Complete redacted trees for continuity checks and dispute answers.

use std::collections::HashSet;

use num_bigint::BigUint;
use serde_json::Value;
use soroban_sdk::{Env, U256};
use zkpor_context::{leaf_hash, PADDING_LEAF_ID};

use crate::fr::{fr_hex, parse_package_fr, to_big, to_fr};
use crate::tree::{path_in_levels, tree_levels};

pub const RETAINED_TREE_FORMAT: &str = "zkpor-redacted-tree/1";

#[derive(Debug, PartialEq, Eq)]
pub struct TreeBinding {
    pub network: String,
    pub registry: String,
    pub asset: String,
    pub attestation_id: u64,
    pub snapshot_ledger: u32,
    pub context_hash: BigUint,
    pub root: BigUint,
    pub tree_depth: u32,
}

pub struct RetainedTree {
    pub binding: TreeBinding,
    entries: Vec<(BigUint, BigUint)>,
    levels: Vec<Vec<U256>>,
    count: usize,
}

pub struct AnswerRequest {
    pub binding: TreeBinding,
    pub identifier: BigUint,
}

fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value[key]
        .as_str()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("{key} must be nonempty text"))
}

fn u32_field(value: &Value, key: &str) -> Result<u32, String> {
    value[key]
        .as_u64()
        .and_then(|number| u32::try_from(number).ok())
        .ok_or_else(|| format!("{key} must be a u32"))
}

fn field(env: &Env, value: &Value, key: &str) -> Result<BigUint, String> {
    parse_package_fr(env, text(value, key)?)
        .map_err(|_| format!("{key} must be a canonical field element"))
}

fn exact_keys(value: &Value, keys: &[&str]) -> Result<(), String> {
    let object = value.as_object().ok_or("an object is required")?;
    if object.len() != keys.len() || keys.iter().any(|key| !object.contains_key(*key)) {
        return Err("the object has missing or unexpected fields".into());
    }
    Ok(())
}

fn binding(env: &Env, value: &Value) -> Result<TreeBinding, String> {
    let id_text = text(value, "attestation_id")?;
    let attestation_id = id_text
        .parse::<u64>()
        .ok()
        .filter(|id| *id > 0 && id.to_string() == id_text)
        .ok_or("attestation_id must be a canonical positive u64 string")?;
    Ok(TreeBinding {
        network: text(value, "network")?.into(),
        registry: text(value, "registry")?.into(),
        asset: text(value, "asset")?.into(),
        attestation_id,
        snapshot_ledger: u32_field(value, "snapshot_ledger")?,
        context_hash: field(env, value, "context_hash")?,
        root: field(env, value, "root")?,
        tree_depth: u32_field(value, "tree_depth")?,
    })
}

impl AnswerRequest {
    pub fn parse(env: &Env, source: &str) -> Result<Self, String> {
        let value: Value =
            serde_json::from_str(source).map_err(|_| "the answer request is not JSON")?;
        exact_keys(
            &value,
            &[
                "network",
                "registry",
                "asset",
                "attestation_id",
                "snapshot_ledger",
                "context_hash",
                "root",
                "tree_depth",
                "identifier",
            ],
        )?;
        let identifier = field(env, &value, "identifier")?;
        if identifier == BigUint::from(PADDING_LEAF_ID) {
            return Err("the padding identifier cannot receive an answer".into());
        }
        Ok(Self {
            binding: binding(env, &value)?,
            identifier,
        })
    }
}

impl RetainedTree {
    pub fn parse(env: &Env, source: &str) -> Result<Self, String> {
        let value: Value =
            serde_json::from_str(source).map_err(|_| "the redacted tree is not JSON")?;
        exact_keys(
            &value,
            &[
                "format",
                "network",
                "registry",
                "asset",
                "attestation_id",
                "snapshot_ledger",
                "context_hash",
                "root",
                "tree_depth",
                "count",
                "transaction_hash",
                "leaves",
            ],
        )?;
        if text(&value, "format")? != RETAINED_TREE_FORMAT {
            return Err("the redacted tree format is unsupported".into());
        }
        let binding = binding(env, &value)?;
        if binding.tree_depth == 0 || binding.tree_depth > u32::BITS {
            return Err("the tree depth cannot use u32 positions".into());
        }
        let capacity = 1usize
            .checked_shl(binding.tree_depth)
            .ok_or("the tree capacity does not fit this host")?;
        let leaves = value["leaves"]
            .as_array()
            .ok_or("the redacted tree must have leaves")?;
        if leaves.len() != capacity {
            return Err("the redacted tree must contain every leaf".into());
        }
        text(&value, "transaction_hash")?;
        let mut identifiers = HashSet::new();
        let mut padded = false;
        let mut entries = Vec::with_capacity(capacity);
        let mut hashes = Vec::with_capacity(capacity);
        for entry in leaves {
            exact_keys(entry, &["id", "commitment"])?;
            let id = field(env, entry, "id")?;
            let commitment = field(env, entry, "commitment")?;
            if id == BigUint::from(PADDING_LEAF_ID) {
                padded = true;
            } else {
                if padded {
                    return Err("a customer follows a padding leaf".into());
                }
                if !identifiers.insert(id.clone()) {
                    return Err("a customer identifier repeats".into());
                }
            }
            hashes.push(leaf_hash(env, &to_fr(env, &id), &to_fr(env, &commitment)));
            entries.push((id, commitment));
        }
        let count = identifiers.len();
        if value["count"].as_u64() != Some(count as u64) {
            return Err("the customer count differs from the redacted leaves".into());
        }
        let levels = tree_levels(env, &hashes);
        if levels.last().and_then(|level| level.first()).map(to_big) != Some(binding.root.clone()) {
            return Err("the redacted tree does not reach its root".into());
        }
        Ok(Self {
            binding,
            entries,
            levels,
            count,
        })
    }

    pub fn identifiers(&self) -> impl Iterator<Item = &BigUint> {
        self.entries[..self.count].iter().map(|(id, _)| id)
    }

    pub fn answer(&self, request: &AnswerRequest) -> Result<String, String> {
        if self.binding != request.binding {
            return Err("the redacted tree differs from the requested attestation".into());
        }
        let position = self.entries[..self.count]
            .iter()
            .position(|(id, _)| *id == request.identifier)
            .ok_or("the requested identifier is absent from the redacted tree")?;
        let (id, commitment) = &self.entries[position];
        let path: Vec<String> = path_in_levels(&self.levels, position)
            .iter()
            .map(|element| fr_hex(&to_big(element)))
            .collect();
        let answer = serde_json::json!({
            "id": fr_hex(id), "commitment": fr_hex(commitment),
            "position": u32::try_from(position).map_err(|_| "the position does not fit u32")?,
            "path": path,
        });
        serde_json::to_string_pretty(&answer)
            .map(|text| text + "\n")
            .map_err(|_| "cannot encode the answer".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tree::root_from_path;

    const DEPTH: u32 = 2;
    const CUSTOMER_COUNT: usize = 3;

    fn fixture(env: &Env) -> Value {
        let entries: Vec<Value> = (0..1usize << DEPTH).map(|index| {
            serde_json::json!({
                "id": fr_hex(&BigUint::from(if index < CUSTOMER_COUNT { index + 1 } else { 0 })),
                "commitment": fr_hex(&BigUint::from(index + 100)),
            })
        }).collect();
        let hashes: Vec<U256> = entries
            .iter()
            .map(|entry| {
                leaf_hash(
                    env,
                    &to_fr(env, &field(env, entry, "id").unwrap()),
                    &to_fr(env, &field(env, entry, "commitment").unwrap()),
                )
            })
            .collect();
        serde_json::json!({
            "format": RETAINED_TREE_FORMAT, "network": "testnet", "registry": "registry",
            "asset": "asset", "attestation_id": "2", "snapshot_ledger": 100,
            "context_hash": fr_hex(&BigUint::from(99u32)),
            "root": fr_hex(&to_big(&crate::tree::subtree_root(env, &hashes))),
            "tree_depth": DEPTH, "count": CUSTOMER_COUNT, "transaction_hash": "transaction",
            "leaves": entries,
        })
    }

    fn request(value: &Value, identifier: u32) -> Value {
        let mut request = value.clone();
        let object = request.as_object_mut().unwrap();
        for key in ["format", "count", "transaction_hash", "leaves"] {
            object.remove(key);
        }
        object.insert(
            "identifier".into(),
            Value::String(fr_hex(&BigUint::from(identifier))),
        );
        request
    }

    #[test]
    fn every_customer_answer_reaches_the_fixed_root_and_has_only_redacted_fields() {
        let env = crate::new_env();
        let manifest = fixture(&env);
        let tree = RetainedTree::parse(&env, &manifest.to_string()).unwrap();
        for id in 1..=CUSTOMER_COUNT as u32 {
            let request = AnswerRequest::parse(&env, &request(&manifest, id).to_string()).unwrap();
            let answer: Value = serde_json::from_str(&tree.answer(&request).unwrap()).unwrap();
            exact_keys(&answer, &["id", "commitment", "position", "path"]).unwrap();
            let path: Vec<U256> = answer["path"]
                .as_array()
                .unwrap()
                .iter()
                .map(|item| {
                    to_fr(
                        &env,
                        &parse_package_fr(&env, item.as_str().unwrap()).unwrap(),
                    )
                })
                .collect();
            let leaf = leaf_hash(
                &env,
                &to_fr(&env, &field(&env, &answer, "id").unwrap()),
                &to_fr(&env, &field(&env, &answer, "commitment").unwrap()),
            );
            let root = root_from_path(
                &env,
                &leaf,
                answer["position"].as_u64().unwrap(),
                &path,
                DEPTH as usize,
            )
            .unwrap();
            assert_eq!(to_big(&root), tree.binding.root);
        }
    }

    #[test]
    fn changed_binding_or_absent_identifier_cannot_produce_an_answer() {
        let env = crate::new_env();
        let manifest = fixture(&env);
        let tree = RetainedTree::parse(&env, &manifest.to_string()).unwrap();
        for (key, replacement) in [
            ("network", Value::String("other".into())),
            ("registry", Value::String("other".into())),
            ("asset", Value::String("other".into())),
            ("attestation_id", Value::String("3".into())),
            ("snapshot_ledger", Value::from(101)),
            (
                "context_hash",
                Value::String(fr_hex(&BigUint::from(100u32))),
            ),
            ("root", Value::String(fr_hex(&BigUint::from(100u32)))),
            ("tree_depth", Value::from(DEPTH + 1)),
            ("identifier", Value::String(fr_hex(&BigUint::from(99u32)))),
        ] {
            let mut changed = request(&manifest, 1);
            changed[key] = replacement;
            let parsed = AnswerRequest::parse(&env, &changed.to_string()).unwrap();
            assert!(tree.answer(&parsed).is_err(), "{key}");
        }
        assert!(AnswerRequest::parse(&env, &request(&manifest, 0).to_string()).is_err());
    }

    #[test]
    fn incomplete_changed_or_nonredacted_trees_are_refused() {
        let env = crate::new_env();
        let manifest = fixture(&env);
        let mut variants = Vec::new();
        let mut short = manifest.clone();
        short["leaves"].as_array_mut().unwrap().pop();
        variants.push(short);
        let mut changed = manifest.clone();
        changed["leaves"][0]["commitment"] = Value::String(fr_hex(&BigUint::from(999u32)));
        variants.push(changed);
        let mut duplicate = manifest.clone();
        duplicate["leaves"][1]["id"] = duplicate["leaves"][0]["id"].clone();
        variants.push(duplicate);
        let mut padded = manifest.clone();
        padded["leaves"][0]["id"] = Value::String(fr_hex(&BigUint::from(PADDING_LEAF_ID)));
        variants.push(padded);
        let mut private = manifest.clone();
        private["leaves"][0]["balance"] = Value::from(123);
        variants.push(private);
        let mut wrong_count = manifest;
        wrong_count["count"] = Value::from(0);
        variants.push(wrong_count);
        for variant in variants {
            assert!(RetainedTree::parse(&env, &variant.to_string()).is_err());
        }
    }
}
