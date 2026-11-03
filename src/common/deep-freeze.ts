/**
 * Freezes `value` and every object or array inside it, and returns it with its declared type, so
 * an exported built-in constant cannot be changed for every other caller in the process.
 */
export function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}
