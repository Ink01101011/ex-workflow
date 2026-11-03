/**
 * Independence check: a verifying role must not be one that did the work.
 *
 * Returns the ids in `verifiers` that also appear in `workers`, each once, in verifier order;
 * an empty array means the verification is independent. Ids are compared exactly. The caller
 * decides how a conflict fails (a rule violation, a refused ceremony, a skipped role), so the
 * check carries no message of its own.
 *
 * @example
 * // a validator may not validate a candidate it built or integrated
 * if (independenceConflicts(by, [candidate.author, integration.by]).length) refuse();
 */
export function independenceConflicts(
  verifiers: string | readonly string[],
  workers: readonly string[],
): string[] {
  return [...new Set(typeof verifiers === "string" ? [verifiers] : verifiers)].filter((id) =>
    workers.includes(id),
  );
}
