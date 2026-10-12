use num_bigint::BigUint;
use zkpor_context::fr_modulus;
use zkpor_package::{
    fr::{fr_hex, to_big},
    identity::{
        canonical_email, derive_identifier, identifier_subject, parse_identifier_subject,
        IDENTIFIER_DOMAIN, IDENTIFIER_RULE,
    },
    new_env,
};

#[test]
fn rust_identifier_matches_the_independent_shared_vectors() {
    let text = include_str!("../../../fixtures/identity_vectors.json");
    let vectors: serde_json::Value = serde_json::from_str(text).expect("the vector file is JSON");
    assert_eq!(vectors["rule"].as_str().unwrap(), IDENTIFIER_RULE);
    let domain_hex = vectors["domain_hex"].as_str().expect("the domain bytes");
    let actual_domain: String = IDENTIFIER_DOMAIN
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    assert_eq!(actual_domain, domain_hex);
    let cases = vectors["cases"].as_array().expect("the vector cases");
    let env = new_env();
    assert_eq!(
        vectors["fr_modulus"].as_str().unwrap(),
        to_big(&fr_modulus(&env)).to_string()
    );
    for case in cases {
        let name = case["name"].as_str().expect("the case name");
        let email = case["email"].as_str().expect("the email");
        let canonical = case["canonical_email"]
            .as_str()
            .expect("the canonical email");
        let code = case["code"].as_str().expect("the code");
        let expected = BigUint::parse_bytes(
            case["id_decimal"]
                .as_str()
                .expect("the decimal identifier")
                .as_bytes(),
            10,
        )
        .expect("the decimal identifier parses");
        let subject = case["subject"].as_str().expect("the subject");
        assert_eq!(canonical_email(email).unwrap(), canonical, "{name}");
        let actual = derive_identifier(&env, email, code).unwrap();
        assert_eq!(actual, expected, "{name}");
        assert_eq!(fr_hex(&actual), case["id_hex"].as_str().unwrap(), "{name}");
        assert_eq!(
            identifier_subject(&env, &actual).unwrap(),
            subject,
            "{name}"
        );
        assert_eq!(
            parse_identifier_subject(&env, subject).unwrap(),
            actual,
            "{name}"
        );
    }
}
