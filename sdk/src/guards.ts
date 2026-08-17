/**
 * The checks that establish the shape of a value at a boundary.
 *
 * A boundary of this package receives a value of unknown shape: a parsed JSON
 * document, a value that the host returned, or a caught value. A check inspects
 * such a value and states what it is. Nothing here tells the type checker what
 * a value is without looking at it, because a claim that the checker stops
 * questioning surfaces later, in the data of a caller, instead of here.
 */

/**
 * True when the value is a JSON object.
 *
 * The check excludes a list and the null value, because both are objects to the
 * `typeof` operator and neither one carries named fields.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when the value is a list whose every element is a string. */
export function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((element) => typeof element === "string");
}

/**
 * The message of a caught value.
 *
 * A thrown value is not always an error. A reader that assumed it was would
 * print the word undefined to a customer, so this reads the message when the
 * value carries one and describes the value when it does not.
 */
export function messageOf(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.message;
  }
  if (typeof cause === "string") {
    return cause;
  }
  return `the failure carries no message, and its value is ${String(cause)}`;
}
