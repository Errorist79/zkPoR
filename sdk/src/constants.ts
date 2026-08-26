/**
 * Every policy value and every protocol constant of this package.
 *
 * A value that appears at more than one call site is defined here and
 * referenced. The committed test vectors carry the same values, and a test
 * compares each one against them, so a drift fails the suite instead of
 * reaching a user.
 */

/** The scalar field modulus of the BN254 curve. */
export const FR_MODULUS =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/** The byte count of the serialized form of one field element. */
export const FR_BYTES = 32;

/** The hexadecimal digit count of the text form of one field element. */
export const FR_HEX_DIGITS = FR_BYTES * 2;

/** The state width of the Poseidon2 instance this protocol uses. */
export const POSEIDON2_STATE_WIDTH = 4;

/** The sponge rate of that instance. The rate is the width minus one. */
export const POSEIDON2_RATE = POSEIDON2_STATE_WIDTH - 1;

/**
 * The domain tag of the context hash: the ASCII string `zkpor-context-v1`,
 * left-padded with zero bytes to 32 bytes, read as a big-endian integer.
 */
export const CTX_DOMAIN_TAG_TEXT = "zkpor-context-v1";

/**
 * The domain tag of the salt derivation: the ASCII string `zkpor-salt-v1`,
 * left-padded with zero bytes to 32 bytes, read as a big-endian integer.
 */
export const SALT_DOMAIN_TAG_TEXT = "zkpor-salt-v1";

/** The largest reserve address count that a registration may carry. */
export const MAX_RESERVE_ADDRESSES = 32;

/** The ledger count after the snapshot at which a solvency claim lapses. */
export const ATTESTATION_MAX_AGE_LEDGERS = 720;

/** The payload byte count of an accepted address. */
export const ADDRESS_PAYLOAD_BYTES = 32;

/** The byte count of one limb of the address encoding. */
export const ADDRESS_LIMB_BYTES = 16;

/** The address type tag of an account address. */
export const ADDRESS_TAG_ACCOUNT = 0;

/** The address type tag of a contract address. */
export const ADDRESS_TAG_CONTRACT = 1;

/** The identifier of a padding leaf. No customer identifier may hold it. */
export const PADDING_LEAF_ID = 0n;

/** The balance of a padding leaf. */
export const PADDING_LEAF_BALANCE = 0n;

/** The largest value that a u64 balance holds. */
export const MAX_U64 = 2n ** 64n - 1n;

/** The largest value that a u32 ledger sequence or leaf index holds. */
export const MAX_U32 = 4294967295;

/** The exact `format` string of the inclusion package schema. */
export const PACKAGE_FORMAT = "zkpor-inclusion/1";

/** The filename extension of an inclusion package. */
export const PACKAGE_EXTENSION = "zkpor.json";

/** The digit count to which a package filename pads the leaf index. */
export const PACKAGE_INDEX_DIGITS = 6;

/** The indentation width of the deterministic package layout. */
export const JSON_INDENT = 2;

/** The keys of the package schema, in the order a writer must emit them. */
export const PACKAGE_FIELDS = [
  "format",
  "network",
  "registry",
  "asset",
  "snapshot_ledger",
  "leaf_index",
  "id",
  "balance",
  "salt",
  "siblings",
] as const;

/** The element count of the aggregator public input vector. */
export const PUBLIC_INPUT_COUNT = 4;

/** The byte count of the serialized public input vector. */
export const PUBLIC_INPUT_BYTES = PUBLIC_INPUT_COUNT * FR_BYTES;

/**
 * The margin in ledgers that a reserve consent entry stays valid for.
 *
 * A reserve holder signs on another machine, so the deadline must survive a
 * human round trip. The value is a policy choice, not a protocol rule.
 */
export const CONSENT_VALIDITY_LEDGERS = 1000;

/**
 * The margin in ledgers below which the flow calls a consent entry too close
 * to its deadline to submit.
 */
export const CONSENT_EXPIRY_WARNING_LEDGERS = 60;

/**
 * The ledgers of the expiry window that must remain when proving starts.
 *
 * The proof takes minutes, and the registry compares the snapshot against the
 * ledger that executes the attestation, not against the ledger that started the
 * run. A run that begins with less of the window than this cannot land.
 */
export const PROVING_MARGIN_LEDGERS = 120;

/** The environment variable through which the generator reads the secret. */
export const GENERATOR_SECRET_ENV = "ZKPOR_MASTER_SECRET";

/**
 * The master secret of the fixtures of this repository.
 *
 * The value is public, so every salt it derives is public, and every leaf it
 * builds is open to a search over plausible balances. A real run must refuse
 * it. The constant exists so the refusal can name it.
 */
export const FIXTURE_MASTER_SECRET =
  0x7a6b706f722d746573742d6f6e6c792d6d61737465722d736563726574212121n;

/** The directory name that holds the test inputs of this repository. */
export const FIXTURE_DIRECTORY = "fixtures";

/** The default ledger count that an attestation history query reaches back. */
export const HISTORY_DEFAULT_LEDGERS = 17280;

/** The largest event count that one history page requests. */
export const HISTORY_PAGE_LIMIT = 200;

/** The file mode that the master secret file must not exceed. */
export const SECRET_FILE_MODE = 0o600;

/** The environment variable that carries the master secret. */
export const MASTER_SECRET_ENV = "ZKPOR_MASTER_SECRET";

/** The environment variable that carries the path of the master secret file. */
export const MASTER_SECRET_FILE_ENV = "ZKPOR_MASTER_SECRET_FILE";
