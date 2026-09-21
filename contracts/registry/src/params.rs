//! Generated from the built artifacts by tools/recursion-gen. Do not
//! edit by hand.

/// SHA-256 of the aggregator verification key that this build expects a
/// verifier to hold: 92cd8deaf40d8024a9ece6c9d2395ea75cfe5a739b3e80eabf35703495f41f44.
#[rustfmt::skip]
pub const AGGREGATOR_KEY_SHA256: [u8; 32] = [
    0x92, 0xcd, 0x8d, 0xea, 0xf4, 0x0d, 0x80, 0x24,
    0xa9, 0xec, 0xe6, 0xc9, 0xd2, 0x39, 0x5e, 0xa7,
    0x5c, 0xfe, 0x5a, 0x73, 0x9b, 0x3e, 0x80, 0xea,
    0xbf, 0x35, 0x70, 0x34, 0x95, 0xf4, 0x1f, 0x44,
];

/// The Poseidon2 tree hash of the pinned inner verification key, as 32
/// big-endian bytes. The terminal proof carries this value as a public
/// input, and the aggregator asserts it in the circuit.
#[rustfmt::skip]
pub const INNER_KEY_HASH: [u8; 32] = [
    0x2a, 0x7f, 0x30, 0x5e, 0x8f, 0xfc, 0x8a, 0xda,
    0xb2, 0x41, 0xa6, 0xf3, 0xdf, 0xf6, 0x41, 0xd4,
    0xee, 0xfc, 0x5e, 0x10, 0x3b, 0xc9, 0x47, 0xd5,
    0x4c, 0x67, 0xf2, 0x46, 0x5d, 0x82, 0x85, 0xac,
];

/// Number of elements of the public input byte string of the terminal
/// proof. Each element is 32 bytes big-endian.
pub const PUBLIC_INPUT_COUNT: u32 = 4;
/// Number of sibling hashes in one customer path.
pub const MERKLE_PATH_DEPTH: u32 = 12;

/// Position of each element inside that byte string. A consumer reads
/// the positions here, because two elements can hold one value and a
/// search by value can find the wrong one.
pub const CONTEXT_HASH_INDEX: u32 = 0;
pub const INNER_KEY_HASH_INDEX: u32 = 1;
pub const FINAL_ROOT_INDEX: u32 = 2;
pub const L_INDEX: u32 = 3;
