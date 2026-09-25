import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  copyFileSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("interactive PTY action staging", () => {
  it("imports from the all-and-only staged built module graph", () => {
    const root = mkdtempSync(resolve(tmpdir(), "agentscope-pty-actions-"));
    const staged = resolve(root, "dist");
    try {
      mkdirSync(staged);
      for (const file of ["canonical.js", "interactive-pty-actions.js"])
        copyFileSync(
          resolve(import.meta.dirname, "../dist/" + file),
          resolve(staged, file),
        );
      const packageBoundaryPath = resolve(staged, "package.json");
      const packageBoundaryBytes = Buffer.from('{"type":"module"}\n');
      const previousUmask = process.umask(0o077);
      let packageBoundaryDescriptor = -1;
      try {
        packageBoundaryDescriptor = openSync(
          packageBoundaryPath,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          0o600,
        );
        writeFileSync(packageBoundaryDescriptor, packageBoundaryBytes);
        fchmodSync(packageBoundaryDescriptor, 0o644);
        fsyncSync(packageBoundaryDescriptor);
        const descriptorStatus = fstatSync(packageBoundaryDescriptor);
        const pathStatus = lstatSync(packageBoundaryPath);
        expect(descriptorStatus.dev).toBe(pathStatus.dev);
        expect(descriptorStatus.ino).toBe(pathStatus.ino);
        expect(descriptorStatus.size).toBe(packageBoundaryBytes.byteLength);
        expect(pathStatus.size).toBe(packageBoundaryBytes.byteLength);
        expect(descriptorStatus.mode & 0o777).toBe(0o644);
        expect(pathStatus.mode & 0o777).toBe(0o644);
      } finally {
        if (packageBoundaryDescriptor !== -1)
          closeSync(packageBoundaryDescriptor);
        process.umask(previousUmask);
      }
      const entrypoint = resolve(root, "verify-staged-graph.mjs");
      writeFileSync(
        entrypoint,
        'import { compileInteractivePtyActions } from "./dist/interactive-pty-actions.js";\nprocess.stdout.write(typeof compileInteractivePtyActions);\n',
        { encoding: "utf8", mode: 0o600 },
      );
      const result = spawnSync(
        process.execPath,
        ["--no-experimental-detect-module", entrypoint],
        {
          cwd: root,
          encoding: "utf8",
          env: {},
          timeout: 5_000,
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe("function");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
