/**
 * Frozen-input check: a frozen or preregistered record may not change after freeze.
 *
 * Compares each key of `frozen` (or only `keys`, when given) with the same key of `supplied`
 * and returns the keys whose value differs, in key order; an empty array means the supplied
 * input matches the freeze. Values are compared by identity (`!==`), so freeze primitive
 * fields such as ids, SHAs and refs. Only own fields of `supplied` are read: a missing record,
 * a missing field or an inherited one reads as `undefined`, which counts as a change unless the
 * frozen value is `undefined` too. The caller decides how a change fails, so the check carries
 * no message of its own.
 *
 * @example
 * // a submission must reuse the frozen harness and base SHA
 * if (frozenChanges({ harness, baseSha }, input).length) refuse();
 */
export function frozenChanges<K extends string>(
  frozen: { readonly [P in K]?: unknown },
  supplied: object | undefined,
  keys: readonly K[] = Object.keys(frozen) as K[],
): K[] {
  const s = supplied as Record<string, unknown> | undefined;
  return keys.filter((key) => frozen[key] !== (s && Object.hasOwn(s, key) ? s[key] : undefined));
}
