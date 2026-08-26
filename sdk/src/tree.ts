/**
 * The authentication path walk.
 *
 * The path holds no direction bit. Bit `d` of the leaf index states the
 * position of the current node at level `d`: zero means the node is the left
 * input, one means the node is the right input. Stored data that can disagree
 * with derived data is forbidden, so the index alone gives the direction.
 */

import { nodeHash } from "./hashes.js";
import { inRange } from "./fr.js";

/** A path whose shape does not fit the tree of the deployment. */
export class PathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathError";
  }
}

/**
 * Walks a path from a leaf to the root.
 *
 * The sibling count must equal the tree depth, and the leaf index must sit
 * below the capacity of that depth. The walk reads only the low bits of the
 * index, so an unchecked high bit would let two different indices name one
 * path.
 */
export function rootFromPath(input: {
  leaf: bigint;
  leafIndex: number;
  siblings: readonly bigint[];
  depth: number;
}): bigint {
  if (!Number.isInteger(input.depth) || input.depth < 1) {
    throw new PathError("a tree depth is at least one level");
  }
  if (input.siblings.length !== input.depth) {
    throw new PathError(
      `a path of a tree of depth ${input.depth} holds ${input.depth} sibling hashes, not ${input.siblings.length}`,
    );
  }
  if (!Number.isInteger(input.leafIndex) || input.leafIndex < 0) {
    throw new PathError("a leaf index is not negative");
  }
  if (BigInt(input.leafIndex) >= 2n ** BigInt(input.depth)) {
    throw new PathError(
      `the leaf index ${input.leafIndex} is outside a tree of depth ${input.depth}`,
    );
  }
  if (!inRange(input.leaf)) {
    throw new PathError("the leaf is not a field element");
  }
  const index = BigInt(input.leafIndex);
  let node = input.leaf;
  for (const [level, sibling] of input.siblings.entries()) {
    if (!inRange(sibling)) {
      throw new PathError(`the sibling hash at level ${level} is not a field element`);
    }
    node = ((index >> BigInt(level)) & 1n) === 0n ? nodeHash(node, sibling) : nodeHash(sibling, node);
  }
  return node;
}

/**
 * The root of a full binary tree over the leaves, folded pairwise from the
 * bottom. The leaf count is a power of two and at least two.
 *
 * The batch structure of the circuits does not change the hash structure, so
 * this fold gives the root of the single tree over all leaves.
 */
export function treeRoot(leaves: readonly bigint[]): bigint {
  if (leaves.length < 2 || (leaves.length & (leaves.length - 1)) !== 0) {
    throw new PathError("a tree holds a power of two leaves, at least two");
  }
  let level = [...leaves];
  while (level.length > 1) {
    const next: bigint[] = [];
    // The pair comes out of the list by reading both elements and checking
    // them, so the fold never claims that a position holds a value.
    for (let pair = 0; pair < level.length / 2; pair += 1) {
      const left = level[2 * pair];
      const right = level[2 * pair + 1];
      if (left === undefined || right === undefined) {
        throw new PathError("a level of the tree lost an element");
      }
      next.push(nodeHash(left, right));
    }
    level = next;
  }
  const root = level[0];
  if (root === undefined) {
    throw new PathError("the fold produced no root");
  }
  return root;
}
