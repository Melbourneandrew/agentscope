import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ClaudeDiscoveryPolicy } from "@agentscope/harness-claude-code";
import {
  authenticateExactFile,
  createProductClaudeDiscoveryFactory,
  executableCandidates,
  revalidateAuthenticatedFile,
} from "./product-harness-probe-files.js";

const createClaudeDiscoveryProbe = (
  input: Parameters<
    ReturnType<typeof createProductClaudeDiscoveryFactory>["bindInvocation"]
  >[0],
) => createProductClaudeDiscoveryFactory().bindInvocation(input).probe;

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const bytes = Buffer.from("synthetic-native-artifact-not-executed");
const identity = {
  bytes: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
};
const policy: ClaudeDiscoveryPolicy = {
  version: "2.1.245",
  platforms: { "linux-x64": identity, "darwin-arm64": identity },
};
const fixture = async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "agentscope-claude-discovery-")),
  );
  roots.push(root);
  const path = join(root, "claude");
  await writeFile(path, bytes, { mode: 0o755 });
  const environment = { PATH: root };
  const input = {
    environment,
    homeDirectory: root,
    projectDirectory: root,
    platform: "linux" as const,
    architecture: "x64" as const,
    policy,
  };
  return { root, path, input, probe: createClaudeDiscoveryProbe(input) };
};

describe("exact Claude native discovery", () => {
  it("observes exact native bytes without execution and inspects the selected profile", async () => {
    const { root, path, probe } = await fixture();
    expect(await probe.locateExecutable(["claude"])).toEqual({
      kind: "found",
      candidates: [{ path }],
    });
    expect(await probe.readVersion(path, ["--version"])).toEqual({
      kind: "observed",
      output: "2.1.245 (Claude Code)\n",
    });
    expect(
      await probe.inspectConfiguration([[".claude", "settings.json"]]),
    ).toEqual([{ locationIndex: 0, present: false }]);
    await mkdir(join(root, ".claude"));
    await writeFile(join(root, ".claude", "settings.json"), "{}");
    expect(
      await probe.inspectConfiguration([[".claude", "settings.json"]]),
    ).toEqual([{ locationIndex: 0, present: true }]);
  });
  it.each(["", "relative", "~/literal-root"])(
    "inspects defined override %s without substituting the default profile",
    async (value) => {
      const { input, path, root } = await fixture();
      await mkdir(join(root, ".claude"));
      await writeFile(join(root, ".claude", "settings.json"), "default-poison");
      const environment = { ...input.environment, CLAUDE_CONFIG_DIR: value };
      const probe = createClaudeDiscoveryProbe({
        ...input,
        environment,
      });
      expect((await probe.locateExecutable(["claude"])).kind).toBe("found");
      expect((await probe.readVersion(path, ["--version"])).kind).toBe(
        "observed",
      );
      expect(
        await probe.inspectConfiguration([[".claude", "settings.json"]]),
      ).toEqual([{ locationIndex: 0, present: false }]);
      const selected = {
        directory: join(root, value),
        settingsPath: join(root, value, "settings.json"),
      };
      await mkdir(selected.directory, { recursive: true });
      await writeFile(selected.settingsPath, "{}");
      expect(
        await probe.inspectConfiguration([[".claude", "settings.json"]]),
      ).toEqual([{ locationIndex: 0, present: true }]);
    },
  );
  it("does not execute accessor environment controls", async () => {
    const { input } = await fixture();
    let reads = 0;
    const environment = Object.defineProperty({}, "PATH", {
      get: () => {
        reads++;
        throw Error("must-not-read");
      },
    });
    const probe = createClaudeDiscoveryProbe({
      ...input,
      environment,
    });
    expect(await probe.locateExecutable(["claude"])).toEqual({
      kind: "unavailable",
    });
    expect(reads).toBe(0);
  });
  it.each(["wrapper", "failure-stub", "wrong-native"])(
    "never projects version from %s alone",
    async (content) => {
      const { path, probe } = await fixture();
      await writeFile(path, content);
      expect(await probe.readVersion(path, ["--version"])).toEqual({
        kind: "unavailable",
      });
    },
  );
});

describe("Claude discovery hostile filesystem boundaries", () => {
  it("supports npm replaced bin/claude.exe via the canonical executable", async () => {
    const { root, path, probe } = await fixture();
    await mkdir(join(root, "bin"));
    const native = join(root, "bin", "claude.exe");
    await rename(path, native);
    await symlink(native, path);
    expect(await probe.locateExecutable(["claude"])).toEqual({
      kind: "found",
      candidates: [{ path: native }],
    });
    expect((await probe.readVersion(native, ["--version"])).kind).toBe(
      "observed",
    );
  });
  it("rejects mode, platform, argument and configuration substitution", async () => {
    const { input, path, probe } = await fixture();
    expect((await probe.readVersion(path, ["--version", "extra"])).kind).toBe(
      "unavailable",
    );
    expect(
      (
        await createClaudeDiscoveryProbe({
          ...input,
          platform: "win32",
        }).readVersion(path, ["--version"])
      ).kind,
    ).toBe("unavailable");
    await chmod(path, 0o644);
    expect((await probe.readVersion(path, ["--version"])).kind).toBe(
      "unavailable",
    );
    await expect(
      probe.inspectConfiguration([[".claude", "other.json"]]),
    ).rejects.toThrow("probe-unavailable");
    expect((await probe.locateExecutable(["codex"])).kind).toBe("unavailable");
  });
  it("proves closed names, invalid PATH and genuine absence", async () => {
    const { root } = await fixture();
    expect((await executableCandidates(["other"], { PATH: root })).kind).toBe(
      "unavailable",
    );
    expect((await executableCandidates(["claude"], { PATH: "." })).kind).toBe(
      "unavailable",
    );
    expect((await executableCandidates(["codex"], { PATH: root })).kind).toBe(
      "absent",
    );
  });
  it("rejects file replacement after held-descriptor authentication", async () => {
    const { root, path } = await fixture();
    const authenticated = await authenticateExactFile(path, identity, 0o755);
    try {
      const replacement = join(root, "replacement");
      await writeFile(replacement, bytes, { mode: 0o755 });
      await rename(replacement, path);
      await expect(revalidateAuthenticatedFile(authenticated)).rejects.toThrow(
        "probe-unavailable",
      );
    } finally {
      await authenticated.handle.close();
    }
  });

  it("rejects in-place modification and a same-size substituted digest", async () => {
    const { path, probe } = await fixture();
    const authenticated = await authenticateExactFile(path, identity, 0o755);
    try {
      await writeFile(path, Buffer.alloc(bytes.length, 120));
      await expect(revalidateAuthenticatedFile(authenticated)).rejects.toThrow(
        "probe-unavailable",
      );
      expect((await probe.readVersion(path, ["--version"])).kind).toBe(
        "unavailable",
      );
    } finally {
      await authenticated.handle.close();
    }
  });

  it("rejects aliased configuration parent and symlink target rather than reporting absent", async () => {
    const { root, probe } = await fixture();
    const external = join(root, "external");
    await mkdir(external);
    await writeFile(join(external, "settings.json"), "{}");
    await symlink(external, join(root, ".claude"));
    await expect(
      probe.inspectConfiguration([[".claude", "settings.json"]]),
    ).rejects.toThrow("probe-unavailable");
    await rm(join(root, ".claude"));
    await mkdir(join(root, ".claude"));
    await symlink(
      join(external, "settings.json"),
      join(root, ".claude", "settings.json"),
    );
    await expect(
      probe.inspectConfiguration([[".claude", "settings.json"]]),
    ).rejects.toThrow("probe-unavailable");
  });
});
