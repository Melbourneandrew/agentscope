/** Recursively freezes trusted, acyclic Protocol contract material. */
export const deepFreeze = <T>(value: T): T => {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const member of Object.values(value)) {
    deepFreeze(member);
  }
  return Object.freeze(value);
};
