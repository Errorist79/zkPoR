use soroban_sdk::{Bytes, Env, U256};
use zkpor_context::{
    ctx_domain_tag, derive_salt, fr_reduce, leaf_hash, node_hash, salt_domain_tag, FR_BYTES,
    PADDING_LEAF_BALANCE, PADDING_LEAF_ID,
};

/// The Poseidon2 permutation is a host function, and the default budget stops
/// a test that hashes many values.
fn test_env() -> Env {
    let env = Env::default();
    env.cost_estimate().budget().reset_unlimited();
    env
}

fn fr(env: &Env, value: u32) -> U256 {
    U256::from_u32(env, value)
}

#[test]
fn every_leaf_input_changes_the_leaf() {
    let env = test_env();
    let id = fr(&env, 7);
    let salt = fr(&env, 11);
    let base = leaf_hash(&env, &id, 100, &salt);

    assert_eq!(base, leaf_hash(&env, &id, 100, &salt));
    assert_ne!(base, leaf_hash(&env, &fr(&env, 8), 100, &salt));
    assert_ne!(base, leaf_hash(&env, &id, 101, &salt));
    assert_ne!(base, leaf_hash(&env, &id, 100, &fr(&env, 12)));
}

#[test]
fn a_leaf_is_not_a_node() {
    let env = test_env();
    let id = fr(&env, 7);
    let balance = fr(&env, 100);
    // The sponge capacity holds the input count, so a three-input leaf and a
    // two-input node cannot meet even on an equal input prefix.
    for salt in [0u32, 1, 0xffff_ffff] {
        assert_ne!(
            node_hash(&env, &id, &balance),
            leaf_hash(&env, &id, 100, &fr(&env, salt))
        );
    }
}

#[test]
fn a_padding_leaf_holds_the_defined_values() {
    let env = test_env();
    let salt = fr(&env, 3);
    let padding = leaf_hash(
        &env,
        &fr(&env, PADDING_LEAF_ID),
        PADDING_LEAF_BALANCE,
        &salt,
    );
    // The salt of a padding leaf is real, so a padding leaf and a customer
    // leaf of the same shape are different values.
    assert_ne!(padding, leaf_hash(&env, &fr(&env, 1), 0, &salt));
    assert_ne!(padding, leaf_hash(&env, &fr(&env, 0), 1, &salt));
    assert_ne!(padding, leaf_hash(&env, &fr(&env, 0), 0, &fr(&env, 4)));
}

#[test]
fn every_salt_input_changes_the_salt() {
    let env = test_env();
    let secret = fr(&env, 42);
    let context = fr(&env, 99);
    let base = derive_salt(&env, &secret, &context, 0);

    assert_eq!(base, derive_salt(&env, &secret, &context, 0));
    assert_ne!(base, derive_salt(&env, &fr(&env, 43), &context, 0));
    assert_ne!(base, derive_salt(&env, &secret, &fr(&env, 100), 0));
    assert_ne!(base, derive_salt(&env, &secret, &context, 1));
}

#[test]
fn the_two_domain_tags_differ() {
    let env = test_env();
    assert_ne!(salt_domain_tag(&env), ctx_domain_tag(&env));
}

#[test]
fn the_reduction_accepts_bytes_above_the_modulus() {
    let env = test_env();
    let bytes = [0xffu8; FR_BYTES];
    let raw = U256::from_be_bytes(&env, &Bytes::from_array(&env, &bytes));
    let reduced = fr_reduce(&env, &bytes);
    assert_ne!(raw, reduced);
    // A value at or above the modulus stops the hash, so the reduced value
    // must pass. The call panics if it does not.
    derive_salt(&env, &reduced, &fr(&env, 1), 0);
}
