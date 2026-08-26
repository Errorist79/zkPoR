/**
 * The address type rejections.
 *
 * The `Address` class of the Stellar library for JavaScript parses and holds all
 * five Stellar address types, and a muxed strkey parses there normally. This
 * implementation can therefore reach every rejected type, so every rejection
 * needs a test here.
 *
 * Each test submits a well-formed strkey of the rejected type, with a valid
 * checksum, so the test proves a rejection by type and not a parse failure.
 */

import { Address, Keypair, StrKey } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import {
  ADDRESS_TAG_ACCOUNT,
  ADDRESS_TAG_CONTRACT,
  ADDRESS_PAYLOAD_BYTES,
  MAX_RESERVE_ADDRESSES,
} from "../src/constants.js";
import {
  AddressTypeError,
  ReserveSetError,
  addressParts,
  encodeAddress,
  isAcceptedAddress,
  reserveSetHash,
} from "../src/address.js";

/** The key of the account that the paired test uses. The value is test data. */
const ACCOUNT_SEED = Buffer.alloc(32, 7);

/** The multiplexing identifier of the muxed form. The value is test data. */
const MUXED_ID = Buffer.alloc(8, 0);

function accountAndMuxedOfOneKey(): { account: string; muxed: string; key: Buffer } {
  const keypair = Keypair.fromRawEd25519Seed(ACCOUNT_SEED);
  const key = keypair.rawPublicKey();
  return {
    account: keypair.publicKey(),
    muxed: StrKey.encodeMed25519PublicKey(Buffer.concat([key, MUXED_ID])),
    key,
  };
}

/** A contract address. The payload is test data. */
function contractAddress(fill: number): string {
  return StrKey.encodeContract(Buffer.alloc(ADDRESS_PAYLOAD_BYTES, fill));
}

/** A claimable balance address: one type byte and 32 bytes. */
function claimableBalanceAddress(): string {
  return StrKey.encodeClaimableBalance(
    Buffer.concat([Buffer.from([0]), Buffer.alloc(ADDRESS_PAYLOAD_BYTES, 0x33)]),
  );
}

/** A liquidity pool address: 32 bytes of pool identifier. */
function liquidityPoolAddress(): string {
  return StrKey.encodeLiquidityPool(Buffer.alloc(ADDRESS_PAYLOAD_BYTES, 0x44));
}

describe("the accepted address types", () => {
  it("accepts an account address and gives it the account tag", () => {
    const { account } = accountAndMuxedOfOneKey();
    expect(addressParts(account).tag).toBe(ADDRESS_TAG_ACCOUNT);
    expect(addressParts(account).payload).toHaveLength(ADDRESS_PAYLOAD_BYTES);
  });

  it("accepts a contract address and gives it the contract tag", () => {
    expect(addressParts(contractAddress(0x22)).tag).toBe(ADDRESS_TAG_CONTRACT);
  });

  it("gives two different limb pairs to two addresses that differ only by the tag", () => {
    const account = StrKey.encodeEd25519PublicKey(Buffer.alloc(ADDRESS_PAYLOAD_BYTES, 0x22));
    const contract = contractAddress(0x22);
    expect(encodeAddress(account)).not.toEqual(encodeAddress(contract));
  });
});

describe("the rejected address types", () => {
  /**
   * The three rejected types. Each strkey below carries a valid checksum, so a
   * failure of the rejection would be a failure of the type check and not of
   * the parser.
   */
  const rejected: { name: string; strkey: string; type: string }[] = [
    { name: "a muxed account", strkey: accountAndMuxedOfOneKey().muxed, type: "muxedAccount" },
    { name: "a claimable balance", strkey: claimableBalanceAddress(), type: "claimableBalance" },
    { name: "a liquidity pool", strkey: liquidityPoolAddress(), type: "liquidityPool" },
  ];

  it.each(rejected)("the library parses $name, and this implementation refuses it", (entry) => {
    // The strkey is well formed. The library parses it and reports its type.
    expect(Address.fromString(entry.strkey).type).toBe(entry.type);
    expect(() => addressParts(entry.strkey)).toThrow(AddressTypeError);
    expect(() => encodeAddress(entry.strkey)).toThrow(AddressTypeError);
    expect(isAcceptedAddress(entry.strkey)).toBe(false);
    expect(() => reserveSetHash([entry.strkey])).toThrow(AddressTypeError);
  });

  it("names the type in the refusal, so a reader sees why the address failed", () => {
    try {
      addressParts(accountAndMuxedOfOneKey().muxed);
      expect.unreachable("the muxed address must not pass");
    } catch (cause) {
      expect(cause).toBeInstanceOf(AddressTypeError);
      if (!(cause instanceof AddressTypeError)) {
        throw cause;
      }
      expect(cause.addressType).toBe("muxedAccount");
    }
  });
});

/**
 * The paired test. It takes the ed25519 key of an accepted account address and
 * builds a muxed account from that key. The pair proves that this
 * implementation inspects the type and does not read only the key.
 */
describe("one key in two forms", () => {
  it("accepts the account form and refuses the muxed form of the same key", () => {
    const { account, muxed, key } = accountAndMuxedOfOneKey();

    // The two strkeys carry the same ed25519 key.
    expect(StrKey.decodeEd25519PublicKey(account).equals(key)).toBe(true);
    expect(StrKey.decodeMed25519PublicKey(muxed).subarray(0, key.length).equals(key)).toBe(true);

    // The accepted form passes and encodes.
    const parts = addressParts(account);
    expect(parts.tag).toBe(ADDRESS_TAG_ACCOUNT);
    expect(Buffer.from(parts.payload).equals(key)).toBe(true);
    expect(() => encodeAddress(account)).not.toThrow();

    // The muxed form of the same key does not.
    expect(() => addressParts(muxed)).toThrow(AddressTypeError);
  });

  it("refuses two muxed accounts of one key, which a partial encoding would merge", () => {
    const { key } = accountAndMuxedOfOneKey();
    const first = StrKey.encodeMed25519PublicKey(Buffer.concat([key, Buffer.alloc(8, 0)]));
    const second = StrKey.encodeMed25519PublicKey(Buffer.concat([key, Buffer.alloc(8, 1)]));
    expect(first).not.toBe(second);
    expect(() => encodeAddress(first)).toThrow(AddressTypeError);
    expect(() => encodeAddress(second)).toThrow(AddressTypeError);
  });
});

describe("the reserve set rules", () => {
  it("refuses an empty set", () => {
    expect(() => reserveSetHash([])).toThrow(ReserveSetError);
  });

  it("refuses a set above the bound, and accepts a set at the bound", () => {
    const members = Array.from({ length: MAX_RESERVE_ADDRESSES + 1 }, (_unused, index) =>
      contractAddress(index + 1),
    );
    expect(() => reserveSetHash(members)).toThrow(ReserveSetError);
    expect(() => reserveSetHash(members.slice(0, MAX_RESERVE_ADDRESSES))).not.toThrow();
  });

  it("refuses a duplicate address", () => {
    expect(() => reserveSetHash([contractAddress(1), contractAddress(1)])).toThrow(ReserveSetError);
  });

  it("gives one value to the same addresses in any submission order", () => {
    const members = [contractAddress(3), contractAddress(1), contractAddress(2)];
    const reversed = [...members].reverse();
    expect(reserveSetHash(members)).toBe(reserveSetHash(reversed));
  });

  it("gives another value to a set of another size", () => {
    const three = [contractAddress(1), contractAddress(2), contractAddress(3)];
    expect(reserveSetHash(three)).not.toBe(reserveSetHash(three.slice(0, 2)));
  });
});
