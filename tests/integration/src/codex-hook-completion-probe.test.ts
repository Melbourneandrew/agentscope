import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
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
const sha256 = (path: string) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
const invoke = (
  launcher: string,
  receipt: string,
  selectedNonce = nonce,
  launcherSha256 = sha256(launcher),
) =>
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
      "--launcher-sha256",
      launcherSha256,
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

  it("rejects aliases and a launcher replaced during execution", () => {
    const root = mkdtempSync(join(tmpdir(), "agentscope-hook-probe-"));
    try {
      const launcher = join(root, "launcher");
      const alias = join(root, "alias");
      const receipt = join(root, "receipt");
      writeFileSync(launcher, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      const digest = sha256(launcher);
      linkSync(launcher, alias);
      expect(invoke(launcher, receipt, nonce, digest).status).toBe(1);
      rmSync(alias);
      writeFileSync(
        launcher,
        '#!/bin/sh\nprintf "#!/bin/sh\\nexit 0\\n" > "$0.next"\nchmod 700 "$0.next"\nmv "$0.next" "$0"\nexit 0\n',
        { mode: 0o700 },
      );
      expect(invoke(launcher, receipt).status).toBe(1);
      expect(existsSync(receipt)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
