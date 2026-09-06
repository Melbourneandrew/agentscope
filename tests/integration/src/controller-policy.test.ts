import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { runSupervisedProcess } from "../supervisor.mjs";

const workspaceRoot = resolve(import.meta.dirname, "../../..");
const manifest = (path: string) =>
  JSON.parse(readFileSync(resolve(workspaceRoot, path), "utf8")) as {
    scripts: Record<string, string>;
  };

describe("integration controller policy", () => {
  it("exposes one integration command and no public stage aliases", () => {
    const root = manifest("package.json");
    const integration = manifest("tests/integration/package.json");
    expect(root.scripts["test:integration"]).toBe(
      "pnpm --filter @agentscope/integration integration",
    );
    expect(integration.scripts.integration).toBe("node controller.mjs");
    for (const name of [
      "prepare:candidate",
      "prepare:images",
      "prepare:model-routes",
      "run:scenarios",
      "test:integration:clean",
      "test:integration:runner",
    ]) {
      expect(root.scripts).not.toHaveProperty(name);
      expect(integration.scripts).not.toHaveProperty(name);
    }
  });

  it("removes the validation lease without creating an outer-host platform", () => {
    expect(
      existsSync(resolve(workspaceRoot, "scripts/validation-lease.py")),
    ).toBe(false);
    expect(
      existsSync(
        resolve(workspaceRoot, "scripts/__tests__/validation-lease.test.mjs"),
      ),
    ).toBe(false);
    const source = readFileSync(
      resolve(workspaceRoot, "tests/integration/src/controller.ts"),
      "utf8",
    );
    expect(source).not.toMatch(
      /OIDC|attestation|bootstrap-manifest|PNPM_HOME|validation lease/iu,
    );
    expect(source).toMatch(
      /const dockerEndpoint =\s*`unix:\/\/\$\{realpathSync\("\/var\/run\/docker\.sock"\)\}`/u,
    );
  });

  it("retains narrow cleanup ceilings for controller-owned artifacts", () => {
    const source = readFileSync(
      resolve(workspaceRoot, "tests/integration/clean.mjs"),
      "utf8",
    );
    expect(source).toContain(
      '"current-images.json": IMAGE_PREPARATION_LIMITS.maximumEvidenceBytes',
    );
    expect(source).toContain('"current-candidate.json": 16_384');
    expect(source).toContain('"current-model-routes.json": 16_384');
    expect(source).toContain('"current-selection.json": 16_384');
    expect(source).toContain(
      "const addFile = (targets, relative, maximumBytes = 16_384)",
    );
  });

  it("rejects direct execution of every mutation stage", () => {
    for (const stage of [
      "clean.mjs",
      "maintain-artifacts.mjs",
      "prepare-cli.mjs",
      "prepare-images.mjs",
      "prepare-model-routes.mjs",
      "run-scenarios.mjs",
      "select.mjs",
    ]) {
      const result = spawnSync(process.execPath, [stage], {
        cwd: resolve(workspaceRoot, "tests/integration"),
        encoding: "utf8",
        env: { LANG: "C.UTF-8", PATH: process.env.PATH },
      });
      expect(result.status, stage).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`, stage).toContain(
        "integration.outer-host.capability-required",
      );
    }
  });
});

describe("integration controller supervision", () => {
  it("kills and proves absence of descendants after the leader exits", async () => {
    if (process.platform === "win32") return;
    const directory = mkdtempSync(resolve(tmpdir(), "agentscope-supervisor-"));
    const evidence = resolve(directory, "descendant.pid");
    try {
      const result = await runSupervisedProcess({
        arguments_: [
          resolve(
            workspaceRoot,
            "tests/integration/fixtures/stubborn-controller-child.mjs",
          ),
        ],
        environment: {
          AGENTSCOPE_SUPERVISOR_EVIDENCE: evidence,
          LANG: "C.UTF-8",
          PATH: "/usr/bin:/bin",
        },
        executable: process.execPath,
        maximumMilliseconds: 5_000,
        stdio: "ignore",
      });
      expect(result).toMatchObject({
        code: 1,
        contained: true,
        residualWorkObserved: true,
      });
      const descendant = Number(readFileSync(evidence, "utf8"));
      expect(() => process.kill(descendant, 0)).toThrow(
        expect.objectContaining({ code: "ESRCH" }),
      );
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("does not upgrade a successful leader with residual work", async () => {
    if (process.platform === "win32") return;
    const directory = mkdtempSync(resolve(tmpdir(), "agentscope-supervisor-"));
    const evidence = resolve(directory, "descendant.pid");
    try {
      const result = await runSupervisedProcess({
        arguments_: [
          resolve(
            workspaceRoot,
            "tests/integration/fixtures/stubborn-controller-child.mjs",
          ),
        ],
        environment: {
          AGENTSCOPE_SUPERVISOR_EVIDENCE: evidence,
          AGENTSCOPE_SUPERVISOR_LEADER_EXIT: "0",
          LANG: "C.UTF-8",
          PATH: "/usr/bin:/bin",
        },
        executable: process.execPath,
        maximumMilliseconds: 5_000,
        stdio: "ignore",
      });
      expect(result).toMatchObject({
        code: 0,
        contained: true,
        residualWorkObserved: true,
      });
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});

describe("integration workflow policy", () => {
  it("routes both CI phases through the same command", () => {
    const workflow = readFileSync(
      resolve(workspaceRoot, ".github/workflows/integration.yml"),
      "utf8",
    );
    expect(workflow.match(/pnpm test:integration/gu)).toHaveLength(2);
    expect(workflow.match(/persist-credentials: false/gu)).toHaveLength(2);
    expect(
      workflow.match(/NPM_CONFIG_GLOBALCONFIG=.*agentscope-global\.npmrc/gu),
    ).toHaveLength(2);
    expect(
      workflow.match(/NPM_CONFIG_USERCONFIG=.*agentscope-user\.npmrc/gu),
    ).toHaveLength(2);
    expect(
      workflow.match(/Initialize closed npm configuration/gu),
    ).toHaveLength(2);
    expect(workflow).not.toMatch(/\$\{\{ runner\.temp \}\}/gu);
    expect(
      workflow.match(/AGENTSCOPE_INTEGRATION_OUTER_DEADLINE_MONOTONIC_MS/gu),
    ).toHaveLength(2);
    expect(workflow).not.toMatch(
      /prepare:candidate|prepare:images|prepare:model-routes|run:scenarios|test:integration:clean/gu,
    );
  });
});
