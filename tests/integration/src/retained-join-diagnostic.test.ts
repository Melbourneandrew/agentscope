/* eslint-disable @typescript-eslint/no-unsafe-call */
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

// Private failure-only reader, not a product or package API.
// @ts-expect-error no declaration file is published for this private module
import { readRetainedJoinDiagnostic } from "../retained-join-diagnostic.mjs";

const roots: string[] = [];
const diagnostic =
  "integration.fixture.codex-tui-join-deadline-session-end-active\n";
const createRoot = () => {
  const root = mkdtempSync(join(tmpdir(), "agentscope-join-diagnostic-"));
  roots.push(root);
  chmodSync(root, 0o700);
  return root;
};
const writeDiagnostic = (path: string, content = diagnostic) => {
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
};

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { force: true, recursive: true });
});

describe("retained Codex join diagnostic", () => {
  it("reads one exact bounded descriptor and leaves absence non-authoritative", () => {
    const path = join(createRoot(), "interactive-failure.txt");
    expect(readRetainedJoinDiagnostic(path)).toBeUndefined();
    writeDiagnostic(path);
    expect(readRetainedJoinDiagnostic(path)).toBe(diagnostic.trim());
  });

  it("rejects aliases, permission drift, oversize, and incomplete records", () => {
    const root = createRoot();
    const path = join(root, "interactive-failure.txt");
    writeDiagnostic(path);
    const alias = join(root, "alias.txt");
    symlinkSync(path, alias);
    expect(readRetainedJoinDiagnostic(alias)).toBeUndefined();
    linkSync(path, join(root, "hardlink.txt"));
    expect(readRetainedJoinDiagnostic(path)).toBeUndefined();
    rmSync(join(root, "hardlink.txt"));
    chmodSync(path, 0o644);
    expect(readRetainedJoinDiagnostic(path)).toBeUndefined();
    chmodSync(path, 0o600);
    writeDiagnostic(path, "x".repeat(129));
    expect(readRetainedJoinDiagnostic(path)).toBeUndefined();
    writeDiagnostic(path, diagnostic.trim());
    expect(readRetainedJoinDiagnostic(path)).toBeUndefined();
  });

  it("rejects mutation and replacement after descriptor authentication", () => {
    const root = createRoot();
    const path = join(root, "interactive-failure.txt");
    writeDiagnostic(path);
    expect(
      readRetainedJoinDiagnostic(path, () => {
        writeDiagnostic(path, `${diagnostic}extra`);
      }),
    ).toBeUndefined();
    writeDiagnostic(path);
    expect(
      readRetainedJoinDiagnostic(path, () => {
        renameSync(path, join(root, "old.txt"));
        writeDiagnostic(path, "substituted\n");
      }),
    ).toBeUndefined();
  });
});
