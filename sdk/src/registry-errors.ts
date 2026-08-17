/**
 * The error codes of the registry contract.
 *
 * A revert carries a contract error code and no address. The code names the
 * rule that failed. It does not name which reserve address failed, so a caller
 * that needs the address simulates each address on its own.
 *
 * The list mirrors the error enum of the registry crate. A code that this list
 * does not name still reports the number, so a newer contract never reads as
 * an unrelated failure.
 */

/** The name of each registry error code, by its discriminant. */
export const REGISTRY_ERRORS: ReadonlyMap<number, string> = new Map([
  [1, "UnsupportedAddressType"],
  [2, "EmptyReserveSet"],
  [3, "TooManyReserveAddresses"],
  [4, "DuplicateReserveAddress"],
  [5, "VerifierKeyMismatch"],
  [6, "AssetAlreadyRegistered"],
  [7, "AssetNotRegistered"],
  [8, "MalformedAsset"],
  [9, "NativeAssetNotSupported"],
  [10, "NotTheCanonicalAssetContract"],
  [11, "IssuerMismatch"],
  [12, "AdministratorMissing"],
  [13, "AdministratorMismatch"],
  [14, "AuthorityInReserveSet"],
  [15, "SnapshotOutsideWindow"],
  [16, "ProofRejected"],
  [17, "ReserveBalanceUnavailable"],
  [18, "ReserveSumOverflow"],
  [19, "VerifierNotSet"],
  [20, "RootOutOfRange"],
]);

/** The code that the registry returns when an asset has no record. */
export const ASSET_NOT_REGISTERED = 7;

/** The code that the registry returns when a reserve balance read fails. */
export const RESERVE_BALANCE_UNAVAILABLE = 17;

/** A statement in one line about what the registry refused, and why. */
export function describeRegistryError(code: number): string {
  const name = REGISTRY_ERRORS.get(code);
  if (name === undefined) {
    return `the registry returned the error code ${code}, which this version of the client does not name`;
  }
  return `the registry returned ${name}, error code ${code}`;
}

/**
 * Reads a registry error code out of the text of a failed call.
 *
 * The host reports a contract error as `Error(Contract, #n)`. The function
 * returns nothing when the text carries no such code, so a caller separates a
 * contract refusal from an infrastructure failure.
 */
export function registryErrorCode(text: string): number | undefined {
  const found = /Error\(Contract,\s*#(\d+)\)/.exec(text);
  if (found === null || found[1] === undefined) {
    return undefined;
  }
  return Number.parseInt(found[1], 10);
}
