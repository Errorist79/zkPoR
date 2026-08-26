/**
 * The address encoding, the accepted address types, and the reserve set hash.
 *
 * Stellar defines five address types. This protocol accepts two of them, an
 * account address and a contract address, because the encoding is defined over
 * a fixed 32-byte payload and the other three types do not have that shape.
 *
 * The `Address` class of the Stellar library for JavaScript parses and holds
 * all five types, and a muxed strkey parses there normally. The rejection is
 * therefore an explicit statement in this file, at the one point where an
 * address enters the package. A partial encoding that read only the ed25519
 * key of a muxed account would map two different muxed accounts onto one limb
 * pair, and that collision breaks the binding between the proof and the
 * reserve set.
 */

import { Address } from "@stellar/stellar-sdk";
import {
  ADDRESS_LIMB_BYTES,
  ADDRESS_PAYLOAD_BYTES,
  ADDRESS_TAG_ACCOUNT,
  ADDRESS_TAG_CONTRACT,
  MAX_RESERVE_ADDRESSES,
} from "./constants.js";
import { bytesToBigint } from "./fr.js";
import { hash } from "./poseidon.js";

/** The address type names that this protocol accepts, with their tags. */
const ACCEPTED_TYPES: ReadonlyMap<string, number> = new Map([
  ["account", ADDRESS_TAG_ACCOUNT],
  ["contract", ADDRESS_TAG_CONTRACT],
]);

/** An address whose type this protocol does not accept. */
export class AddressTypeError extends Error {
  constructor(
    readonly addressType: string,
    readonly address: string,
  ) {
    super(
      `the address type ${addressType} is not an account address and not a contract address, so ${address} is not an accepted address`,
    );
    this.name = "AddressTypeError";
  }
}

/** A reserve set that breaks a rule of the set. */
export class ReserveSetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReserveSetError";
  }
}

/** An accepted address, as its type tag and its 32-byte payload. */
export interface AddressParts {
  readonly tag: number;
  readonly payload: Uint8Array;
  readonly strkey: string;
}

/** The two field elements that carry one accepted address. */
export interface AddressLimbs {
  readonly hi: bigint;
  readonly lo: bigint;
}

/**
 * Reads a strkey as an accepted address.
 *
 * The function inspects the type first and refuses every type outside the
 * accepted pair. It then requires the payload to be exactly 32 bytes, which
 * holds for both accepted types and fails for any type that carries more.
 */
export function addressParts(address: string | Address): AddressParts {
  const parsed = typeof address === "string" ? Address.fromString(address) : address;
  const strkey = parsed.toString();
  const tag = ACCEPTED_TYPES.get(parsed.type);
  if (tag === undefined) {
    throw new AddressTypeError(parsed.type, strkey);
  }
  const payload = new Uint8Array(parsed.toBuffer());
  if (payload.length !== ADDRESS_PAYLOAD_BYTES) {
    throw new AddressTypeError(parsed.type, strkey);
  }
  return { tag, payload, strkey };
}

/** True when the address is one of the two accepted types. */
export function isAcceptedAddress(address: string): boolean {
  try {
    addressParts(address);
    return true;
  } catch {
    return false;
  }
}

/**
 * Encodes an accepted address into two field elements.
 *
 * The tag occupies the bits above the first payload half, so the encoding is
 * injective: the tag and every payload bit survive in the limb pair.
 */
export function encodeAddress(address: string | Address): AddressLimbs {
  const { tag, payload } = addressParts(address);
  const high = bytesToBigint(payload.subarray(0, ADDRESS_LIMB_BYTES));
  const low = bytesToBigint(payload.subarray(ADDRESS_LIMB_BYTES));
  return { hi: BigInt(tag) * 2n ** BigInt(ADDRESS_LIMB_BYTES * 8) + high, lo: low };
}

/**
 * Orders two addresses by the sort key of the reserve set: the tag as one
 * byte, then the payload bytes.
 *
 * The comparison runs on the encoded limb pair, which gives the same order,
 * because the tag occupies the highest bits of the high limb.
 */
function compareLimbs(left: AddressLimbs, right: AddressLimbs): number {
  if (left.hi !== right.hi) {
    return left.hi < right.hi ? -1 : 1;
  }
  if (left.lo !== right.lo) {
    return left.lo < right.lo ? -1 : 1;
  }
  return 0;
}

/**
 * Sorts a reserve set and rejects a set that breaks a rule of the set.
 *
 * The rules are the type of every member, the absence of a duplicate, and the
 * size bound. The specification fixes the accept or reject outcome and leaves
 * the order of the checks and the identity of the reported error open.
 */
export function sortedReserveSet(addresses: readonly (string | Address)[]): AddressLimbs[] {
  if (addresses.length === 0) {
    throw new ReserveSetError("a reserve set holds at least one address");
  }
  if (addresses.length > MAX_RESERVE_ADDRESSES) {
    throw new ReserveSetError(
      `a reserve set holds at most ${MAX_RESERVE_ADDRESSES} addresses, not ${addresses.length}`,
    );
  }
  const limbs = addresses.map((address) => encodeAddress(address));
  limbs.sort(compareLimbs);
  // The scan carries the previous member instead of reading a position, so the
  // duplicate check needs no claim that an index holds an element.
  let previous: AddressLimbs | undefined;
  for (const current of limbs) {
    if (previous !== undefined && compareLimbs(previous, current) === 0) {
      throw new ReserveSetError("a reserve set holds each address once");
    }
    previous = current;
  }
  return limbs;
}

/**
 * The commitment to the set of authorized reserve addresses.
 *
 * The sort makes the value a set hash, so the same addresses in any submission
 * order give the same value. The capacity rule of the hash encodes the element
 * count, so two sets of different sizes cannot collide.
 */
export function reserveSetHash(addresses: readonly (string | Address)[]): bigint {
  const limbs = sortedReserveSet(addresses);
  const inputs: bigint[] = [];
  for (const limb of limbs) {
    inputs.push(limb.hi, limb.lo);
  }
  return hash(inputs);
}
