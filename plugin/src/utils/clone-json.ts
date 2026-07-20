/**
 * Clone the JSON-shaped state exchanged with the native helper.
 * Premiere's UXP runtime does not currently expose browser structuredClone().
 */
export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
