//! Generated from the built artifacts by tools/recursion-gen. Do not
//! edit by hand.

/// SHA-256 of the aggregator verification key that this build expects a
/// verifier to hold: e08adcfe939b0610ae80c07217abf5a5b177bed4a09478266d8b49108392634f.
#[rustfmt::skip]
pub const AGGREGATOR_KEY_SHA256: [u8; 32] = [
    0xe0, 0x8a, 0xdc, 0xfe, 0x93, 0x9b, 0x06, 0x10,
    0xae, 0x80, 0xc0, 0x72, 0x17, 0xab, 0xf5, 0xa5,
    0xb1, 0x77, 0xbe, 0xd4, 0xa0, 0x94, 0x78, 0x26,
    0x6d, 0x8b, 0x49, 0x10, 0x83, 0x92, 0x63, 0x4f,
];

/// The Poseidon2 tree hash of the pinned inner verification key, as 32
/// big-endian bytes. The terminal proof carries this value as a public
/// input, and the aggregator asserts it in the circuit.
#[rustfmt::skip]
pub const INNER_KEY_HASH: [u8; 32] = [
    0x2f, 0x27, 0x6d, 0x2d, 0x6f, 0x1e, 0x55, 0xfc,
    0xe7, 0x2a, 0x42, 0xbd, 0x84, 0xed, 0x6e, 0x05,
    0xe4, 0xeb, 0x5e, 0x73, 0xd9, 0xca, 0xc2, 0xab,
    0xc4, 0x7e, 0xd2, 0xef, 0xc7, 0x50, 0x18, 0xaa,
];

/// Number of elements of the public input byte string of the terminal
/// proof. Each element is 32 bytes big-endian.
pub const PUBLIC_INPUT_COUNT: u32 = 4;

/// Position of each element inside that byte string. A consumer reads
/// the positions here, because two elements can hold one value and a
/// search by value can find the wrong one.
pub const CONTEXT_HASH_INDEX: u32 = 0;
pub const INNER_KEY_HASH_INDEX: u32 = 1;
pub const FINAL_ROOT_INDEX: u32 = 2;
pub const L_INDEX: u32 = 3;
