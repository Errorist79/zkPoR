mod common;

use common::{account, test_env, ISSUER_KEY};
use soroban_sdk::{
    xdr::{Limits, ScVal, WriteXdr},
    Bytes, BytesN, Env, IntoVal, TryFromVal, Val, Vec, U256,
};
use std::{env as std_env, fs, path::PathBuf};
use zkpor_registry::{
    Dispute, DisputeEvidence, DisputeOrigin, DisputeStatus, DkimKey, DkimKeyInput, EmailEvidence,
    InclusionEvidence, InclusionOpening,
};

const LARGE_ID: u64 = 9_007_199_254_740_993;
const VECTOR_PATH: &str = "fixtures/email_returns.json";

fn encoded<T: IntoVal<Env, Val>>(env: &Env, value: &T) -> std::string::String {
    let value: Val = value.into_val(env);
    ScVal::try_from_val(env, &value)
        .unwrap()
        .to_xdr_base64(Limits::none())
        .unwrap()
}

fn vectors(env: &Env) -> std::string::String {
    let identifier = U256::from_u32(env, 7);
    let key = DkimKey {
        key: DkimKeyInput {
            modulus_hash: U256::from_u32(env, 71),
            redc_hash: U256::from_u32(env, 73),
            domain_hash: BytesN::from_array(env, &[7; 32]),
            from_header_hash: BytesN::from_array(env, &[9; 32]),
        },
        registered_ledger: 100,
        context_hash: U256::from_u32(env, 79),
    };
    let inclusion = DisputeEvidence::Inclusion(InclusionOpening {
        attestation_id: LARGE_ID,
        inclusion: InclusionEvidence {
            id: identifier.clone(),
            commitment: U256::from_u32(env, 11),
            path: Vec::from_array(env, [U256::from_u32(env, 13)]),
            position: 0,
        },
    });
    let email = DisputeEvidence::Email(EmailEvidence {
        key_id: LARGE_ID,
        id: identifier.clone(),
        proof: Bytes::from_array(env, &[1, 2, 3]),
    });
    let mut cases = std::vec![
        std::format!("\"dkim_key\": \"{}\"", encoded(env, &key)),
        std::format!("\"inclusion_argument\": \"{}\"", encoded(env, &inclusion)),
        std::format!("\"email_argument\": \"{}\"", encoded(env, &email)),
    ];
    for (name, origin, status) in [
        (
            "inclusion_open",
            DisputeOrigin::Inclusion(LARGE_ID),
            DisputeStatus::Open,
        ),
        (
            "email_open",
            DisputeOrigin::Email(LARGE_ID),
            DisputeStatus::Open,
        ),
        (
            "email_answered",
            DisputeOrigin::Email(LARGE_ID),
            DisputeStatus::Answered,
        ),
        (
            "email_omission",
            DisputeOrigin::Email(LARGE_ID),
            DisputeStatus::OmissionProven,
        ),
    ] {
        let dispute = Dispute {
            disputer: account(env, &ISSUER_KEY),
            origin,
            target_id: LARGE_ID + 1,
            identifier: identifier.clone(),
            opened_ledger: 100,
            deadline: 51_940,
            closed_ledger: if status == DisputeStatus::Open {
                0
            } else {
                51_941
            },
            burned_bond: if status == DisputeStatus::OmissionProven {
                100_000_000
            } else {
                0
            },
            status,
        };
        cases.push(std::format!("\"{name}\": \"{}\"", encoded(env, &dispute)));
    }
    std::format!(
        "{{\n  \"large_id\": \"{LARGE_ID}\",\n  {}\n}}\n",
        cases.join(",\n  ")
    )
}

#[test]
fn email_abi_vectors_match_the_contract_types() {
    let output = vectors(&test_env());
    assert_eq!(output, vectors(&test_env()));
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(VECTOR_PATH);
    if std_env::var("ZKPOR_UPDATE_VECTORS").is_ok() {
        fs::write(path, output).unwrap();
    } else {
        assert_eq!(
            fs::read_to_string(path)
                .expect("generate the email ABI vectors with ZKPOR_UPDATE_VECTORS=1"),
            output
        );
    }
}
