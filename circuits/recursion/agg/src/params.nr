// Generated from params.toml + the compiled inner program by
// tools/recursion-gen. Do not edit by hand.
pub global NUM_BATCHES_K: u32 = 4;
// Inner public-input vector length and the positions of (batch_slot,
// subroot, subtotal) within it. The generator reads the positions from
// the compiled program's ABI, so a value that appears twice cannot move
// a position.
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
pub global PINNED_INNER_VK_HASH: Field = 21328364434191421272252912670623927031304585141963122353817084063178220902570;
