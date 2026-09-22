/** A customer identifier from an ASCII mailbox and a persistent random code. */

import { createHash, randomBytes } from "node:crypto";
import {
  EMAIL_ADDRESS_MAX_BYTES,
  EMAIL_DOMAIN_LABEL_MAX_BYTES,
  EMAIL_DOMAIN_MAX_BYTES,
  EMAIL_LOCAL_MAX_BYTES,
  FR_MODULUS,
  IDENTIFIER_CODE_BYTES,
  IDENTIFIER_DOMAIN,
  IDENTIFIER_RULE,
  IDENTIFIER_TEXT_CHARS,
  IDENTITY_PACKAGE_FORMAT,
} from "./constants.js";
import { bytesToBigint, toBytes } from "./fr.js";
import { isRecord } from "./guards.js";
import { parsePackage } from "./inclusion-package.js";
import type { InclusionPackage } from "./inclusion-package.js";

const ATEXT = /^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~]+$/;
const DOMAIN_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const IDENTIFIER_DOMAIN_BYTES = Buffer.from(IDENTIFIER_DOMAIN, "ascii");
const MAX_IDENTIFIER_COUNTER = 0xffff_ffff;

export function canonicalEmail(email: string): string {
  if (
    !/^[\x00-\x7f]*$/.test(email) ||
    email.length > EMAIL_ADDRESS_MAX_BYTES ||
    email.trim() !== email
  ) {
    throw new Error("the email address is not a supported ASCII mailbox");
  }
  const at = email.indexOf("@");
  if (at < 1 || at !== email.lastIndexOf("@")) {
    throw new Error("the email address is not a supported ASCII mailbox");
  }
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (
    local.length > EMAIL_LOCAL_MAX_BYTES ||
    local.split(".").some((atom) => !ATEXT.test(atom)) ||
    domain.length === 0 ||
    domain.length > EMAIL_DOMAIN_MAX_BYTES ||
    domain.split(".").some((label) => label.length > EMAIL_DOMAIN_LABEL_MAX_BYTES || !DOMAIN_LABEL.test(label))
  ) {
    throw new Error("the email address is not a supported ASCII mailbox");
  }
  return `${local}@${domain.toLowerCase()}`;
}

function decodeCanonical32(text: string): Buffer | undefined {
  if (!BASE64URL.test(text) || text.length !== IDENTIFIER_TEXT_CHARS) {
    return undefined;
  }
  const bytes = Buffer.from(text, "base64url");
  if (bytes.length !== IDENTIFIER_CODE_BYTES || bytes.toString("base64url") !== text) {
    return undefined;
  }
  return bytes;
}

export function deriveCustomerIdentifier(email: string, code: string): bigint {
  const canonical = canonicalEmail(email);
  const codeBytes = decodeCanonical32(code);
  if (codeBytes === undefined) {
    throw new Error("the code is not canonical 43-character base64url");
  }
  const emailBytes = Buffer.from(canonical, "ascii");
  const emailLength = Buffer.alloc(2);
  emailLength.writeUInt16BE(emailBytes.length);
  const counterBytes = Buffer.alloc(4);
  for (let counter = 0; counter <= MAX_IDENTIFIER_COUNTER; counter += 1) {
    counterBytes.writeUInt32BE(counter);
    const digest = createHash("sha256")
      .update(IDENTIFIER_DOMAIN_BYTES)
      .update(emailLength)
      .update(emailBytes)
      .update(codeBytes)
      .update(counterBytes)
      .digest();
    const id = bytesToBigint(digest) % FR_MODULUS;
    if (id !== 0n) {
      return id;
    }
  }
  throw new Error("the identifier counter is exhausted");
}

export function encodeIdentifierSubject(id: bigint): string {
  if (id === 0n) {
    throw new Error("the identifier is zero");
  }
  return Buffer.from(toBytes(id)).toString("base64url");
}

export function parseIdentifierSubject(subject: string): bigint {
  const bytes = decodeCanonical32(subject);
  if (bytes === undefined) {
    throw new Error("the subject is not a canonical field identifier");
  }
  const id = bytesToBigint(bytes);
  if (id === 0n || id >= FR_MODULUS) {
    throw new Error("the subject is not a canonical field identifier");
  }
  return id;
}

export interface IdentifierEmailDraft {
  readonly identifierRule: typeof IDENTIFIER_RULE;
  readonly email: string;
  readonly code: string;
  readonly id: bigint;
  readonly subject: string;
  readonly body: string;
}

export function prepareIdentifierEmail(email: string): IdentifierEmailDraft {
  const canonical = canonicalEmail(email);
  const code = randomBytes(IDENTIFIER_CODE_BYTES).toString("base64url");
  const id = deriveCustomerIdentifier(canonical, code);
  return {
    identifierRule: IDENTIFIER_RULE,
    email: canonical,
    code,
    id,
    subject: encodeIdentifierSubject(id),
    body: `Identifier rule: ${IDENTIFIER_RULE}.\nYour customer identifier is in the subject.\nYour private code is ${code}.\nKeep this code for your package check.\n`,
  };
}

export type OwnPackageVerdict =
  | { readonly kind: "own" }
  | { readonly kind: "foreign" }
  | { readonly kind: "unsupported-identifier-rule" };

export function checkOwnPackage(packageText: string, identityText: string): OwnPackageVerdict {
  return checkOwnIdentifier(parsePackage(packageText), identityText);
}

export function checkOwnIdentifier(entry: InclusionPackage, identityText: string): OwnPackageVerdict {
  if (entry.format !== IDENTITY_PACKAGE_FORMAT || entry.identifierRule !== IDENTIFIER_RULE) {
    return { kind: "unsupported-identifier-rule" };
  }
  let value: unknown;
  try {
    value = JSON.parse(identityText);
  } catch {
    throw new Error("the identity file is not JSON");
  }
  if (!isRecord(value) || typeof value["email"] !== "string" || typeof value["code"] !== "string") {
    throw new Error("the identity file needs an email and a code");
  }
  const id = deriveCustomerIdentifier(value["email"], value["code"]);
  return { kind: id === entry.id ? "own" : "foreign" };
}
