use soroban_sdk::{
    address_payload::AddressPayload, xdr::FromXdr, Address, Bytes, BytesN, Env, Vec, U256,
};
use zkpor_context::{
    context_hash, encode_address, reserve_set_hash, ContextError, ADDRESS_LIMB_BYTES,
    ADDRESS_PAYLOAD_BYTES, ADDRESS_TAG_ACCOUNT, ADDRESS_TAG_CONTRACT, FR_BYTES,
    MAX_RESERVE_ADDRESSES,
};

/// The Poseidon2 permutation is a host function, and the default budget stops a
/// test that hashes many sets.
fn test_env() -> Env {
    let env = Env::default();
    env.cost_estimate().budget().reset_unlimited();
    env
}

fn payload(pattern: u8) -> [u8; ADDRESS_PAYLOAD_BYTES] {
    [pattern; ADDRESS_PAYLOAD_BYTES]
}

fn account(env: &Env, payload: [u8; ADDRESS_PAYLOAD_BYTES]) -> Address {
    AddressPayload::AccountIdPublicKeyEd25519(BytesN::from_array(env, &payload)).to_address(env)
}

fn contract(env: &Env, payload: [u8; ADDRESS_PAYLOAD_BYTES]) -> Address {
    AddressPayload::ContractIdHash(BytesN::from_array(env, &payload)).to_address(env)
}

fn fr(env: &Env, bytes: &[u8; FR_BYTES]) -> U256 {
    U256::from_be_bytes(env, &Bytes::from_array(env, bytes))
}

fn reserves(env: &Env, addresses: &[Address]) -> Vec<Address> {
    let mut list = Vec::new(env);
    for address in addresses {
        list.push_back(address.clone());
    }
    list
}

/// Tries to build an address of a type that this protocol does not accept. The
/// XDR is an ScVal of type address, then the ScAddress body of that type. The
/// result is None when the host or the SDK refuses the value first.
fn address_of_type(env: &Env, address_type: u8, body_bytes: usize) -> Option<Address> {
    const SCVAL_ADDRESS_DISCRIMINANT: u8 = 18;
    let mut xdr = Bytes::from_array(env, &[0, 0, 0, SCVAL_ADDRESS_DISCRIMINANT]);
    xdr.append(&Bytes::from_array(env, &[0, 0, 0, address_type]));
    xdr.append(&Bytes::from_slice(env, &std::vec![7u8; body_bytes]));

    // A refused ScAddress type panics inside the host, so the panic hook is
    // silent here and the panic counts as a rejection.
    let hook = std::panic::take_hook();
    std::panic::set_hook(std::boxed::Box::new(|_| {}));
    let built = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        Address::from_xdr(env, &xdr)
    }));
    std::panic::set_hook(hook);
    built.ok().and_then(|address| address.ok())
}

#[test]
fn known_address_encodes_to_expected_limbs() {
    let env = test_env();
    let mut bytes = [0u8; ADDRESS_PAYLOAD_BYTES];
    for (index, byte) in bytes.iter_mut().enumerate() {
        *byte = index as u8 + 1;
    }

    let mut expected_hi = [0u8; FR_BYTES];
    // The tag sits in the last byte of the high group, which is the value
    // tag * 2^128.
    expected_hi[ADDRESS_LIMB_BYTES - 1] = ADDRESS_TAG_CONTRACT as u8;
    expected_hi[ADDRESS_LIMB_BYTES..].copy_from_slice(&bytes[..ADDRESS_LIMB_BYTES]);
    let mut expected_lo = [0u8; FR_BYTES];
    expected_lo[ADDRESS_LIMB_BYTES..].copy_from_slice(&bytes[ADDRESS_LIMB_BYTES..]);

    let (hi, lo) = encode_address(&env, &contract(&env, bytes)).unwrap();
    assert_eq!(hi, fr(&env, &expected_hi));
    assert_eq!(lo, fr(&env, &expected_lo));

    let mut account_hi = expected_hi;
    account_hi[ADDRESS_LIMB_BYTES - 1] = ADDRESS_TAG_ACCOUNT as u8;
    let (hi, lo) = encode_address(&env, &account(&env, bytes)).unwrap();
    assert_eq!(hi, fr(&env, &account_hi));
    assert_eq!(lo, fr(&env, &expected_lo));
}

#[test]
fn different_addresses_never_share_a_limb_pair() {
    let env = test_env();
    let mut first = payload(0);
    first[0] = 1;
    let mut last = payload(0);
    last[ADDRESS_PAYLOAD_BYTES - 1] = 1;
    let mut boundary = payload(0);
    boundary[ADDRESS_LIMB_BYTES - 1] = 1;
    let mut across = payload(0);
    across[ADDRESS_LIMB_BYTES] = 1;

    let mut encoded = std::vec::Vec::new();
    for bytes in [payload(0), first, last, boundary, across, payload(0xff)] {
        encoded.push(encode_address(&env, &account(&env, bytes)).unwrap());
        encoded.push(encode_address(&env, &contract(&env, bytes)).unwrap());
    }
    for i in 0..encoded.len() {
        for j in (i + 1)..encoded.len() {
            assert_ne!(encoded[i], encoded[j], "limb pair {i} equals limb pair {j}");
        }
    }
}

#[test]
fn no_rejected_address_type_reaches_the_encoding() {
    let env = test_env();
    // The body length of each type: an id and a key for a muxed account, a
    // union type and a hash for a claimable balance, a hash for a pool.
    const MUXED_ACCOUNT: (u8, usize) = (2, 8 + ADDRESS_PAYLOAD_BYTES);
    const CLAIMABLE_BALANCE: (u8, usize) = (3, 4 + ADDRESS_PAYLOAD_BYTES);
    const LIQUIDITY_POOL: (u8, usize) = (4, ADDRESS_PAYLOAD_BYTES);

    for (address_type, body_bytes) in [MUXED_ACCOUNT, CLAIMABLE_BALANCE, LIQUIDITY_POOL] {
        match address_of_type(&env, address_type, body_bytes) {
            None => continue,
            Some(address) => {
                assert_eq!(
                    encode_address(&env, &address),
                    Err(ContextError::UnsupportedAddressType)
                );
                assert_eq!(
                    reserve_set_hash(&env, &reserves(&env, &[address])),
                    Err(ContextError::UnsupportedAddressType)
                );
            }
        }
    }
}

#[test]
fn the_reserve_set_hash_ignores_the_submission_order() {
    let env = test_env();
    let a = account(&env, payload(1));
    let b = contract(&env, payload(1));
    let c = account(&env, payload(2));

    let ascending =
        reserve_set_hash(&env, &reserves(&env, &[a.clone(), b.clone(), c.clone()])).unwrap();
    let descending =
        reserve_set_hash(&env, &reserves(&env, &[c.clone(), b.clone(), a.clone()])).unwrap();
    let mixed = reserve_set_hash(&env, &reserves(&env, &[b, a, c])).unwrap();
    assert_eq!(ascending, descending);
    assert_eq!(ascending, mixed);
}

#[test]
fn a_duplicate_reserve_address_is_rejected() {
    let env = test_env();
    let a = account(&env, payload(1));
    let b = contract(&env, payload(2));
    let set = reserves(&env, &[a.clone(), b, a]);
    assert_eq!(
        reserve_set_hash(&env, &set),
        Err(ContextError::DuplicateReserveAddress)
    );
}

#[test]
fn an_empty_set_and_an_oversized_set_are_rejected() {
    let env = test_env();
    assert_eq!(
        reserve_set_hash(&env, &Vec::new(&env)),
        Err(ContextError::EmptyReserveSet)
    );

    let mut full = std::vec::Vec::new();
    for index in 0..MAX_RESERVE_ADDRESSES {
        full.push(account(&env, payload(index as u8)));
    }
    assert!(reserve_set_hash(&env, &reserves(&env, &full)).is_ok());

    full.push(contract(&env, payload(0)));
    assert_eq!(
        reserve_set_hash(&env, &reserves(&env, &full)),
        Err(ContextError::TooManyReserveAddresses)
    );
}

#[test]
fn sets_of_different_sizes_do_not_collide() {
    let env = test_env();
    let a = account(&env, payload(1));
    let b = account(&env, payload(2));
    let c = account(&env, payload(3));

    let one = reserve_set_hash(&env, &reserves(&env, std::slice::from_ref(&a))).unwrap();
    let two = reserve_set_hash(&env, &reserves(&env, &[a.clone(), b.clone()])).unwrap();
    let three = reserve_set_hash(&env, &reserves(&env, &[a, b, c])).unwrap();
    assert_ne!(one, two);
    assert_ne!(one, three);
    assert_ne!(two, three);
}

#[test]
fn every_context_field_changes_the_context_hash() {
    let env = test_env();
    let authority = account(&env, payload(1));
    let asset = contract(&env, payload(2));
    let set = reserve_set_hash(&env, &reserves(&env, &[account(&env, payload(3))])).unwrap();
    let other_set = reserve_set_hash(&env, &reserves(&env, &[account(&env, payload(4))])).unwrap();
    let ledger = 100u32;

    let base = context_hash(&env, &authority, &asset, &set, ledger).unwrap();
    assert_eq!(
        base,
        context_hash(&env, &authority, &asset, &set, ledger).unwrap()
    );
    assert_ne!(
        base,
        context_hash(&env, &asset, &asset, &set, ledger).unwrap()
    );
    assert_ne!(
        base,
        context_hash(&env, &authority, &authority, &set, ledger).unwrap()
    );
    assert_ne!(
        base,
        context_hash(&env, &authority, &asset, &other_set, ledger).unwrap()
    );
    assert_ne!(
        base,
        context_hash(&env, &authority, &asset, &set, ledger + 1).unwrap()
    );
}
