import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { createRequire } from "node:module";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FR_MODULUS, parseIdentifierSubject, toHex } from "../../sdk/dist/index.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const HEADER_BOUND = 1024;
const FROM_BOUND = 320;
const SUBJECT_LENGTH = 43;
const KEY_BITS = 2048;
const KEY_LIMBS = 18;
const PREPARED_FORMAT = "zkpor-email-witness/1";
let stage = "start";
const require = createRequire(import.meta.url);
const helperModule = process.env.ZKPOR_EMAIL_HELPERS_MODULE ?? "@zk-email/zkemail-nr";
const helpers = require(helperModule);
const helperPath = require.resolve(helperModule);
const helperPackage = JSON.parse(readFileSync(resolve(dirname(helperPath), "../package.json"), "utf8"));
const toolPackage = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
if (helperPackage.name !== "@zk-email/zkemail-nr" || helperPackage.version !== toolPackage.dependencies["@zk-email/zkemail-nr"]) {
  throw new Error("the email helper differs from the package pin");
}

function privateDirectory(path) {
  if (!isAbsolute(path)) throw new Error("the output directory must be absolute");
  mkdirSync(path, { mode: 0o700 });
}

function save(path, value) {
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest();
}

function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fieldArray(value, length) {
  if (!Array.isArray(value) || value.length !== length || !value.every((item) => typeof item === "string" && /^(0|[1-9][0-9]*|0x[0-9a-fA-F]+)$/.test(item))) {
    throw new Error("the email helper returned invalid field data");
  }
  return value.map((item) => {
    const parsed = BigInt(item);
    if (parsed >= FR_MODULUS) throw new Error("the email helper returned a field outside Fr");
    return parsed.toString();
  });
}

function sequence(index, length) {
  return { index: String(index), length: String(length) };
}

function preparedInputs(inputs) {
  stage = "validate-helper-shape";
  if (!record(inputs) || !record(inputs.header) || !record(inputs.pubkey)) throw new Error("invalid email helper output");
  stage = "validate-header-storage";
  const storage = fieldArray(inputs.header.storage, HEADER_BOUND);
  const headerLength = Number(inputs.header.len);
  if (!Number.isSafeInteger(headerLength) || headerLength < 1 || headerLength >= HEADER_BOUND) throw new Error("the signed header exceeds the circuit bound");
  const header = Buffer.from(storage.slice(0, headerLength).map((item) => {
    const byte = Number(item);
    if (byte > 255) throw new Error("the signed header contains an invalid byte");
    return byte;
  }));
  const lines = header.toString("latin1").split("\r\n");
  let offset = 0;
  const fields = lines.map((line) => {
    const item = { line, index: offset };
    offset += Buffer.byteLength(line, "latin1") + 2;
    return item;
  });
  function one(name) {
    const found = fields.filter((item) => item.line.startsWith(`${name}:`));
    if (found.length !== 1) throw new Error(`the signed header needs one ${name} field`);
    return found[0];
  }
  stage = "select-signed-fields";
  const subject = one("subject");
  const from = one("from");
  const dkim = fields.at(-1);
  if (!dkim || !dkim.line.startsWith("dkim-signature:")) throw new Error("the final signed field is not DKIM-Signature");
  if (from.line.length > FROM_BOUND) throw new Error("the signed From field exceeds the circuit bound");
  const subjectValue = subject.line.slice("subject:".length);
  if (subjectValue.length !== SUBJECT_LENGTH) throw new Error("the signed Subject has the wrong length");
  stage = "validate-subject-identifier";
  const id = parseIdentifierSubject(subjectValue);
  stage = "select-dkim-tags";
  const tags = new Map();
  let tagOffset = dkim.index + "dkim-signature:".length;
  for (const part of dkim.line.slice("dkim-signature:".length).split(";")) {
    const text = part.trim();
    const leading = part.length - part.trimStart().length;
    if (text) {
      const matched = /^([a-z]+)=(.*)$/.exec(text);
      if (!matched || tags.has(matched[1])) throw new Error("a DKIM tag is invalid or repeated");
      tags.set(matched[1], { value: matched[2], ...sequence(tagOffset + leading, text.length) });
    }
    tagOffset += part.length + 1;
  }
  function tag(name, expected) {
    const found = tags.get(name);
    if (!found || (expected !== undefined && found.value !== expected)) throw new Error(`the DKIM ${name} tag is unsupported`);
    return found;
  }
  const domain = tag("d");
  const h = tag("h");
  const signedNames = h.value.toLowerCase().split(":").map((name) => name.trim());
  if (!signedNames.includes("from") || !signedNames.includes("subject")) throw new Error("DKIM does not cover From and Subject");
  const selected = {
    domain, algorithm: tag("a", "rsa-sha256"), canonicalization: tag("c", "relaxed/relaxed"),
    signed_headers: h, version: tag("v", "1"), signature: tag("b", ""),
  };
  stage = "validate-rsa-limbs";
  return {
    format: PREPARED_FORMAT,
    id: toHex(id),
    domain_hash: sha256(Buffer.from(domain.value, "ascii")).toString("hex"),
    from_header_hash: sha256(Buffer.from(from.line, "latin1")).toString("hex"),
    inputs: {
      signature: fieldArray(inputs.signature, KEY_LIMBS),
      header: { storage, len: String(headerLength) },
      pubkey: { modulus: fieldArray(inputs.pubkey.modulus, KEY_LIMBS), redc: fieldArray(inputs.pubkey.redc, KEY_LIMBS) },
      subject_sequence: sequence(subject.index, subject.line.length),
      from_sequence: sequence(from.index, from.line.length),
      dkim_sequence: sequence(dkim.index, dkim.line.length),
      tags: Object.fromEntries(Object.entries(selected).map(([name, value]) => [name, sequence(value.index, value.length)])),
    },
  };
}

async function prepare(inputs, directory) {
  const prepared = preparedInputs(inputs);
  stage = "hash-rsa-key";
  const hashes = await helpers.hashRSAPublicKey(prepared.inputs.pubkey.modulus.map(BigInt), prepared.inputs.pubkey.redc.map(BigInt));
  stage = "create-private-directory";
  privateDirectory(directory);
  stage = "save-prepared-inputs";
  save(join(directory, "prepared.json"), prepared);
  save(join(directory, "registration.json"), {
    modulus_hash: toHex(hashes.modulusHash), redc_hash: toHex(hashes.redcHash),
    domain_hash: prepared.domain_hash, from_header_hash: prepared.from_header_hash,
  });
}

function synthetic() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: KEY_BITS, publicExponent: 65537 });
  const jwk = publicKey.export({ format: "jwk" });
  if (typeof jwk.n !== "string") throw new Error("the synthetic RSA key has no modulus");
  const subject = Buffer.from([...new Array(31).fill(0), 1]).toString("base64url");
  const body = Buffer.from("Synthetic email fixture.\r\n", "ascii");
  const bodyHash = sha256(body).toString("base64");
  const signed = [
    "from:zkPoR Fixture <issuer@example.test>", "to:customer@example.test", `subject:${subject}`,
    `dkim-signature:v=1; a=rsa-sha256; c=relaxed/relaxed; d=example.test; s=fixture; h=from:to:subject:from:subject; bh=${bodyHash}; b=`,
  ].join("\r\n");
  const header = Buffer.from(signed, "ascii");
  const signature = sign("RSA-SHA256", header, privateKey);
  return helpers.generateEmailVerifierInputsFromDKIMResult({
    headers: header, body, bodyHash,
    publicKey: BigInt(`0x${Buffer.from(jwk.n, "base64url").toString("hex")}`),
    signature: BigInt(`0x${signature.toString("hex")}`), modulusLength: KEY_BITS,
  }, { maxHeadersLength: HEADER_BOUND, ignoreBodyHashCheck: true });
}

function proverToml(inputs, context) {
  const lines = [`application_context = "${context}"`, `signature = ${JSON.stringify(inputs.signature)}`];
  function table(name, value) {
    lines.push(`\n[${name}]`);
    for (const [key, item] of Object.entries(value)) lines.push(`${key} = ${JSON.stringify(item)}`);
  }
  for (const name of ["header", "pubkey", "subject_sequence", "from_sequence", "dkim_sequence"]) table(name, inputs[name]);
  for (const [name, value] of Object.entries(inputs.tags)) table(`tags.${name}`, value);
  return lines.join("\n") + "\n";
}

async function main() {
  const [command, first, second, third] = process.argv.slice(2);
  if (command === "synthetic" && first && !second) {
    await prepare(synthetic(), first);
  } else if (command === "prepare" && first && second && !third) {
    const raw = readFileSync(first);
    const rawHeaders = raw.toString("latin1").split("\r\n\r\n", 1)[0].replace(/\r\n[ \t]+/g, " ");
    for (const name of ["from", "subject"]) {
      if (rawHeaders.split("\r\n").filter((line) => line.toLowerCase().startsWith(`${name}:`)).length !== 1) {
        throw new Error(`the email needs exactly one ${name} field`);
      }
    }
    stage = "verify-dkim-and-build-inputs";
    const inputs = await helpers.generateEmailVerifierInputs(raw, { maxHeadersLength: HEADER_BOUND, ignoreBodyHashCheck: true });
    await prepare(inputs, second);
  } else if (command === "witness" && first && second && third) {
    if (!/^(0x[0-9a-f]{64}|[1-9][0-9]*)$/.test(second)) throw new Error("the registration context is invalid");
    const context = BigInt(second);
    if (context <= 0n || context >= FR_MODULUS) throw new Error("the registration context is outside Fr");
    const prepared = JSON.parse(readFileSync(join(first, "prepared.json"), "utf8"));
    if (!record(prepared) || prepared.format !== PREPARED_FORMAT) throw new Error("the prepared witness format is invalid");
    const checked = preparedInputs(prepared.inputs);
    privateDirectory(third);
    cpSync(join(ROOT, "circuits/email/src"), join(third, "src"), { recursive: true });
    cpSync(join(ROOT, "circuits/email/Nargo.toml"), join(third, "Nargo.toml"));
    save(join(third, "Prover.toml"), proverToml(checked.inputs, context.toString()));
    save(join(third, "identifier.json"), { id: checked.id });
  } else {
    throw new Error("usage: witness.mjs prepare EMAIL NEW_DIR | synthetic NEW_DIR | witness PREPARED_DIR CONTEXT NEW_DIR");
  }
}

main().catch(() => {
  console.error(`Email input preparation failed at ${stage}. No private input is printed.`);
  process.exitCode = 1;
});
