import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createOwnedHookLauncherArtifacts,
  HookLauncherError,
} from "./hook-launcher.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { force: true, recursive: true });
});

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "agentscope-hook-launcher-"));
  roots.push(root);
  const home = join(root, "home");
  const entry = join(root, "machine.mjs");
  mkdirSync(join(home, "bin"), { recursive: true });
  return { entry, home, root };
};

describe("owned hook launcher artifacts", () => {
  it("creates and directly executes a zero-argument POSIX launcher", () => {
    const { entry, home, root } = fixture();
    const marker = join(root, "called.json");
    writeFileSync(
      entry,
      `import { writeFileSync } from "node:fs";
export const runOwnedHookBootstrap = (authority) => {
  if (authority.arguments.length === 0 && authority.contractVersion === 1)
    writeFileSync(${JSON.stringify(marker)}, JSON.stringify(authority));
};\n`,
    );
    const artifacts = createOwnedHookLauncherArtifacts({
      agentscopeHome: home,
      harnessType: "@agentscope/harness-codex",
      hookDeadlineMilliseconds: 2_000,
      machineEntryPath: entry,
      nodeExecutable: process.execPath,
      platform: "posix",
      releaseIdentity: "0.1.0",
    });
    writeFileSync(artifacts.launcherPath, artifacts.launcherBytes, {
      mode: artifacts.mode,
    });
    chmodSync(artifacts.launcherPath, artifacts.mode);
    writeFileSync(artifacts.metadataPath, artifacts.metadataBytes);
    const result = spawnSync(artifacts.launcherPath, [], {
      encoding: "utf8",
      env: { ...process.env, AGENTSCOPE_HOME: join(root, "redirected") },
    });
    expect(result).toMatchObject({ status: 0, stdout: "", stderr: "" });
    expect(JSON.parse(readFileSync(marker, "utf8"))).toMatchObject({
      arguments: [],
      contractVersion: 1,
      physicalPath: artifacts.launcherPath,
    });
    expect(artifacts.launcherPath).toMatch(
      /\/bin\/agentscope-hook-v1-[a-f0-9]{64}-d2000$/u,
    );
    expect(artifacts.metadata).toMatchObject({
      launcherPath: artifacts.launcherPath,
      mode: 0o700,
      nodeExecutable: process.execPath,
    });
  });

  it("fails open before the machine entry can accept external arguments", () => {
    const { entry, home, root } = fixture();
    const marker = join(root, "called");
    const loaded = join(root, "loaded");
    writeFileSync(
      entry,
      `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(loaded)}, "loaded");
export const runOwnedHookBootstrap = (authority) => {
  if (authority.arguments.length === 0) writeFileSync(${JSON.stringify(marker)}, "called");
};\n`,
    );
    const artifacts = createOwnedHookLauncherArtifacts({
      agentscopeHome: home,
      harnessType: "@agentscope/harness-codex",
      hookDeadlineMilliseconds: 50,
      machineEntryPath: entry,
      nodeExecutable: process.execPath,
      platform: "posix",
      releaseIdentity: "0.1.0",
    });
    writeFileSync(artifacts.launcherPath, artifacts.launcherBytes, {
      mode: artifacts.mode,
    });
    const result = spawnSync(artifacts.launcherPath, ["--harness", "other"], {
      encoding: "utf8",
    });
    expect(result).toMatchObject({ status: 0, stdout: "", stderr: "" });
    expect(() => readFileSync(marker)).toThrow();
    expect(() => readFileSync(loaded)).toThrow();
  });

  it("rejects unsupported platforms, shebangs, bounds, and accessors", () => {
    const { entry, home } = fixture();
    const valid = {
      agentscopeHome: home,
      harnessType: "@agentscope/harness-codex",
      hookDeadlineMilliseconds: 2_000,
      machineEntryPath: entry,
      nodeExecutable: process.execPath,
      platform: "posix" as const,
      releaseIdentity: "0.1.0",
    };
    const exactBoundary = createOwnedHookLauncherArtifacts({
      ...valid,
      nodeExecutable: `/${"x".repeat(123)}`,
    });
    expect(
      exactBoundary.launcherBytes.subarray(
        0,
        exactBoundary.launcherBytes.indexOf(10) + 1,
      ),
    ).toHaveLength(127);
    for (const input of [
      { ...valid, platform: "win32" },
      ...[" ", "\t", "\n", "\r", "\0"].map((byte) => ({
        ...valid,
        nodeExecutable: `/path${byte}node`,
      })),
      { ...valid, nodeExecutable: `/${"x".repeat(124)}` },
      { ...valid, machineEntryPath: "relative" },
      { ...valid, releaseIdentity: "bad identity" },
      { ...valid, hookDeadlineMilliseconds: 49 },
      { ...valid, extra: true },
      Object.defineProperty({ ...valid }, "releaseIdentity", {
        get: () => "0.1.0",
      }),
      null,
    ])
      expect(() =>
        createOwnedHookLauncherArtifacts(
          input as Parameters<typeof createOwnedHookLauncherArtifacts>[0],
        ),
      ).toThrow(HookLauncherError);
  });
});
