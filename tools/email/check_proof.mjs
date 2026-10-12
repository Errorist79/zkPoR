import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { spawnSync } from "node:child_process";
import { toHex } from "../../sdk/dist/index.js";

const FIELD_BYTES = 32;
const HASH_HALF_BYTES = 16;
const SUBJECT_PACK_BYTES = 31;
const pins = Object.fromEntries(Array.from(readFileSync(new URL("../../scripts/versions.env", import.meta.url), "utf8").matchAll(/^([A-Z_]+)="([^"]*)"$/gm), (match) => [match[1], match[2]]));
if (!pins.PROOF_SCHEME || !pins.TERMINAL_ORACLE_HASH) throw new Error("the proof format pins are absent");
const [preparedPath, contextText, proofDirectory, outputDirectory] = process.argv.slice(2);
if (!preparedPath || !contextText || !proofDirectory || !outputDirectory) {
  throw new Error("usage: check_proof.mjs PREPARED_DIR CONTEXT PROOF_DIR NEW_PRIVATE_DIR");
}
if (!isAbsolute(outputDirectory)) throw new Error("the proof check directory must be absolute");
const prepared = JSON.parse(readFileSync(join(preparedPath, "prepared.json"), "utf8"));
const registration = JSON.parse(readFileSync(join(preparedPath, "registration.json"), "utf8"));
const id = BigInt(prepared.id);
const subject = Buffer.from(Buffer.from(toHex(id).slice(2), "hex").toString("base64url"), "ascii");
const parts = [contextText, registration.modulus_hash, registration.redc_hash].map((value) => Buffer.from(toHex(BigInt(value)).slice(2), "hex"));
for (const hash of [registration.domain_hash, registration.from_header_hash]) {
  const bytes = Buffer.from(hash, "hex");
  for (let offset = 0; offset < FIELD_BYTES; offset += HASH_HALF_BYTES) {
    parts.push(Buffer.concat([Buffer.alloc(HASH_HALF_BYTES), bytes.subarray(offset, offset + HASH_HALF_BYTES)]));
  }
}
for (let offset = 0; offset < subject.length; offset += SUBJECT_PACK_BYTES) {
  const packed = Buffer.alloc(FIELD_BYTES);
  subject.subarray(offset, offset + SUBJECT_PACK_BYTES).copy(packed, 1);
  parts.push(packed);
}
const publicInputs = readFileSync(join(proofDirectory, "public_inputs"));
if (!publicInputs.equals(Buffer.concat(parts))) throw new Error("the proof public inputs differ from the independent expected values");
mkdirSync(outputDirectory, { mode: 0o700 });
const proofBytes = readFileSync(join(proofDirectory, "proof"));
for (const [name, bytes] of [["vk", readFileSync(join(proofDirectory, "vk"))], ["honest-proof", proofBytes], ["honest-inputs", publicInputs]]) {
  writeFileSync(join(outputDirectory, name), bytes, { flag: "wx", mode: 0o600 });
}
function verify(name, proof, inputs, accepted) {
  const result = spawnSync("bb", ["verify", "--scheme", pins.PROOF_SCHEME, "--oracle_hash", pins.TERMINAL_ORACLE_HASH,
    "-k", "vk", "-p", proof, "-i", inputs], { encoding: "utf8", cwd: outputDirectory });
  writeFileSync(join(outputDirectory, `${name}.log`), `${result.stdout ?? ""}${result.stderr ?? ""}`, { flag: "wx", mode: 0o600 });
  if (result.error || result.status === null || (result.status === 0) !== accepted) throw new Error(`unexpected proof verdict: ${name}`);
}
const proofPath = "honest-proof";
const inputsPath = "honest-inputs";
verify("honest", proofPath, inputsPath, true);
for (let field = 0; field < parts.length; field += 1) {
  const changed = Buffer.from(publicInputs);
  changed[field * FIELD_BYTES + FIELD_BYTES - 1] ^= 1;
  const path = join(outputDirectory, `changed-field-${field}`);
  writeFileSync(path, changed, { flag: "wx", mode: 0o600 });
  verify(`changed-field-${field}`, proofPath, `changed-field-${field}`, false);
}
const corrupt = Buffer.from(proofBytes);
if (corrupt.length < FIELD_BYTES * 2) throw new Error("the proof is too short");
corrupt[FIELD_BYTES] ^= 1;
const corruptPath = join(outputDirectory, "corrupt-proof");
writeFileSync(corruptPath, corrupt, { flag: "wx", mode: 0o600 });
verify("corrupt-proof", "corrupt-proof", inputsPath, false);
console.log("The honest proof passed. All nine changed public fields and the corrupt proof failed.");
