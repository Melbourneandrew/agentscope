import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  applyHarnessInstallation,
  inspectHarnessInstallation,
  type HarnessInstallationPlanInput,
} from "./installation.js";

const roots: string[] = [];
const bytes = (value: string) => new TextEncoder().encode(value);
const write = async (path: string, value: string): Promise<void> => {
  await writeFile(path, value, { mode: 0o600 });
  await chmod(path, 0o600);
};
const fixture = async (mutation = true, guardExists = true) => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "agentscope-installation-preimages-")),
  );
  roots.push(root);
  const guard = join(root, "registry.json");
  const owned = join(root, "owned.json");
  if (guardExists) await write(guard, "registry-before");
  await write(owned, "owned-before");
  const input: HarnessInstallationPlanInput = {
    manifestPath: join(root, "transactions", "hooks.json"),
    operation: "install",
    targetPaths: mutation ? [guard, owned] : [guard],
    planner: (target) =>
      target.targetPath === owned
        ? { kind: "replace", bytes: bytes("owned-after"), mode: 0o600 }
        : { kind: "unchanged" },
  };
  return { root, guard, owned, input };
};

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true });
});

describe("same branded plan retains every inspected preimage", () => {
  it.each([true, false])(
    "refuses changed unchanged-target bytes before mutation=%s",
    async (mutation) => {
      const value = await fixture(mutation);
      const plan = await inspectHarnessInstallation(value.input);
      expect(plan.disposition).toBe(mutation ? "ready" : "unchanged");
      await write(value.guard, "registry-substituted");
      expect(await applyHarnessInstallation(plan)).toEqual({
        ok: false,
        state: "conflict",
        changedTargetCount: 0,
      });
      expect(await readFile(value.owned, "utf8")).toBe("owned-before");
      expect((await readdir(value.root)).sort()).toEqual([
        "owned.json",
        "registry.json",
      ]);
      expect((await applyHarnessInstallation(plan)).state).toBe("invalid");
    },
  );

  it.each([true, false])(
    "refuses deleted guard before mutation=%s",
    async (mutation) => {
      const value = await fixture(mutation);
      const plan = await inspectHarnessInstallation(value.input);
      await unlink(value.guard);
      expect((await applyHarnessInstallation(plan)).state).toBe("conflict");
      expect(await readFile(value.owned, "utf8")).toBe("owned-before");
      expect(await readdir(value.root)).toEqual(["owned.json"]);
    },
  );

  it.each([true, false])(
    "refuses creation at an inspected absence before mutation=%s",
    async (mutation) => {
      const value = await fixture(mutation, false);
      const plan = await inspectHarnessInstallation(value.input);
      await write(value.guard, "new-registry");
      expect((await applyHarnessInstallation(plan)).state).toBe("conflict");
      expect(await readFile(value.owned, "utf8")).toBe("owned-before");
      expect((await readdir(value.root)).sort()).toEqual([
        "owned.json",
        "registry.json",
      ]);
    },
  );

  it.each([true, false])(
    "refuses mode-only guard drift before mutation=%s",
    async (mutation) => {
      const value = await fixture(mutation);
      const plan = await inspectHarnessInstallation(value.input);
      await chmod(value.guard, 0o700);
      expect((await applyHarnessInstallation(plan)).state).toBe("conflict");
      expect(await readFile(value.guard, "utf8")).toBe("registry-before");
      expect(await readFile(value.owned, "utf8")).toBe("owned-before");
    },
  );

  it("keeps equal replacement preimages even when no target mutates", async () => {
    const value = await fixture(false);
    const plan = await inspectHarnessInstallation({
      ...value.input,
      planner: (target) => ({
        kind: "replace",
        bytes: target.bytes!,
        mode: 0o600,
      }),
    });
    expect(plan.disposition).toBe("unchanged");
    await write(value.guard, "changed");
    expect((await applyHarnessInstallation(plan)).state).toBe("conflict");
  });
});

describe("read-only guard authority and mutation ownership stay separate", () => {
  it("leaves a stable guard out of mutation artifacts and ownership", async () => {
    const value = await fixture();
    const plan = await inspectHarnessInstallation(value.input);
    expect(plan).toMatchObject({ targetCount: 2, changedTargetCount: 1 });
    expect(await applyHarnessInstallation(plan)).toEqual({
      ok: true,
      state: "committed",
      changedTargetCount: 1,
    });
    expect(await readFile(value.guard, "utf8")).toBe("registry-before");
    expect(await readFile(value.owned, "utf8")).toBe("owned-after");
    const markers = (await readdir(value.root)).filter((name) =>
      name.endsWith(".owner"),
    );
    expect(markers).toHaveLength(1);
    const marker: unknown = JSON.parse(
      await readFile(join(value.root, markers[0]!), "utf8"),
    );
    expect(marker).toMatchObject({ targetPath: value.owned });
    expect(await readdir(join(value.root, "transactions"))).toEqual([]);
    expect((await applyHarnessInstallation(plan)).state).toBe("invalid");
  });

  it.each([true, false])(
    "stable guard-only plan exists=%s succeeds exactly once without artifacts",
    async (guardExists) => {
      const value = await fixture(false, guardExists);
      const plan = await inspectHarnessInstallation(value.input);
      expect(await applyHarnessInstallation(plan)).toEqual({
        ok: true,
        state: "unchanged",
        changedTargetCount: 0,
      });
      expect((await applyHarnessInstallation(plan)).state).toBe("invalid");
      expect((await readdir(value.root)).sort()).toEqual(
        guardExists ? ["owned.json", "registry.json"] : ["owned.json"],
      );
    },
  );

  it("rejects a cloned plan without consuming genuine guard authority", async () => {
    const value = await fixture(false);
    const plan = await inspectHarnessInstallation(value.input);
    expect((await applyHarnessInstallation({ ...plan })).state).toBe("invalid");
    expect((await applyHarnessInstallation(plan)).state).toBe("unchanged");
  });

  it("still validates a changed target mode before the first publication", async () => {
    const value = await fixture();
    const plan = await inspectHarnessInstallation(value.input);
    await chmod(value.owned, 0o700);
    expect((await applyHarnessInstallation(plan)).state).toBe("conflict");
    expect((await readdir(value.root)).sort()).toEqual([
      "owned.json",
      "registry.json",
    ]);
  });

  it("does not expose private preimages or inspected bytes in the plan", async () => {
    const value = await fixture();
    const plan = await inspectHarnessInstallation(value.input);
    expect(Object.keys(plan).sort()).toEqual([
      "changedTargetCount",
      "disposition",
      "targetCount",
    ]);
    expect(JSON.stringify(plan)).not.toContain("registry-before");
  });
});

describe("unchanged guards retain the existing closed input bounds", () => {
  it("refuses an unwritten FIFO substituted after a genuine unchanged plan", async () => {
    const value = await fixture(false);
    const module = new URL("./installation.ts", import.meta.url).href;
    const script = `import { unlink } from "node:fs/promises";
      import { execFileSync } from "node:child_process";
      import { inspectHarnessInstallation, applyHarnessInstallation } from ${JSON.stringify(module)};
      const target = ${JSON.stringify(value.guard)};
      const plan = await inspectHarnessInstallation({
        manifestPath: ${JSON.stringify(value.input.manifestPath)},
        operation: "install", targetPaths: [target],
        planner: () => ({kind: "unchanged"})
      });
      if (plan.disposition !== "unchanged") process.exit(2);
      await unlink(target);
      execFileSync("/usr/bin/mkfifo", [target], {env: {}, timeout: 1000});
      console.log("apply-entered");
      const result = await applyHarnessInstallation(plan);
      console.log(JSON.stringify(result));
      if (result.ok || result.state !== "invalid") process.exitCode = 3;`;
    // Source public API under the standard TypeScript test loader; no test seam.
    const child = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", script],
      {
        env: {},
        timeout: 1_000,
        killSignal: "SIGKILL",
        maxBuffer: 4_096,
        encoding: "utf8",
      },
    );
    expect(child.error).toBeUndefined();
    expect(child.signal).toBeNull();
    expect(child.status).toBe(0);
    expect(child.stderr).toBe("");
    expect(child.stdout).toBe(
      'apply-entered\n{"ok":false,"state":"invalid","changedTargetCount":0}\n',
    );
    expect(await readFile(value.owned, "utf8")).toBe("owned-before");
    expect((await readdir(value.root)).sort()).toEqual([
      "owned.json",
      "registry.json",
    ]);
  });

  it("refuses an oversized unchanged target", async () => {
    const value = await fixture(false);
    await writeFile(value.guard, Buffer.alloc(1_048_577));
    expect((await inspectHarnessInstallation(value.input)).disposition).toBe(
      "invalid",
    );
  });

  it("rejects more than sixteen targets before calling the planner", async () => {
    const value = await fixture(false);
    let called = false;
    const plan = await inspectHarnessInstallation({
      ...value.input,
      targetPaths: Array.from({ length: 17 }, (_, index) =>
        join(value.root, `guard-${index}`),
      ),
      planner: () => {
        called = true;
        return { kind: "unchanged" };
      },
    });
    expect(plan.disposition).toBe("invalid");
    expect(called).toBe(false);
  });

  it("rejects a substituted final symlink on guarded apply", async () => {
    const value = await fixture();
    const plan = await inspectHarnessInstallation(value.input);
    await unlink(value.guard);
    await symlink(value.owned, value.guard);
    expect((await applyHarnessInstallation(plan)).ok).toBe(false);
    expect(await readFile(value.owned, "utf8")).toBe("owned-before");
  });

  it("rejects a substituted directory without writing artifacts", async () => {
    const value = await fixture(false);
    const plan = await inspectHarnessInstallation(value.input);
    await unlink(value.guard);
    await mkdir(value.guard);
    expect((await applyHarnessInstallation(plan)).state).toBe("invalid");
    expect((await readdir(value.root)).sort()).toEqual([
      "owned.json",
      "registry.json",
    ]);
  });
});
