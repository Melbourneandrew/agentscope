import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const helper = resolve(import.meta.dirname, "../codex-candidate-dropper.mjs");

describe("Codex candidate principal dropper", () => {
  it("rejects any caller-selected command or argument", () => {
    const result = spawnSync(process.execPath, [helper, "--forbidden"], {
      env: { LANG: "C.UTF-8", PATH: "/usr/local/bin:/usr/bin:/bin" },
      timeout: 2_000,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr.toString()).toContain(
      "integration.codex.candidate-principal",
    );
  });

  it.skipIf(process.platform === "linux" && process.getuid?.() === 0)(
    "rejects an unprivileged controller before any candidate exec",
    () => {
      const result = spawnSync(process.execPath, [helper], {
        env: { LANG: "C.UTF-8", PATH: "/usr/local/bin:/usr/bin:/bin" },
        timeout: 2_000,
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr.toString()).toContain(
        "integration.codex.candidate-principal",
      );
    },
  );
});
