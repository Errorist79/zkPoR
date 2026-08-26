/**
 * The one hash of this package, and the one call site of the hash library.
 *
 * The protocol fixes the Poseidon2 instance: state width 4, rate 3, and a
 * sponge capacity that starts at the input count times 2^64. The capacity
 * carries the input count, so a hash of two inputs and a hash of three inputs
 * never collide.
 *
 * ## Never call the variable-length mode
 *
 * The hash library exports a second mode, `poseidon2HashAsync` aside, whose
 * variable-length form absorbs one extra element after the inputs. It looks
 * like a reasonable call site and it computes a different function. Every root,
 * every leaf, every salt, and every context hash of this protocol comes from
 * the fixed-length form, so the variable-length form silently produces values
 * that the registry and the circuits reject.
 *
 * Two rules keep that mode unreachable:
 *
 * - This file is the only place in the package that imports the hash library,
 *   and it imports the fixed-length function alone.
 * - This file exports one function, so no caller chooses a mode.
 *
 * A test pins both rules. If you extend this package, do not add a second
 * import of the library and do not add a second exported hash.
 */

import { poseidon2Hash } from "@zkpassport/poseidon2";
import { inRange } from "./fr.js";

/**
 * Hashes `n` field elements with the fixed-length form.
 *
 * The input count selects the hash domain, so a caller passes the exact list
 * that the protocol names and never pads it.
 */
export function hash(inputs: readonly bigint[]): bigint {
  if (inputs.length === 0) {
    throw new Error("the hash takes at least one input");
  }
  for (const [index, input] of inputs.entries()) {
    if (!inRange(input)) {
      throw new Error(`hash input ${index} is not a field element`);
    }
  }
  return poseidon2Hash([...inputs]);
}
