import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

const MAXIMUM_RESULT_BYTES = 1024 * 1024;

const sameIdentity = (before, after) =>
  before.dev === after.dev &&
  before.ino === after.ino &&
  before.size === after.size &&
  before.mode === after.mode &&
  before.nlink === after.nlink &&
  before.uid === after.uid &&
  before.gid === after.gid &&
  before.mtimeNs === after.mtimeNs &&
  before.ctimeNs === after.ctimeNs;

const validateStatus = (status, expectedOwner) => {
  if (
    !status.isFile() ||
    status.isSymbolicLink() ||
    status.nlink !== 1n ||
    status.uid !== expectedOwner ||
    status.size < 1n ||
    status.size > BigInt(MAXIMUM_RESULT_BYTES) ||
    (status.mode & 0o7777n) !== 0o600n
  )
    throw new Error("integration.runner.fixture-result");
};

const readBounded = (descriptor) => {
  const buffer = Buffer.allocUnsafe(MAXIMUM_RESULT_BYTES + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const count = readSync(
      descriptor,
      buffer,
      offset,
      buffer.length - offset,
      null,
    );
    if (count === 0) break;
    offset += count;
  }
  if (offset < 1 || offset > MAXIMUM_RESULT_BYTES)
    throw new Error("integration.runner.fixture-result");
  return buffer.subarray(0, offset);
};

export const readRetainedFixtureOutput = (
  fixtureResultPath,
  scenarioId,
  afterDescriptorAuthenticationForTest,
) => {
  if (
    typeof fixtureResultPath !== "string" ||
    typeof scenarioId !== "string" ||
    (afterDescriptorAuthenticationForTest !== undefined &&
      process.env.NODE_ENV !== "test")
  )
    throw new Error("integration.runner.fixture-result");
  const expectedOwner = process.getuid?.();
  if (!Number.isSafeInteger(expectedOwner) || expectedOwner < 0)
    throw new Error("integration.runner.fixture-result");

  let descriptor;
  try {
    descriptor = openSync(
      fixtureResultPath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const before = fstatSync(descriptor, { bigint: true });
    validateStatus(before, BigInt(expectedOwner));
    afterDescriptorAuthenticationForTest?.();
    const bytes = readBounded(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    validateStatus(after, BigInt(expectedOwner));
    if (!sameIdentity(before, after) || BigInt(bytes.length) !== after.size)
      throw new Error("integration.runner.fixture-result");

    const retained = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    if (
      JSON.stringify(Object.keys(retained).sort()) !==
        JSON.stringify(["encodedEvidence", "evidenceVersion", "scenarioId"]) ||
      retained.evidenceVersion !== 1 ||
      retained.scenarioId !== scenarioId ||
      typeof retained.encodedEvidence !== "string" ||
      retained.encodedEvidence.length > MAXIMUM_RESULT_BYTES ||
      !/^[A-Za-z0-9_-]+$/u.test(retained.encodedEvidence)
    )
      throw new Error("integration.runner.fixture-result");
    return `AGENTSCOPE_FIXTURE_RESULT=${retained.encodedEvidence}\n`;
  } catch {
    throw new Error("integration.runner.fixture-result");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
};
