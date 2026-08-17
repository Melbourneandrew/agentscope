import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { requireExactRegularFileTree } from "../codec-tree.mjs";

describe("generated codec directory closure", () => {
  it("requires the exact recursive regular-file inventory", () => {
    const directory = mkdtempSync(join(tmpdir(), "agentscope-codec-tree-"));
    try {
      mkdirSync(join(directory, "nested"));
      writeFileSync(join(directory, "nested", "codec.ts"), "generated");
      expect(() =>
        requireExactRegularFileTree(directory, ["nested/codec.ts"]),
      ).not.toThrow();
      writeFileSync(join(directory, "extra.ts"), "unmanifested");
      expect(() =>
        requireExactRegularFileTree(directory, ["nested/codec.ts"]),
      ).toThrowError("protocol.codec.generated.invalid");
      rmSync(join(directory, "extra.ts"));
      symlinkSync(
        join(directory, "nested", "codec.ts"),
        join(directory, "link"),
      );
      expect(() =>
        requireExactRegularFileTree(directory, ["nested/codec.ts"]),
      ).toThrowError("protocol.codec.generated.invalid");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
