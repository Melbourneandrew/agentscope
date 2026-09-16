import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const fixture = resolve(
  import.meta.dirname,
  "../fixtures/codex-hook-completion-probe.mjs",
);
const nonce = "a".repeat(64);
const invoke = (launcher: string, receipt: string, selectedNonce = nonce) =>
  spawnSync(
    process.execPath,
    [
      fixture,
      "--launcher",
      launcher,
      "--receipt",
      receipt,
      "--nonce",
      selectedNonce,
    ],
    { encoding: "utf8" },
  );

describe("Codex Stop-hook completion probe", () => {
  it("publishes the exact receipt only after the launcher succeeds", () => {
    const root = mkdtempSync(join(tmpdir(), "agentscope-hook-probe-"));
    try {
      const launcher = join(root, "launcher");
      const receipt = join(root, "receipt");
      writeFileSync(launcher, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      const result = invoke(launcher, receipt);
      expect(result.status).toBe(0);
      expect(result.signal).toBeNull();
      expect(readFileSync(receipt, "utf8")).toBe(`${nonce}\n`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([1, 42])("never publishes after launcher exit %i", (exitCode) => {
    const root = mkdtempSync(join(tmpdir(), "agentscope-hook-probe-"));
    try {
      const launcher = join(root, "launcher");
      const receipt = join(root, "receipt");
      writeFileSync(launcher, `#!/bin/sh\nexit ${exitCode}\n`, { mode: 0o700 });
      expect(invoke(launcher, receipt).status).toBe(1);
      expect(existsSync(receipt)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects substituted launchers, receipts, and nonces", () => {
    const root = mkdtempSync(join(tmpdir(), "agentscope-hook-probe-"));
    try {
      const launcher = join(root, "launcher");
      const target = join(root, "target");
      const receipt = join(root, "receipt");
      writeFileSync(target, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      symlinkSync(target, launcher);
      expect(invoke(launcher, receipt).status).toBe(1);
      expect(invoke(target, "relative").status).toBe(1);
      expect(invoke(target, receipt, "not-a-nonce").status).toBe(1);
      writeFileSync(receipt, "preexisting", { mode: 0o600 });
      expect(invoke(target, receipt).status).toBe(1);
      chmodSync(target, 0o600);
      rmSync(receipt);
      expect(invoke(target, receipt).status).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
