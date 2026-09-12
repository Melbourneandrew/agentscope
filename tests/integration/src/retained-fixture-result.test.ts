/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return */
import {
  chmodSync,
  linkSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

// The reader is private integration JavaScript, not a package API.
// @ts-expect-error no declaration file is published for this private module
import { readRetainedFixtureOutput } from "../retained-fixture-result.mjs";

const roots: string[] = [];
const scenarioId = "fixture-process-smoke";
const record = (encodedEvidence = "exact_evidence") =>
  `${JSON.stringify({
    encodedEvidence,
    evidenceVersion: 1,
    scenarioId,
  })}\n`;
const createRoot = () => {
  const root = mkdtempSync(join(tmpdir(), "agentscope-retained-result-"));
  roots.push(root);
  chmodSync(root, 0o700);
  return root;
};
const writeResult = (path: string, content = record()) => {
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
};

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { force: true, recursive: true });
});

describe("retained fixture-result authority", () => {
  it("reads exact bounded evidence through one authenticated descriptor", () => {
    const path = join(createRoot(), "fixture-result.json");
    writeResult(path);
    expect(readRetainedFixtureOutput(path, scenarioId)).toBe(
      "AGENTSCOPE_FIXTURE_RESULT=exact_evidence\n",
    );
  });

  it("rejects symlink and hardlink identities", () => {
    const root = createRoot();
    const source = join(root, "source.json");
    writeResult(source);
    const symlink = join(root, "symlink.json");
    symlinkSync(source, symlink);
    expect(() => readRetainedFixtureOutput(symlink, scenarioId)).toThrow(
      "integration.runner.fixture-result",
    );
    const hardlink = join(root, "hardlink.json");
    linkSync(source, hardlink);
    expect(() => readRetainedFixtureOutput(source, scenarioId)).toThrow(
      "integration.runner.fixture-result",
    );
  });

  it("bounds bytes even when the file grows after authentication", () => {
    const path = join(createRoot(), "fixture-result.json");
    writeResult(path);
    expect(() =>
      readRetainedFixtureOutput(path, scenarioId, () => {
        writeResult(path, "x".repeat(1024 * 1024 + 1));
      }),
    ).toThrow("integration.runner.fixture-result");
  });

  it("rejects a path replacement after descriptor authentication", () => {
    const root = createRoot();
    const path = join(root, "fixture-result.json");
    const opened = join(root, "opened.json");
    writeResult(path);
    expect(() =>
      readRetainedFixtureOutput(path, scenarioId, () => {
        renameSync(path, opened);
        writeResult(path, record("substituted_evidence"));
      }),
    ).toThrow("integration.runner.fixture-result");
  });
});
