//! The liabilities tree and the authentication path.

use soroban_sdk::{Env, U256};
use zkpor_context::node_hash;

/// One step of the bottom-up fold: each adjacent pair becomes its parent.
pub fn fold_level(env: &Env, level: &[U256]) -> Vec<U256> {
    (0..level.len() / 2)
        .map(|k| node_hash(env, &level[2 * k], &level[2 * k + 1]))
        .collect()
}

/// Root of a full binary tree over `leaves` (len a power of two, >= 2).
/// Pairwise bottom-up; identical pairing order to common/lib.nr subtree_root.
pub fn subtree_root(env: &Env, leaves: &[U256]) -> U256 {
    let mut level: Vec<U256> = leaves.to_vec();
    while level.len() > 1 {
        level = fold_level(env, &level);
    }
    level.into_iter().next().expect("non-empty tree")
}

/// Every level of the tree, from the leaves up to the root. A caller that
/// needs more than one path folds the tree once and reads each path from here.
pub fn tree_levels(env: &Env, leaves: &[U256]) -> Vec<Vec<U256>> {
    let mut levels = vec![leaves.to_vec()];
    while levels.last().expect("the leaf level").len() > 1 {
        levels.push(fold_level(env, levels.last().expect("the level below")));
    }
    levels
}

/// The sibling hashes of one leaf, from the leaf level up to the level below
/// the root.
///
/// The path holds no direction bit. The bit of the index at each level states
/// whether the current node is the left input or the right input, so no stored
/// bit can disagree with the index.
pub fn path_in_levels(levels: &[Vec<U256>], global_index: usize) -> Vec<U256> {
    let leaf_count = levels.first().expect("the leaf level").len();
    assert!(
        global_index < leaf_count,
        "leaf index {global_index} is outside a tree of {leaf_count} leaves"
    );
    let mut index = global_index;
    let mut siblings = Vec::new();
    for level in &levels[..levels.len() - 1] {
        siblings.push(level[index ^ 1].clone());
        index >>= 1;
    }
    siblings
}

/// Recomputes the root from one leaf and its authentication path.
///
/// `depth` comes from the tree shape, which is public. A path of another
/// length fails here, so a short path cannot produce a value that looks like a
/// root. The index must sit inside the tree: the walk reads only the low bits
/// of the index, so an unchecked high bit would let two indices name one path.
pub fn root_from_path(
    env: &Env,
    leaf: &U256,
    global_index: u64,
    siblings: &[U256],
    depth: usize,
) -> Result<U256, String> {
    if siblings.len() != depth {
        return Err(format!(
            "the path holds {} siblings, and a tree of depth {depth} needs one for each level",
            siblings.len()
        ));
    }
    if depth >= u64::BITS as usize || global_index >= 1u64 << depth {
        return Err(format!(
            "leaf index {global_index} is outside a tree of depth {depth}"
        ));
    }
    let mut node = leaf.clone();
    for (level, sibling) in siblings.iter().enumerate() {
        node = if (global_index >> level) & 1 == 0 {
            node_hash(env, &node, sibling)
        } else {
            node_hash(env, sibling, &node)
        };
    }
    Ok(node)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fr::{to_big, to_fr};
    use num_bigint::BigUint;
    use zkpor_context::leaf_hash;

    const DEPTH: usize = 4;
    const CAPACITY: usize = 1 << DEPTH;

    fn env() -> Env {
        crate::new_env()
    }

    fn leaves(env: &Env, count: usize) -> Vec<U256> {
        (0..count)
            .map(|i| {
                let id = to_fr(env, &BigUint::from(i as u64 + 1));
                let salt = to_fr(env, &BigUint::from(i as u64 + 1000));
                leaf_hash(env, &id, i as u64 * 7 + 1, &salt)
            })
            .collect()
    }

    #[test]
    fn every_path_recomputes_the_root_of_the_tree() {
        let env = env();
        let tree = leaves(&env, CAPACITY);
        let root = subtree_root(&env, &tree);
        let levels = tree_levels(&env, &tree);
        for (index, leaf) in tree.iter().enumerate() {
            let siblings = path_in_levels(&levels, index);
            assert_eq!(siblings.len(), DEPTH);
            assert_eq!(
                root_from_path(&env, leaf, index as u64, &siblings, DEPTH).unwrap(),
                root,
                "leaf {index}"
            );
        }
    }

    /// The index alone states the direction, so the same siblings under
    /// another index give another value.
    #[test]
    fn another_index_over_the_same_path_gives_another_root() {
        let env = env();
        let tree = leaves(&env, CAPACITY);
        let root = subtree_root(&env, &tree);
        let siblings = path_in_levels(&tree_levels(&env, &tree), 5);
        for wrong in [0, 4, 7, 13, CAPACITY as u64 - 1] {
            assert_ne!(
                root_from_path(&env, &tree[5], wrong, &siblings, DEPTH).unwrap(),
                root,
                "index {wrong} must not reach the root of leaf 5"
            );
        }
    }

    #[test]
    fn a_truncated_path_gives_no_root() {
        let env = env();
        let tree = leaves(&env, CAPACITY);
        let siblings = path_in_levels(&tree_levels(&env, &tree), 5);
        assert!(root_from_path(&env, &tree[5], 5, &siblings[..2], DEPTH).is_err());
    }

    #[test]
    fn an_index_at_the_capacity_gives_no_root() {
        let env = env();
        let tree = leaves(&env, CAPACITY);
        let siblings = path_in_levels(&tree_levels(&env, &tree), 5);
        assert!(root_from_path(&env, &tree[5], CAPACITY as u64, &siblings, DEPTH).is_err());
    }

    #[test]
    #[should_panic(expected = "outside a tree")]
    fn no_path_exists_outside_the_tree() {
        let env = env();
        let tree = leaves(&env, 8);
        path_in_levels(&tree_levels(&env, &tree), 8);
    }

    /// One changed bit in one sibling breaks the recomputation at every level.
    #[test]
    fn a_sibling_that_changed_by_one_bit_gives_another_root() {
        let env = env();
        let tree = leaves(&env, CAPACITY);
        let root = subtree_root(&env, &tree);
        let siblings = path_in_levels(&tree_levels(&env, &tree), 5);
        for level in 0..DEPTH {
            let mut changed = siblings.clone();
            changed[level] = to_fr(&env, &(to_big(&siblings[level]) ^ BigUint::from(1u32)));
            assert_ne!(
                root_from_path(&env, &tree[5], 5, &changed, DEPTH).unwrap(),
                root,
                "a changed sibling at level {level} must not reach the root"
            );
        }
    }
}
