import { describe, expect, it } from "vitest";
import { Buffer } from "node:buffer";
import { Networks, SorobanDataBuilder, nativeToScVal, rpc, xdr } from "@stellar/stellar-sdk";
import vectors from "../../fixtures/identity_vectors.json";
import {
  canonicalEmail,
  checkOwnIdentifier,
  checkOwnPackage,
  deriveCustomerIdentifier,
  encodeIdentifierSubject,
  parseIdentifierSubject,
  prepareIdentifierEmail,
} from "../src/identity.js";
import { parsePackage } from "../src/inclusion-package.js";
import { verifyInclusion } from "../src/inclusion.js";
import { balanceCommitment, leafHash } from "../src/hashes.js";
import { rootFromPath } from "../src/tree.js";
import { toHex } from "../src/fr.js";

const REGISTRY = "CB6CFLPDNUP5DOLM23BMN3WTCYFNBDD33H2DR5H56RPC56ZP6H43TIAG";
const ASSET = "CBSQOEUZDBCKO4NYNRJJSPOLEIXVWZZ66CZXWRSVUNZTNZK7IKHNNRY3";
const EMAIL = "Alice@example.com";
const RULE = "zkpor-email-code/1";
const LOCAL_LIMIT = 64;
const LABEL_LIMIT = 63;
const ADDRESS_LIMIT = 254;
const SUBJECT_LENGTH = 43;
const CODE = "A".repeat(SUBJECT_LENGTH);
const REFERENCE_MODULUS = BigInt(vectors.fr_modulus);
const NETWORK = {
  network: "testnet",
  rpcUrl: "http://127.0.0.1:1",
  networkPassphrase: Networks.TESTNET,
  allowHttp: true,
};

function identity(email = EMAIL, code = CODE): string {
  return JSON.stringify({ email, code });
}

function rawSubject(value: bigint): string {
  return Buffer.from(value.toString(16).padStart(64, "0"), "hex").toString("base64url");
}

function legacyPackage(text: string): string {
  return text
    .replace("zkpor-inclusion/3", "zkpor-inclusion/2")
    .replace(`"identifier_rule":"${RULE}",`, "");
}

function packageText(id: bigint, sibling = 9n): string {
  const commitment = balanceCommitment({ balance: 900n, salt: 2n });
  return JSON.stringify({
    format: "zkpor-inclusion/3",
    network: NETWORK.network,
    registry: REGISTRY,
    asset: ASSET,
    snapshot_ledger: 500,
    context_hash: toHex(3n),
    attestation_id: "4",
    identifier_rule: RULE,
    leaf_index: 0,
    id: toHex(id),
    commitment: toHex(commitment),
    balance: "900",
    salt: toHex(2n),
    siblings: [toHex(sibling)],
  });
}

function serverWithRoot(root: bigint): { server: rpc.Server; reads: string[] } {
  const server = new rpc.Server(NETWORK.rpcUrl, { allowHttp: true });
  const reads: string[] = [];
  server.simulateTransaction = async (transaction): Promise<rpc.Api.SimulateTransactionResponse> => {
    const operation = transaction.toEnvelope().v1().tx().operations()[0];
    if (operation === undefined) {
      throw new Error("the read holds no operation");
    }
    reads.push(operation.body().invokeHostFunctionOp().hostFunction().invokeContract().functionName().toString());
    const retval: xdr.ScVal = nativeToScVal({
      context_hash: 3n,
      final_root: root,
      total_liabilities: 900n,
      snapshot_ledger: 500,
      reserve_sum: 1_400n,
      attested_ledger: 505,
    }, {
      type: {
        context_hash: ["symbol", "u256"],
        final_root: ["symbol", "u256"],
        total_liabilities: ["symbol", "u128"],
        snapshot_ledger: ["symbol", "u32"],
        reserve_sum: ["symbol", "i128"],
        attested_ledger: ["symbol", "u32"],
      },
    });
    return {
      id: "1", latestLedger: 506, events: [], _parsed: true,
      transactionData: new SorobanDataBuilder(), minResourceFee: "0",
      result: { auth: [], retval },
    };
  };
  server.getHealth = async () => ({
    status: "healthy", latestLedger: 506, oldestLedger: 1, ledgerRetentionWindow: 506,
  });
  return { server, reads };
}

const deploymentsText = JSON.stringify([{
  network: NETWORK.network, registry: REGISTRY, verifier: REGISTRY,
  aggregator_key_sha256: "aa", tree_depth: 1,
  registry_wasm_sha256: "a1", verifier_wasm_sha256: "b2",
}]);

describe("the email and code identifier rule", () => {
  it.each(vectors.cases)("matches the independent $name vector", (vector) => {
    const expectedId = BigInt(vector.id_decimal);
    expect(canonicalEmail(vector.email)).toBe(vector.canonical_email);
    expect(deriveCustomerIdentifier(vector.email, vector.code)).toBe(expectedId);
    expect(toHex(expectedId)).toBe(vector.id_hex);
    expect(encodeIdentifierSubject(expectedId)).toBe(vector.subject);
    expect(parseIdentifierSubject(vector.subject)).toBe(expectedId);
    expect(checkOwnPackage(packageText(expectedId), identity(vector.email, vector.code)))
      .toEqual({ kind: "own" });
  });

  it("uses reference vectors that cover unsigned digest reduction", () => {
    expect(vectors.rule).toBe(RULE);
    expect(vectors.cases.some((vector) => BigInt(`0x${vector.digest_hex}`) >= REFERENCE_MODULUS)).toBe(true);
  });

  it("keeps local-part case, folds only the domain, and makes a canonical subject", () => {
    const id = deriveCustomerIdentifier("Alice@EXAMPLE.COM", CODE);
    expect(canonicalEmail("Alice@EXAMPLE.COM")).toBe(EMAIL);
    expect(deriveCustomerIdentifier(EMAIL, CODE)).toBe(id);
    expect(deriveCustomerIdentifier("alice@example.com", CODE)).not.toBe(id);
    const subject = encodeIdentifierSubject(id);
    expect(subject).toHaveLength(SUBJECT_LENGTH);
    expect(parseIdentifierSubject(subject)).toBe(id);
    expect(() => parseIdentifierSubject(`${subject}=`)).toThrow();
    expect(() => deriveCustomerIdentifier(EMAIL, `${CODE}=`)).toThrow();
  });

  it("rejects mailbox forms outside the rule", () => {
    for (const email of [
      "alice tag@example.com", "\"alice\"@example.com", "alice@[127.0.0.1]",
      "alice..tag@example.com", "alice@-example.com", "álîce@example.com",
      "alice@exámple.com", "alice@example-.com", "alice@example..com", "alice@example.com.",
      "alice@exa_mple.com", "Alice <alice@example.com>", "alice(comment)@example.com",
      ".alice@example.com", "alice.@example.com", "@example.com", "alice@", "alice", "alice@@example.com",
      " alice@example.com", "alice@example.com ", "alice\r\n@example.com", "alice\t@example.com",
      "alice\u0000@example.com",
    ]) {
      expect(() => canonicalEmail(email)).toThrow();
    }
  });

  it("enforces the supported mailbox length boundaries", () => {
    const localBoundary = `${"a".repeat(LOCAL_LIMIT)}@example.com`;
    const labelBoundary = `a@${"b".repeat(LABEL_LIMIT)}.example`;
    const longestDomain = ["b".repeat(LABEL_LIMIT), "c".repeat(LABEL_LIMIT), "d".repeat(LABEL_LIMIT), "e".repeat(60)].join(".");
    const addressBoundary = `a@${longestDomain}`;
    expect(addressBoundary).toHaveLength(ADDRESS_LIMIT);
    for (const email of [localBoundary, labelBoundary, addressBoundary, "a@localhost", "a@0.example"]) {
      expect(canonicalEmail(email)).toBe(email);
    }
    for (const email of [
      `${"a".repeat(LOCAL_LIMIT + 1)}@example.com`,
      `a@${"b".repeat(LABEL_LIMIT + 1)}.example`,
      `aa@${longestDomain}`,
    ]) {
      expect(() => canonicalEmail(email)).toThrow();
    }
  });

  it("rejects noncanonical code text, including nonzero unused bits", () => {
    for (const code of [
      "", CODE.slice(1), `${CODE}A`, `${CODE}=`, `${CODE}\n`,
      `${"A".repeat(SUBJECT_LENGTH - 1)}B`,
      `+${CODE.slice(1)}`, `/${CODE.slice(1)}`, `é${CODE.slice(1)}`,
    ]) {
      expect(() => deriveCustomerIdentifier(EMAIL, code)).toThrow();
    }
  });

  it("accepts only canonical nonzero field identifiers in a subject", () => {
    for (const id of [1n, REFERENCE_MODULUS - 1n]) {
      expect(parseIdentifierSubject(rawSubject(id))).toBe(id);
      expect(encodeIdentifierSubject(id)).toBe(rawSubject(id));
    }
    for (const id of [0n, REFERENCE_MODULUS, REFERENCE_MODULUS + 1n, (1n << 256n) - 1n]) {
      expect(() => parseIdentifierSubject(rawSubject(id))).toThrow();
      expect(() => encodeIdentifierSubject(id)).toThrow();
    }
    expect(() => encodeIdentifierSubject(-1n)).toThrow();
    const one = rawSubject(1n);
    for (const subject of [
      "", one.slice(1), `${one}A`, `${one}=`, `${one}\n`,
      `${one.slice(0, -1)}F`, `+${one.slice(1)}`, `/${one.slice(1)}`,
    ]) {
      expect(() => parseIdentifierSubject(subject)).toThrow();
    }
  });

  it("rejects a foreign email or code for the same package", () => {
    const text = packageText(deriveCustomerIdentifier(EMAIL, CODE));
    expect(checkOwnPackage(text, identity("Alice@EXAMPLE.COM"))).toEqual({ kind: "own" });
    expect(checkOwnPackage(text, identity("Bob@example.com"))).toEqual({ kind: "foreign" });
    expect(checkOwnPackage(text, identity(EMAIL, rawSubject(1n)))).toEqual({ kind: "foreign" });
  });

  it("requires the identifier rule in both the serialized package and the parsed object", () => {
    const text = packageText(deriveCustomerIdentifier(EMAIL, CODE));
    expect(() => parsePackage(text.replace(`"identifier_rule":"${RULE}",`, ""))).toThrow();
    expect(() => parsePackage(text.replace(RULE, "zkpor-email-code/2"))).toThrow();
    const oldText = legacyPackage(text);
    expect(checkOwnPackage(oldText, identity())).toEqual({ kind: "unsupported-identifier-rule" });
    const missingRule = { ...parsePackage(oldText), format: "zkpor-inclusion/3" };
    expect(checkOwnIdentifier(missingRule, identity())).toEqual({ kind: "unsupported-identifier-rule" });
    const wrongRule = parsePackage(text);
    // JavaScript callers can pass an object that breaks the TypeScript type.
    Object.defineProperty(wrongRule, "identifierRule", { value: "zkpor-email-code/2" });
    expect(checkOwnIdentifier(wrongRule, identity())).toEqual({ kind: "unsupported-identifier-rule" });
  });

  it("rejects malformed identity data before a positive claim", () => {
    const text = packageText(deriveCustomerIdentifier(EMAIL, CODE));
    for (const identityText of ["{", "null", "[]", "{}", JSON.stringify({ email: EMAIL }), JSON.stringify({ email: 1, code: CODE })]) {
      expect(() => checkOwnPackage(text, identityText)).toThrow();
    }
    expect(() => checkOwnPackage(text, identity(EMAIL, "invalid"))).toThrow();
  });

  it("creates a draft whose saved identity reproduces its identifier", () => {
    const draft = prepareIdentifierEmail("Alice@EXAMPLE.COM");
    expect(draft.identifierRule).toBe(RULE);
    expect(draft.email).toBe(EMAIL);
    expect(draft.code).toHaveLength(SUBJECT_LENGTH);
    expect(draft.subject).toHaveLength(SUBJECT_LENGTH);
    expect(draft.body).toContain(RULE);
    expect(draft.body).toContain(draft.code);
    expect(deriveCustomerIdentifier(draft.email, draft.code)).toBe(draft.id);
    expect(parseIdentifierSubject(draft.subject)).toBe(draft.id);
    const savedIdentity = identity(draft.email, draft.code);
    expect(checkOwnPackage(packageText(draft.id), savedIdentity)).toEqual({ kind: "own" });
  });

  it("requires identity and inclusion before a successful own claim", async () => {
    const id = deriveCustomerIdentifier(EMAIL, CODE);
    const text = packageText(id);
    expect(checkOwnPackage(text, identity())).toEqual({ kind: "own" });
    expect(checkOwnPackage(text, identity("alice@example.com"))).toEqual({ kind: "foreign" });
    const commitment = balanceCommitment({ balance: 900n, salt: 2n });
    const root = rootFromPath({ leaf: leafHash({ id, commitment }), leafIndex: 0, siblings: [9n], depth: 1 });
    const { server, reads } = serverWithRoot(root);
    const input = { packageText: text, deploymentsText, server, config: NETWORK, readOptions: {}, identityText: identity() };
    await expect(verifyInclusion(input)).resolves.toMatchObject({ kind: "included", identityConfirmed: true });
    expect(reads).toEqual(["get_attestation"]);

    const wrong = serverWithRoot(root + 1n);
    await expect(verifyInclusion({ ...input, server: wrong.server })).resolves.toMatchObject({ kind: "root-mismatch" });
    const foreign = serverWithRoot(root);
    await expect(verifyInclusion({ ...input, server: foreign.server, identityText: identity("alice@example.com") }))
      .resolves.toMatchObject({ kind: "foreign-identifier" });
    expect(foreign.reads).toEqual([]);
    const legacy = serverWithRoot(root);
    const oldPackage = legacyPackage(text);
    await expect(verifyInclusion({ ...input, server: legacy.server, packageText: oldPackage }))
      .resolves.toMatchObject({ kind: "unsupported-identifier-rule" });
    expect(legacy.reads).toEqual([]);
  });
});
