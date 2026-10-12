use std::collections::bounded_vec::BoundedVec;
use sha256::sha256_var;
use zkemail::{dkim::RSAPubkey, utils::pack_bytes, KEY_LIMBS_2048, Sequence};

mod headers;
use headers::{check_headers, DkimTags, MAX_EMAIL_HEADER_LENGTH, SUBJECT_LENGTH};

global RSA_TOP_LIMB_MIN: u128 = 128;

fn checked_key_hashes(pubkey: RSAPubkey<KEY_LIMBS_2048>) -> [Field; 2] {
    assert((pubkey.modulus[KEY_LIMBS_2048 - 1] as u128) >= RSA_TOP_LIMB_MIN, "The RSA modulus is shorter than 2048 bits");
    assert((pubkey.modulus[0] as u128) % 2 == 1, "The RSA modulus is even");
    pubkey.hash()
}

// All arguments are private. Only the returned fields are public.
fn main(
    header: BoundedVec<u8, MAX_EMAIL_HEADER_LENGTH>,
    pubkey: RSAPubkey<KEY_LIMBS_2048>,
    signature: [Field; KEY_LIMBS_2048],
    subject_sequence: Sequence,
    from_sequence: Sequence,
    dkim_sequence: Sequence,
    tags: DkimTags,
    application_context: Field,
) -> pub [Field; 9] {
    assert(application_context != 0, "The application context is zero");
    assert(header.len() <= MAX_EMAIL_HEADER_LENGTH);
    let key_hashes = checked_key_hashes(pubkey);
    let _ = pubkey.verify_dkim_signature(header, signature);
    let (subject, domain, from) = check_headers(
        header, subject_sequence, from_sequence, dkim_sequence, tags,
    );
    let domain_hash = pack_bytes::<32, 16>(sha256_var(domain.storage(), domain.len() as u64));
    let from_hash = pack_bytes::<32, 16>(sha256_var(from.storage(), from.len() as u64));
    let subject_fields = pack_bytes::<SUBJECT_LENGTH, 31>(subject);
    [
        application_context, key_hashes[0], key_hashes[1],
        domain_hash[0], domain_hash[1], from_hash[0], from_hash[1],
        subject_fields[0], subject_fields[1],
    ]
}

fn test_key(top: Field, bottom: Field) {
    let mut modulus = [0; KEY_LIMBS_2048];
    modulus[0] = bottom;
    modulus[KEY_LIMBS_2048 - 1] = top;
    let hashes = checked_key_hashes(RSAPubkey::new(modulus, [0; KEY_LIMBS_2048]));
    assert(hashes[0] != 0);
}

#[test]
fn accepts_the_modulus_size_boundaries() {
    test_key(128, 1);
    test_key(255, 1);
}

#[test(should_fail)]
fn rejects_a_short_modulus() { test_key(127, 1); }

#[test(should_fail)]
fn rejects_a_long_modulus() { test_key(256, 1); }

#[test(should_fail)]
fn rejects_an_even_modulus() { test_key(128, 2); }
