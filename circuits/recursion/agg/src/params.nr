// Generated from params.toml + observed bb output by tools/recursion-gen.
// Do not edit by hand.
pub global NUM_BATCHES_K: u32 = 2;
// Inner public-input vector length and the positions of (batch_slot,
// subroot, subtotal) within it. The generator locates these by value, so
// the layout bb emits for a honk_recursion proof (with any appended pairing
// points) is handled without editing circuit logic.
pub global INNER_PUB_LEN: u32 = 3;
pub global SLOT_IDX: u32 = 0;
pub global SUBROOT_IDX: u32 = 1;
pub global SUBTOTAL_IDX: u32 = 2;
// bb 0.87.0 UltraHonk field encodings (version-coupled; regenerate with bb).
pub global VK_LEN: u32 = 112;
pub global PROOF_LEN: u32 = 456;
// Inner-vk pin (constraint 1): width the vk is zero-padded to (power of
// two) and the Poseidon2 binary-tree hash of the padded vk. The aggregator
// recomputes this hash over the witnessed vk and asserts equality.
pub global VK_COMMIT_WIDTH: u32 = 128;
pub global PINNED_INNER_VK_HASH: Field = 1357273200117458797986844784429821263783956267355746105492988669212160577549;
