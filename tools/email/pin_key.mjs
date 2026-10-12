import { createHash } from "node:crypto";
import { copyFileSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PUBLIC_INPUT_COUNT = 9;
const pins = Object.fromEntries(Array.from(readFileSync(resolve(ROOT, "scripts/versions.env"), "utf8").matchAll(/^([A-Z_]+)="([^"]*)"$/gm), (match) => [match[1], match[2]]));
for (const name of ["EMAIL_NARGO_VERSION", "BB_VERSION", "PROOF_SCHEME", "TERMINAL_ORACLE_HASH", "ZKEMAIL_REV"]) {
  if (!pins[name]) throw new Error(`the ${name} pin is absent`);
}
const [compiledPath, keyPath] = process.argv.slice(2);
if (!compiledPath || !keyPath) throw new Error("usage: pin_key.mjs COMPILED_CIRCUIT VK");
const compiled = JSON.parse(readFileSync(compiledPath, "utf8"));
const returned = compiled.abi?.return_type;
if (returned?.visibility !== "public" || returned?.abi_type?.kind !== "array"
    || returned.abi_type.length !== PUBLIC_INPUT_COUNT || returned.abi_type.type?.kind !== "field") {
  throw new Error("the compiled email circuit must return nine public fields");
}
if (!Array.isArray(compiled.abi.parameters) || compiled.abi.parameters.some((parameter) => parameter.visibility !== "private")) {
  throw new Error("an email witness argument is public");
}
const key = readFileSync(keyPath);
const hash = createHash("sha256").update(key).digest();
const circuitRoot = resolve(ROOT, "circuits/email");
function circuitSources(directory) {
  return readdirSync(resolve(circuitRoot, directory), { withFileTypes: true }).flatMap((entry) => {
    const name = `${directory}/${entry.name}`;
    return entry.isDirectory() ? circuitSources(name) : entry.name.endsWith(".nr") ? [name] : [];
  });
}
const sourceHash = createHash("sha256");
for (const name of ["Nargo.toml", ...circuitSources("src")].sort()) {
  sourceHash.update(name).update("\0").update(readFileSync(resolve(circuitRoot, name))).update("\0");
}
const rows = [];
for (let offset = 0; offset < hash.length; offset += 8) {
  rows.push(`    ${Array.from(hash.subarray(offset, offset + 8), (byte) => `0x${byte.toString(16).padStart(2, "0")}`).join(", ")},`);
}
const source = [
  "//! Generated from the compiled email verification key. Do not edit by hand.", "",
  "#[rustfmt::skip]", "pub const EMAIL_KEY_SHA256: [u8; 32] = [", ...rows, "];", "",
  `pub const PUBLIC_INPUT_COUNT: u32 = ${PUBLIC_INPUT_COUNT};`, "",
].join("\n");
copyFileSync(keyPath, resolve(ROOT, "circuits/email/vk"));
writeFileSync(resolve(ROOT, "contracts/registry/src/email_params.rs"), source);
writeFileSync(resolve(ROOT, "circuits/email/manifest.json"), JSON.stringify({
  format: "zkpor-email-circuit/1",
  nargo: pins.EMAIL_NARGO_VERSION,
  bb: pins.BB_VERSION.replace(/^v/, ""),
  scheme: pins.PROOF_SCHEME,
  oracle_hash: pins.TERMINAL_ORACLE_HASH,
  zkemail_commit: pins.ZKEMAIL_REV,
  key_sha256: hash.toString("hex"),
  key_bytes: key.length,
  source_sha256: sourceHash.digest("hex"),
  public_input_count: PUBLIC_INPUT_COUNT,
}, null, 2) + "\n");
