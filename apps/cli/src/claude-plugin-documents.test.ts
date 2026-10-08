import { readProductHarnessTextDocument } from "./product-harness-probe-files.js";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});
const fixture = async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "agentscope-plugin-document-")),
  );
  roots.push(root);
  return { root, path: join(root, "document.json") };
};
const hash = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

describe("project metadata shares the bounded authenticated document reader", () => {
  it("binds exact text without pretending non-JSON project metadata is JSON", async () => {
    const value = await fixture();
    const bytes = Buffer.from("gitdir: ../worktrees/selected\n");
    await writeFile(value.path, bytes);
    await chmod(value.path, 0o644);
    const document = await readProductHarnessTextDocument(value.path);
    expect(document).toEqual({
      guard: {
        targetPath: value.path,
        exists: true,
        digest: hash(bytes),
        mode: 0o644,
      },
      text: bytes.toString("utf8"),
    });
    expect(Object.isFrozen(document)).toBe(true);
    expect(Object.isFrozen(document.guard)).toBe(true);
    expect(document.text).toBe(bytes.toString("utf8"));
  });

  it("preserves absence and exactly the JSON reader's consulted preimage", async () => {
    const value = await fixture();
    expect(await readProductHarnessTextDocument(value.path)).toMatchObject({
      guard: { exists: false },
      text: undefined,
    });
    await writeFile(value.path, '{"name":"ordinary"}\n');
    const text = await readProductHarnessTextDocument(value.path);
    const json = await readProductHarnessTextDocument(value.path);
    expect(json.guard).toEqual(text.guard);
    expect(json.text).toEqual(text.text);
  });

  it("rejects invalid UTF-8 and symlinked text just like JSON inputs", async () => {
    const value = await fixture();
    await writeFile(value.path, Buffer.from([0xff]));
    await expect(readProductHarnessTextDocument(value.path)).rejects.toThrow(
      "cli.harness.plugin-inventory-unavailable",
    );
    await rm(value.path);
    await symlink("elsewhere", value.path);
    await expect(readProductHarnessTextDocument(value.path)).rejects.toThrow(
      "cli.harness.plugin-inventory-unavailable",
    );
  });
});

describe("bounded consulted Claude plugin documents", () => {
  it("binds the exact document bytes and mode without inventing metadata", async () => {
    const value = await fixture();
    const bytes = Buffer.from('{"name":"ordinary-plugin"}\n');
    await writeFile(value.path, bytes, { mode: 0o600 });
    await chmod(value.path, 0o600);
    const document = await readProductHarnessTextDocument(value.path);
    expect(document).toEqual({
      guard: {
        targetPath: value.path,
        exists: true,
        digest: hash(bytes),
        mode: 0o600,
      },
      text: bytes.toString("utf8"),
    });
    expect(Object.isFrozen(document)).toBe(true);
    expect(Object.isFrozen(document.guard)).toBe(true);
  });

  it("keeps authenticated file absence distinct from an empty registry", async () => {
    const value = await fixture();
    expect(await readProductHarnessTextDocument(value.path)).toEqual({
      guard: {
        targetPath: value.path,
        exists: false,
        digest: hash(new Uint8Array()),
        mode: null,
      },
      text: undefined,
    });
    await writeFile(value.path, "{}", { mode: 0o600 });
    expect((await readProductHarnessTextDocument(value.path)).text).toBe("{}");
  });

  it.each([Buffer.from([0xff])])(
    "rejects malformed documents without disclosing bytes or native errors",
    async (bytes) => {
      const value = await fixture();
      await writeFile(value.path, bytes);
      await expect(readProductHarnessTextDocument(value.path)).rejects.toThrow(
        /^cli\.harness\.plugin-inventory-unavailable$/u,
      );
    },
  );

  it("accepts the inclusive byte ceiling and rejects ceiling plus one", async () => {
    const value = await fixture();
    const bytes = Buffer.from(`{}${" ".repeat(1_048_574)}`);
    await writeFile(value.path, bytes);
    expect(
      (await readProductHarnessTextDocument(value.path)).guard.digest,
    ).toBe(hash(bytes));
    await writeFile(value.path, Buffer.concat([bytes, Buffer.from(" ")]));
    await expect(readProductHarnessTextDocument(value.path)).rejects.toThrow(
      "cli.harness.plugin-inventory-unavailable",
    );
  });

  it("refuses a final symlink and a directory", async () => {
    const value = await fixture();
    const target = join(value.root, "target.json");
    await writeFile(target, "{}");
    await symlink(target, value.path);
    await expect(readProductHarnessTextDocument(value.path)).rejects.toThrow(
      "cli.harness.plugin-inventory-unavailable",
    );
    await expect(readProductHarnessTextDocument(value.root)).rejects.toThrow(
      "cli.harness.plugin-inventory-unavailable",
    );
  });

  it.skipIf(process.platform === "win32")(
    "refuses an actual FIFO without waiting for a writer",
    async () => {
      const value = await fixture();
      execFileSync("/usr/bin/mkfifo", [value.path]);
      await expect(readProductHarnessTextDocument(value.path)).rejects.toThrow(
        "cli.harness.plugin-inventory-unavailable",
      );
    },
    1_000,
  );

  it("binds file permission changes separately from unchanged bytes", async () => {
    const value = await fixture();
    await writeFile(value.path, "{}", { mode: 0o600 });
    await chmod(value.path, 0o600);
    const before = await readProductHarnessTextDocument(value.path);
    await chmod(value.path, 0o644);
    const after = await readProductHarnessTextDocument(value.path);
    expect(before.guard.digest).toBe(after.guard.digest);
    expect(before.guard.mode).toBe(0o600);
    expect(after.guard.mode).toBe(0o644);
  });

  it("refuses aliased parents and non-directory ancestors instead of claiming absence", async () => {
    const value = await fixture();
    const target = join(value.root, "target");
    const alias = join(value.root, "alias");
    await mkdir(target);
    await symlink(target, alias);
    await expect(
      readProductHarnessTextDocument(join(alias, "missing.json")),
    ).rejects.toThrow("cli.harness.plugin-inventory-unavailable");
    await writeFile(value.path, "{}");
    await expect(
      readProductHarnessTextDocument(join(value.path, "missing.json")),
    ).rejects.toThrow("cli.harness.plugin-inventory-unavailable");
    await expect(
      readProductHarnessTextDocument("relative.json"),
    ).rejects.toThrow("cli.harness.plugin-inventory-unavailable");
  });
});
