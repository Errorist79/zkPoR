/**
 * The serialization of a field element, and the two text forms this protocol
 * uses for an integer.
 *
 * A field element serializes as exactly 32 bytes, big-endian. The text form
 * of a package value is `0x` and exactly 64 lowercase hexadecimal digits, so
 * one field element has exactly one string and two implementations hash the
 * same bytes.
 */

import { FR_BYTES, FR_HEX_DIGITS, FR_MODULUS, MAX_U32, MAX_U64 } from "./constants.js";

/** The strict text form of a field element, as the package schema fixes it. */
const FR_HEX = /^0x[0-9a-f]{64}$/;

/** A decimal integer with no sign, no space, and no leading zero. */
const DECIMAL = /^(0|[1-9][0-9]*)$/;

/** True when the value is a field element, so below the modulus. */
export function inRange(value: bigint): boolean {
  return value >= 0n && value < FR_MODULUS;
}

/** Reduces a 32-byte value modulo the field modulus. */
export function reduce(bytes: Uint8Array): bigint {
  if (bytes.length !== FR_BYTES) {
    throw new Error(`a field element reduction takes ${FR_BYTES} bytes, not ${bytes.length}`);
  }
  return bytesToBigint(bytes) % FR_MODULUS;
}

/** Reads a big-endian byte array as an unsigned integer. */
export function bytesToBigint(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }
  return value;
}

/** Writes a field element as exactly 32 bytes, big-endian. */
export function toBytes(value: bigint): Uint8Array {
  if (!inRange(value)) {
    throw new Error("the value is not a field element");
  }
  const bytes = new Uint8Array(FR_BYTES);
  let rest = value;
  for (let index = FR_BYTES - 1; index >= 0; index -= 1) {
    bytes[index] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return bytes;
}

/** Writes a field element in the strict text form of the package schema. */
export function toHex(value: bigint): string {
  if (!inRange(value)) {
    throw new Error("the value is not a field element");
  }
  return `0x${value.toString(16).padStart(FR_HEX_DIGITS, "0")}`;
}

/**
 * Writes any value that 32 bytes hold, as `0x` and 64 lowercase hexadecimal
 * digits.
 *
 * The modulus itself is such a value, and it is not a field element, so the
 * strict writer above refuses it.
 */
export function toHex32(value: bigint): string {
  if (value < 0n || value >= 2n ** BigInt(FR_BYTES * 8)) {
    throw new Error(`the value does not fit in ${FR_BYTES} bytes`);
  }
  return `0x${value.toString(16).padStart(FR_HEX_DIGITS, "0")}`;
}

/**
 * Reads the strict text form of a field element.
 *
 * The function rejects a wrong length, an uppercase digit, a missing prefix,
 * and a value at or above the modulus. It never reduces: a reduced value names
 * another leaf than the value the authority wrote.
 */
export function parseHex(text: string, field: string): bigint {
  if (!FR_HEX.test(text)) {
    throw new Error(
      `${field} must be 0x and exactly ${FR_HEX_DIGITS} lowercase hexadecimal digits`,
    );
  }
  const value = BigInt(text);
  if (!inRange(value)) {
    throw new Error(`${field} is at or above the field modulus`);
  }
  return value;
}

/**
 * Reads a `u64` in the decimal text form of the package schema.
 *
 * A `u64` exceeds the exact integer range of a JSON number, so the schema
 * carries a balance as a string.
 */
export function parseU64Decimal(text: string, field: string): bigint {
  if (!DECIMAL.test(text)) {
    throw new Error(`${field} must be a decimal integer with no sign and no leading zero`);
  }
  const value = BigInt(text);
  if (value > MAX_U64) {
    throw new Error(`${field} is above the largest u64`);
  }
  return value;
}

/**
 * Reads a `u32` from a JSON number.
 *
 * JSON parsing accepts a fraction and a negative number silently, so both
 * need an explicit rejection here.
 */
export function parseU32(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${field} must be an integer`);
  }
  if (value < 0 || value > MAX_U32) {
    throw new Error(`${field} must be at least 0 and at most ${MAX_U32}`);
  }
  return value;
}

/** Reads the 32-byte big-endian form of a field element from a hex string. */
export function bytesFromHex(text: string): Uint8Array {
  const digits = text.startsWith("0x") ? text.slice(2) : text;
  if (digits.length % 2 !== 0) {
    throw new Error("a byte string needs an even digit count");
  }
  const bytes = new Uint8Array(digits.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    const pair = digits.slice(index * 2, index * 2 + 2);
    if (!/^[0-9a-fA-F]{2}$/.test(pair)) {
      throw new Error("a byte string holds hexadecimal digits only");
    }
    bytes[index] = Number.parseInt(pair, 16);
  }
  return bytes;
}

/**
 * Reads an ASCII string as a domain tag: the bytes of the string, left-padded
 * with zero bytes to 32 bytes, read as a big-endian integer.
 */
export function domainTag(text: string): bigint {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > FR_BYTES) {
    throw new Error("a domain tag holds at most 32 bytes");
  }
  return bytesToBigint(bytes);
}
