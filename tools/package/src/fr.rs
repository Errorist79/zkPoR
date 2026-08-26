//! Field elements as values and as text.

use num_bigint::BigUint;
use soroban_sdk::{Bytes, Env, U256};
use zkpor_context::{fr_modulus, FR_BYTES};

/// Hexadecimal digits of one field element.
pub const FR_HEX_DIGITS: usize = FR_BYTES * 2;

/// The 32-byte big-endian serialization of a field element.
pub fn be32(value: &BigUint) -> [u8; FR_BYTES] {
    let be = value.to_bytes_be();
    assert!(
        be.len() <= FR_BYTES,
        "value does not fit in a field element"
    );
    let mut out = [0u8; FR_BYTES];
    out[FR_BYTES - be.len()..].copy_from_slice(&be);
    out
}

/// A field element as the host type of the hash functions.
pub fn to_fr(env: &Env, value: &BigUint) -> U256 {
    let element = U256::from_be_bytes(env, &Bytes::from_array(env, &be32(value)));
    assert!(
        element < fr_modulus(env),
        "value is not below the field modulus"
    );
    element
}

/// A field element as an integer.
pub fn to_big(value: &U256) -> BigUint {
    let mut bytes = [0u8; FR_BYTES];
    value.to_be_bytes().copy_into_slice(&mut bytes);
    BigUint::from_bytes_be(&bytes)
}

/// A field element as the package format holds it: `0x` and exactly 64
/// lowercase hexadecimal characters, the 32-byte big-endian serialization.
pub fn fr_hex(value: &BigUint) -> String {
    let body: String = be32(value)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    format!("0x{body}")
}

/// The 32 bytes of a hexadecimal text of exactly 64 characters.
pub fn hex_bytes(text: &str) -> Result<[u8; FR_BYTES], String> {
    if text.len() != FR_HEX_DIGITS {
        return Err(format!(
            "a value of {FR_HEX_DIGITS} hexadecimal characters is required, and this text holds {}",
            text.len()
        ));
    }
    let mut out = [0u8; FR_BYTES];
    for (index, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&text[2 * index..2 * index + 2], 16)
            .map_err(|_| format!("{text} is not hexadecimal"))?;
    }
    Ok(out)
}

/// A field element from a hexadecimal text, with or without the `0x` prefix
/// and in either case.
///
/// A command line argument and an answer of a node reach this function. The
/// package format is stricter, so a package field reaches `parse_package_fr`.
pub fn parse_fr(env: &Env, text: &str) -> Result<BigUint, String> {
    let text = text.trim();
    let value = BigUint::from_bytes_be(&hex_bytes(text.strip_prefix("0x").unwrap_or(text))?);
    if value >= to_big(&fr_modulus(env)) {
        return Err(format!("{text} is not below the field modulus"));
    }
    Ok(value)
}

/// A field element in the one form that the package format allows.
///
/// The form is part of the format, so a reader that accepted another form
/// would accept a file that no writer of this protocol produces.
pub fn parse_package_fr(env: &Env, text: &str) -> Result<BigUint, String> {
    let body = text
        .strip_prefix("0x")
        .ok_or_else(|| format!("{text} does not start with 0x"))?;
    if body.len() != FR_HEX_DIGITS {
        return Err(format!(
            "{text} does not hold {FR_HEX_DIGITS} hexadecimal characters after 0x"
        ));
    }
    if body.chars().any(|c| c.is_ascii_uppercase()) {
        return Err(format!("{text} is not lowercase"));
    }
    parse_fr(env, text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use num_bigint::BigUint;

    fn env() -> Env {
        crate::new_env()
    }

    fn modulus() -> BigUint {
        to_big(&fr_modulus(&env()))
    }

    #[test]
    fn a_field_element_is_sixty_four_lowercase_hexadecimal_characters() {
        // The expected text comes from the standard library, not from fr_hex.
        assert_eq!(fr_hex(&BigUint::from(255u32)), format!("0x{:0>64}", "ff"));
        assert_eq!(
            fr_hex(&BigUint::from(0xabcdefu32)),
            format!("0x{:0>64}", "abcdef")
        );
        // Big endian: a value of one byte sits at the end of the text.
        let high = BigUint::from(1u32) << 248;
        assert_eq!(fr_hex(&high), format!("0x01{}", "0".repeat(62)));
    }

    #[test]
    fn the_text_of_a_field_element_reads_back_as_the_same_value() {
        let env = env();
        let value = &modulus() - 1u32;
        assert_eq!(parse_package_fr(&env, &fr_hex(&value)).unwrap(), value);
    }

    #[test]
    fn the_package_form_refuses_a_missing_prefix_and_an_uppercase_digit() {
        let env = env();
        let text = fr_hex(&BigUint::from(0xabcu32));
        assert!(parse_package_fr(&env, &text[2..]).is_err());
        assert!(parse_package_fr(&env, &text.to_uppercase().replace("0X", "0x")).is_err());
        assert!(parse_package_fr(&env, "0xff").is_err());
    }

    #[test]
    fn a_value_at_the_modulus_is_not_a_field_element() {
        let env = env();
        let text = format!("0x{:064x}", modulus());
        assert!(parse_package_fr(&env, &text).is_err());
        assert!(parse_fr(&env, &text).is_err());
    }

    #[test]
    fn the_lenient_form_accepts_a_command_line_argument() {
        let env = env();
        let value = BigUint::from(1u32);
        assert_eq!(parse_fr(&env, &format!("{:064X}", value)).unwrap(), value);
        assert_eq!(
            parse_fr(&env, &format!(" {} ", fr_hex(&value))).unwrap(),
            value
        );
    }
}
