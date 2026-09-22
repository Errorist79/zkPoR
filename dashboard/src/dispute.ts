import {
  findGeneration, isAcceptedAddress, latestLedger, parseHex, parseU64Decimal,
  readStoredAttestation, readStoredDispute, toHex,
} from "@zkpor/sdk";
import type { DisputeRecord, Generation, StoredAttestation } from "@zkpor/sdk";
import type { Reader } from "./chain.js";
import { DISPUTE_FIELDS, ROUTES } from "./constants.js";

export interface DisputeSelection {
  readonly registry: string;
  readonly asset: string;
  readonly targetId: bigint;
  readonly identifier: bigint;
}

export interface DisputeView {
  readonly selection: DisputeSelection;
  readonly generation: Generation;
  readonly dispute: DisputeRecord | undefined;
  readonly target: StoredAttestation | undefined;
  readonly currentLedger: number;
}

export function disputeSelection(fields: URLSearchParams): DisputeSelection {
  const registry = fields.get(DISPUTE_FIELDS.registry)?.trim() ?? "";
  const asset = fields.get(DISPUTE_FIELDS.asset)?.trim() ?? "";
  if (!isAcceptedAddress(registry) || !isAcceptedAddress(asset)) {
    throw new Error("Give valid Stellar addresses for the registry and asset.");
  }
  const targetId = parseU64Decimal(fields.get(DISPUTE_FIELDS.targetId) ?? "", "the target attestation ID");
  const identifier = parseHex(fields.get(DISPUTE_FIELDS.identifier) ?? "", "the customer identifier");
  if (targetId === 0n || identifier === 0n) {
    throw new Error("The target attestation ID and customer identifier must be nonzero.");
  }
  return { registry, asset, targetId, identifier };
}

export async function readDisputeView(reader: Reader, selection: DisputeSelection): Promise<DisputeView> {
  const generation = findGeneration(reader.deploymentsText, reader.config.network, selection.registry);
  if (generation === undefined) {
    throw new Error("The trusted deployments file does not name this registry on this network.");
  }
  const options = { ...reader.readOptions, server: reader.server };
  const dispute = await readStoredDispute(reader.config, selection.registry, selection.asset,
    selection.targetId, selection.identifier, options);
  const target = dispute === undefined ? undefined : await readStoredAttestation(
    reader.config, selection.registry, selection.asset, selection.targetId, options,
  );
  if (dispute !== undefined && target === undefined) {
    throw new Error("The dispute exists, but its fixed target attestation is unavailable.");
  }
  return { selection, generation, dispute, target, currentLedger: await latestLedger(reader.server) };
}

export function disputePath(selection: DisputeSelection): string {
  const query = new URLSearchParams({
    [DISPUTE_FIELDS.registry]: selection.registry,
    [DISPUTE_FIELDS.asset]: selection.asset,
    [DISPUTE_FIELDS.targetId]: selection.targetId.toString(),
    [DISPUTE_FIELDS.identifier]: toHex(selection.identifier),
  });
  return `${ROUTES.dispute}?${query.toString()}`;
}
