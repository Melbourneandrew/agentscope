import type { OwnedSqliteFamilyEvidence } from "./owned-filesystem.js";

const sameEntry = (
  expected: OwnedSqliteFamilyEvidence,
  observed: OwnedSqliteFamilyEvidence | undefined,
): boolean =>
  observed?.name === expected.name &&
  observed.evidence.physicalIdentity === expected.evidence.physicalIdentity;

const databaseName = (
  family: readonly OwnedSqliteFamilyEvidence[],
): string | undefined =>
  family.find(({ name }) => !name.endsWith("-wal") && !name.endsWith("-shm"))
    ?.name;

const canonicalFamily = (
  family: readonly OwnedSqliteFamilyEvidence[],
  mainName: string,
): boolean => {
  const allowed = new Set([mainName, `${mainName}-shm`, `${mainName}-wal`]);
  return (
    family.length >= 1 &&
    family.length <= allowed.size &&
    family.every(
      ({ name }, index) =>
        allowed.has(name) && family[index - 1]?.name !== name,
    ) &&
    family.every(
      ({ name }, index) => index === 0 || family[index - 1]!.name < name,
    )
  );
};

export const admitsOwnedSqliteFamilyExpansion = (
  prior: readonly OwnedSqliteFamilyEvidence[],
  observed: readonly OwnedSqliteFamilyEvidence[],
): boolean => {
  const mainName = databaseName(prior);
  if (
    mainName === undefined ||
    !canonicalFamily(prior, mainName) ||
    !canonicalFamily(observed, mainName)
  )
    return false;
  return prior.every((expected) =>
    sameEntry(
      expected,
      observed.find(({ name }) => name === expected.name),
    ),
  );
};

export const admitsOwnedSqliteFamilySettlement = (
  admitted: readonly OwnedSqliteFamilyEvidence[],
  observed: readonly OwnedSqliteFamilyEvidence[],
): boolean => {
  const mainName = databaseName(admitted);
  if (
    mainName === undefined ||
    !canonicalFamily(admitted, mainName) ||
    !canonicalFamily(observed, mainName)
  )
    return false;
  const observedMain = observed.find(({ name }) => name === mainName);
  const admittedMain = admitted.find(({ name }) => name === mainName);
  return (
    admittedMain !== undefined &&
    sameEntry(admittedMain, observedMain) &&
    observed.every(({ name }) => {
      const expected = admitted.find((entry) => entry.name === name);
      return (
        expected !== undefined &&
        sameEntry(
          expected,
          observed.find((entry) => entry.name === name),
        )
      );
    })
  );
};
