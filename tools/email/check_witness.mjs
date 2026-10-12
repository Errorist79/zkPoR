import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { spawnSync } from "node:child_process";

const [witnessDirectory, outputDirectory] = process.argv.slice(2);
const nargo = process.env.ZKPOR_EMAIL_NARGO;
if (!witnessDirectory || !outputDirectory || !nargo || !isAbsolute(outputDirectory)) {
  throw new Error("set ZKPOR_EMAIL_NARGO; use check_witness.mjs WITNESS_DIR NEW_ABSOLUTE_PRIVATE_DIR");
}
const original = readFileSync(join(witnessDirectory, "Prover.toml"), "utf8");
const matched = /^signature = (\[.*\])$/m.exec(original);
if (!matched) throw new Error("the witness has no signature array");
const signature = JSON.parse(matched[1]);
if (!Array.isArray(signature) || typeof signature[0] !== "string") throw new Error("the signature shape is invalid");
signature[0] = (BigInt(signature[0]) ^ 1n).toString();
mkdirSync(outputDirectory, { mode: 0o700 });
cpSync(join(witnessDirectory, "src"), join(outputDirectory, "src"), { recursive: true });
cpSync(join(witnessDirectory, "Nargo.toml"), join(outputDirectory, "Nargo.toml"));
mkdirSync(join(outputDirectory, "target"), { mode: 0o700 });
cpSync(join(witnessDirectory, "target/zkpor_email.json"), join(outputDirectory, "target/zkpor_email.json"));
writeFileSync(join(outputDirectory, "Prover.toml"), original, { flag: "wx", mode: 0o600 });
function execute(name, accepted) {
  const result = spawnSync(nargo, ["execute", name], { cwd: outputDirectory, encoding: "utf8" });
  writeFileSync(join(outputDirectory, `${name}.log`), `${result.stdout ?? ""}${result.stderr ?? ""}`, { flag: "wx", mode: 0o600 });
  if (result.error || result.status === null || (result.status === 0) !== accepted) throw new Error(`unexpected witness verdict: ${name}`);
}
execute("honest", true);
writeFileSync(join(outputDirectory, "Prover.toml"), original.replace(matched[0], `signature = ${JSON.stringify(signature)}`), { mode: 0o600 });
execute("changed-signature", false);
console.log("The honest witness passed. The changed RSA signature was rejected.");
