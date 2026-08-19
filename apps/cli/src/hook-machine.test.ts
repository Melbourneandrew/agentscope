import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { createOwnedHookLauncherArtifacts } from "./hook-launcher.js";
import { runOwnedHookBootstrapForTesting } from "./hook-machine.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { force: true, recursive: true });
});

const fixture = (duration = 2_000) => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "agentscope-hook-machine-")),
  );
  roots.push(root);
  const home = join(root, "home");
  mkdirSync(join(home, "bin"), { recursive: true });
  const machineEntryPath = fileURLToPath(
    new URL("./hook-machine.ts", import.meta.url),
  );
  const artifacts = createOwnedHookLauncherArtifacts({
    agentscopeHome: home,
    harnessType: "@agentscope/harness-codex",
    hookDeadlineMilliseconds: duration,
    machineEntryPath,
    nodeExecutable: process.execPath,
    platform: "posix",
    releaseIdentity: "0.1.0",
  });
  writeFileSync(artifacts.launcherPath, artifacts.launcherBytes, {
    mode: artifacts.mode,
  });
  chmodSync(artifacts.launcherPath, artifacts.mode);
  writeFileSync(artifacts.metadataPath, artifacts.metadataBytes);
  return { artifacts, machineEntryPath };
};

const authority = (path: string, arguments_: readonly string[] = []) => ({
  arguments: Object.freeze([...arguments_]),
  contractVersion: 1 as const,
  deadlineStartedAt: performance.now(),
  duration: Number(/-d(\d+)$/u.exec(path)?.[1]),
  physicalPath: path,
});

describe("owned machine hook bootstrap", () => {
  it("verifies the launcher and copies one EOF-framed evidence value", async () => {
    const { artifacts, machineEntryPath } = fixture();
    const received: unknown[] = [];
    await expect(
      runOwnedHookBootstrapForTesting(authority(artifacts.launcherPath), {
        machineEntryPath,
        onEvidence: (value) => {
          received.push(value);
        },
        releaseIdentity: "0.1.0",
        stdin: Readable.from([Buffer.from("bounded-evidence")]),
      }),
    ).resolves.toBeUndefined();
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      launcher: {
        duration: 2_000,
        harnessType: "@agentscope/harness-codex",
      },
    });
    expect(
      new TextDecoder().decode(
        (received[0] as { evidence: Uint8Array }).evidence,
      ),
    ).toBe("bounded-evidence");
  });

  it("rejects arguments and incompatible owned metadata before dispatch", async () => {
    const { artifacts, machineEntryPath } = fixture();
    let dispatched = false;
    const input = {
      machineEntryPath,
      onEvidence: () => {
        dispatched = true;
      },
      releaseIdentity: "0.1.0",
      stdin: Readable.from([]),
    };
    await expect(
      runOwnedHookBootstrapForTesting(
        authority(artifacts.launcherPath, ["--harness", "other"]),
        input,
      ),
    ).rejects.toThrow("cli.hook.invalid");
    writeFileSync(
      artifacts.metadataPath,
      Buffer.from(artifacts.metadataBytes)
        .toString("utf8")
        .replace('"releaseIdentity": "0.1.0"', '"releaseIdentity": "9.9.9"'),
    );
    await expect(
      runOwnedHookBootstrapForTesting(authority(artifacts.launcherPath), input),
    ).rejects.toThrow("cli.hook.invalid");
    expect(dispatched).toBe(false);
  });

  it.each([0, 65_536])("accepts the exact stdin boundary %i", async (size) => {
    const { artifacts, machineEntryPath } = fixture();
    let received = -1;
    await expect(
      runOwnedHookBootstrapForTesting(authority(artifacts.launcherPath), {
        machineEntryPath,
        onEvidence: ({ evidence }) => {
          received = evidence.byteLength;
        },
        releaseIdentity: "0.1.0",
        stdin: Readable.from(size === 0 ? [] : [new Uint8Array(size)]),
      }),
    ).resolves.toBeUndefined();
    expect(received).toBe(size);
  });
});

describe("owned machine hook failure boundaries", () => {
  it("bounds overflow and a stream that never reaches EOF", async () => {
    const oversized = fixture();
    await expect(
      runOwnedHookBootstrapForTesting(
        authority(oversized.artifacts.launcherPath),
        {
          machineEntryPath: oversized.machineEntryPath,
          onEvidence: () => undefined,
          releaseIdentity: "0.1.0",
          stdin: Readable.from([new Uint8Array(65_537)]),
        },
      ),
    ).rejects.toThrow("cli.hook.invalid");

    const hanging = fixture(200);
    const stream = new Readable({ read: () => undefined });
    const startedAt = performance.now();
    await expect(
      runOwnedHookBootstrapForTesting(
        authority(hanging.artifacts.launcherPath),
        {
          machineEntryPath: hanging.machineEntryPath,
          onEvidence: () => undefined,
          releaseIdentity: "0.1.0",
          stdin: stream,
        },
      ),
    ).rejects.toThrow("cli.hook.invalid");
    expect(performance.now() - startedAt).toBeLessThan(300);
    expect(stream.destroyed).toBe(true);
  });

  it("kills hostile verifier work and contains an input stream error", async () => {
    const hangingVerifier = fixture(100);
    await expect(
      runOwnedHookBootstrapForTesting(
        authority(hangingVerifier.artifacts.launcherPath),
        {
          machineEntryPath: hangingVerifier.machineEntryPath,
          onEvidence: () => undefined,
          releaseIdentity: "0.1.0",
          stdin: Readable.from([]),
          verifierProgram: "await new Promise(() => undefined);",
        },
      ),
    ).rejects.toThrow("cli.hook.invalid");

    const noisyVerifier = fixture(200);
    await expect(
      runOwnedHookBootstrapForTesting(
        authority(noisyVerifier.artifacts.launcherPath),
        {
          machineEntryPath: noisyVerifier.machineEntryPath,
          onEvidence: () => undefined,
          releaseIdentity: "0.1.0",
          stdin: Readable.from([]),
          verifierProgram: 'process.stdout.write("x".repeat(5000));',
        },
      ),
    ).rejects.toThrow("cli.hook.invalid");

    const failingStream = fixture();
    const stream = new Readable({
      read() {
        this.destroy(new Error("CANARY_EVIDENCE_ERROR"));
      },
    });
    await expect(
      runOwnedHookBootstrapForTesting(
        authority(failingStream.artifacts.launcherPath),
        {
          machineEntryPath: failingStream.machineEntryPath,
          onEvidence: () => undefined,
          releaseIdentity: "0.1.0",
          stdin: stream,
        },
      ),
    ).rejects.toThrow("cli.hook.invalid");
  });
});

describe("owned machine hook verification failures", () => {
  it.each([
    "null",
    '{"duration":2000,"harnessType":"@agentscope/harness-codex","homeRoot":"/tmp","extra":true}',
    '{"duration":1999,"harnessType":"@agentscope/harness-codex","homeRoot":"/tmp"}',
    "not-json",
  ])("rejects malformed verifier response %s", async (response) => {
    const value = fixture();
    await expect(
      runOwnedHookBootstrapForTesting(authority(value.artifacts.launcherPath), {
        machineEntryPath: value.machineEntryPath,
        onEvidence: () => undefined,
        releaseIdentity: "0.1.0",
        stdin: Readable.from([]),
        verifierProgram: `process.stdout.write(${JSON.stringify(response)});`,
      }),
    ).rejects.toThrow("cli.hook.invalid");
  });

  it("rejects relocation, mode drift, byte drift, and expired authority", async () => {
    const relocated = fixture();
    const alias = `${relocated.artifacts.launcherPath}.alias`;
    symlinkSync(relocated.artifacts.launcherPath, alias);
    const input = {
      machineEntryPath: relocated.machineEntryPath,
      onEvidence: () => undefined,
      releaseIdentity: "0.1.0",
      stdin: Readable.from([]),
    };
    await expect(
      runOwnedHookBootstrapForTesting(authority(alias), input),
    ).rejects.toThrow("cli.hook.invalid");

    const wrongMode = fixture();
    chmodSync(wrongMode.artifacts.launcherPath, 0o755);
    await expect(
      runOwnedHookBootstrapForTesting(
        authority(wrongMode.artifacts.launcherPath),
        { ...input, machineEntryPath: wrongMode.machineEntryPath },
      ),
    ).rejects.toThrow("cli.hook.invalid");

    const changed = fixture();
    writeFileSync(changed.artifacts.launcherPath, "#!/bin/false\n");
    chmodSync(changed.artifacts.launcherPath, 0o700);
    await expect(
      runOwnedHookBootstrapForTesting(
        authority(changed.artifacts.launcherPath),
        {
          ...input,
          machineEntryPath: changed.machineEntryPath,
        },
      ),
    ).rejects.toThrow("cli.hook.invalid");

    const expired = fixture(50);
    await expect(
      runOwnedHookBootstrapForTesting(
        {
          ...authority(expired.artifacts.launcherPath),
          deadlineStartedAt: performance.now() - 51,
        },
        { ...input, machineEntryPath: expired.machineEntryPath },
      ),
    ).rejects.toThrow("cli.hook.invalid");
  });
});
