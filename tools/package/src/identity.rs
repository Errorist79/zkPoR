//! The customer identifier rule and the data for one identifier email.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use num_bigint::BigUint;
use sha2::{Digest, Sha256};
use soroban_sdk::Env;
use zkpor_context::fr_modulus;

use crate::fr::to_big;

pub const IDENTIFIER_RULE: &str = "zkpor-email-code/1";
pub const LEGACY_IDENTIFIER_RULE: &str = "zkpor-legacy-id/1";
pub const IDENTIFIER_DOMAIN: &[u8] = b"zkpor-email-code-id-v1\0";
pub const IDENTIFIER_BYTES: usize = 32;
pub const IDENTIFIER_SUBJECT_CHARS: usize = 43;
pub const LOCAL_PART_MAX_BYTES: usize = 64;
pub const ADDRESS_MAX_BYTES: usize = 254;
pub const DOMAIN_MAX_BYTES: usize = 253;
pub const DOMAIN_LABEL_MAX_BYTES: usize = 63;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IdentifierRule {
    Legacy,
    EmailCodeV1,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IdentityError {
    InvalidEmail,
    InvalidCode,
    InvalidSubject,
    RandomUnavailable,
    CounterExhausted,
}

impl std::fmt::Display for IdentityError {
    fn fmt(&self, out: &mut std::fmt::Formatter) -> std::fmt::Result {
        let message = match self {
            Self::InvalidEmail => "the email address is not a supported ASCII mailbox",
            Self::InvalidCode => "the code is not canonical 43-character base64url",
            Self::InvalidSubject => "the subject is not a canonical field identifier",
            Self::RandomUnavailable => "the operating system did not provide random bytes",
            Self::CounterExhausted => "the identifier counter is exhausted",
        };
        out.write_str(message)
    }
}

impl std::error::Error for IdentityError {}

fn is_atext(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || b"!#$%&'*+-/=?^_`{|}~".contains(&byte)
}

pub fn canonical_email(email: &str) -> Result<String, IdentityError> {
    if !email.is_ascii() || email.len() > ADDRESS_MAX_BYTES || email.trim() != email {
        return Err(IdentityError::InvalidEmail);
    }
    let (local, domain) = email.split_once('@').ok_or(IdentityError::InvalidEmail)?;
    if domain.contains('@')
        || local.is_empty()
        || local.len() > LOCAL_PART_MAX_BYTES
        || domain.is_empty()
        || domain.len() > DOMAIN_MAX_BYTES
        || !local
            .split('.')
            .all(|atom| !atom.is_empty() && atom.bytes().all(is_atext))
        || !domain.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= DOMAIN_LABEL_MAX_BYTES
                && label
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
                && label.as_bytes()[0].is_ascii_alphanumeric()
                && label.as_bytes()[label.len() - 1].is_ascii_alphanumeric()
        })
    {
        return Err(IdentityError::InvalidEmail);
    }
    Ok(format!("{local}@{}", domain.to_ascii_lowercase()))
}

fn decode_canonical_32(value: &str) -> Option<[u8; IDENTIFIER_BYTES]> {
    if value.len() != IDENTIFIER_SUBJECT_CHARS {
        return None;
    }
    let bytes: [u8; IDENTIFIER_BYTES] = URL_SAFE_NO_PAD.decode(value).ok()?.try_into().ok()?;
    (URL_SAFE_NO_PAD.encode(bytes) == value).then_some(bytes)
}

pub fn decode_code(code: &str) -> Result<[u8; IDENTIFIER_BYTES], IdentityError> {
    decode_canonical_32(code).ok_or(IdentityError::InvalidCode)
}

pub fn encode_code(bytes: &[u8; IDENTIFIER_BYTES]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

pub fn derive_identifier(env: &Env, email: &str, code: &str) -> Result<BigUint, IdentityError> {
    let email = canonical_email(email)?;
    let code = decode_code(code)?;
    let modulus = to_big(&fr_modulus(env));
    for counter in 0..=u32::MAX {
        let mut hash = Sha256::new();
        hash.update(IDENTIFIER_DOMAIN);
        hash.update((email.len() as u16).to_be_bytes());
        hash.update(email.as_bytes());
        hash.update(code);
        hash.update(counter.to_be_bytes());
        let id = BigUint::from_bytes_be(&hash.finalize()) % &modulus;
        if id != BigUint::from(0u8) {
            return Ok(id);
        }
    }
    Err(IdentityError::CounterExhausted)
}

pub fn identifier_subject(env: &Env, id: &BigUint) -> Result<String, IdentityError> {
    if *id == BigUint::from(0u8) || *id >= to_big(&fr_modulus(env)) {
        return Err(IdentityError::InvalidSubject);
    }
    let bytes = id.to_bytes_be();
    let mut fixed = [0u8; IDENTIFIER_BYTES];
    fixed[IDENTIFIER_BYTES - bytes.len()..].copy_from_slice(&bytes);
    Ok(URL_SAFE_NO_PAD.encode(fixed))
}

pub fn parse_identifier_subject(env: &Env, subject: &str) -> Result<BigUint, IdentityError> {
    let bytes = decode_canonical_32(subject).ok_or(IdentityError::InvalidSubject)?;
    let id = BigUint::from_bytes_be(&bytes);
    identifier_subject(env, &id)?;
    Ok(id)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IdentifierEmailDraft {
    pub identifier_rule: &'static str,
    pub email: String,
    pub code: String,
    pub id: BigUint,
    pub subject: String,
    pub body: String,
}

pub fn prepare_identifier_email(
    env: &Env,
    email: &str,
) -> Result<IdentifierEmailDraft, IdentityError> {
    let email = canonical_email(email)?;
    let mut code_bytes = [0u8; IDENTIFIER_BYTES];
    getrandom::getrandom(&mut code_bytes).map_err(|_| IdentityError::RandomUnavailable)?;
    let code = encode_code(&code_bytes);
    let id = derive_identifier(env, &email, &code)?;
    let subject = identifier_subject(env, &id)?;
    let body = format!(
        "Identifier rule: {IDENTIFIER_RULE}.\nYour customer identifier is in the subject.\nYour private code is {code}.\nKeep this code for your package check.\n"
    );
    Ok(IdentifierEmailDraft {
        identifier_rule: IDENTIFIER_RULE,
        email,
        code,
        id,
        subject,
        body,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mailbox_rule_preserves_the_local_part_and_folds_the_domain() {
        assert_eq!(
            canonical_email("Alice.Tag@EXAMPLE.COM").unwrap(),
            "Alice.Tag@example.com"
        );
        for email in [
            "alice tag@example.com",
            "\"alice\"@example.com",
            "alice@[127.0.0.1]",
            "alice..tag@example.com",
            "alice@-example.com",
            "álîce@example.com",
        ] {
            assert_eq!(canonical_email(email), Err(IdentityError::InvalidEmail));
        }
    }

    #[test]
    fn code_and_subject_have_one_canonical_text_form() {
        let env = crate::new_env();
        let code = encode_code(&[0u8; IDENTIFIER_BYTES]);
        assert_eq!(decode_code(&code).unwrap(), [0u8; IDENTIFIER_BYTES]);
        assert!(decode_code(&format!("{code}=")).is_err());
        assert!(decode_code(&format!("+{}", &code[1..])).is_err());
        let id = derive_identifier(&env, "Alice.Tag@EXAMPLE.COM", &code).unwrap();
        let subject = identifier_subject(&env, &id).unwrap();
        assert_eq!(subject.len(), IDENTIFIER_SUBJECT_CHARS);
        assert_eq!(parse_identifier_subject(&env, &subject).unwrap(), id);
        assert_eq!(
            derive_identifier(&env, "Alice.Tag@example.com", &code).unwrap(),
            id
        );
        assert_ne!(
            derive_identifier(&env, "alice.Tag@example.com", &code).unwrap(),
            id
        );
        println!("identity vector: id={id} subject={subject} code={code}");
    }
}
