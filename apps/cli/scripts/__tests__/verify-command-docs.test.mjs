import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { commandRegistry } from "../../src/command-registry.ts";
import {
  commandContractFingerprint,
  createProductionProgramForDocumentation,
  verifyCommandDocumentation,
} from "../verify-command-docs.mjs";
import { CLI_AUTOMATION_CONTRACT } from "../../src/automation-contract.ts";

const repositoryRoot = resolve(import.meta.dirname, "../../../..");
const sourceDocs = join(repositoryRoot, "apps/docs/content/docs");
const temporaryRoots = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agentscope-cli-docs-"));
  temporaryRoots.push(root);
  mkdirSync(join(root, "cli"));
  cpSync(join(sourceDocs, "cli"), join(root, "cli"), { recursive: true });
  cpSync(join(sourceDocs, "meta.json"), join(root, "meta.json"));
  return root;
}

function verify(root) {
  return verifyCommandDocumentation({
    docsRoot: root,
    program: createProductionProgramForDocumentation(),
    registry: commandRegistry,
  });
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("CLI command documentation verifier", () => {
  it("accepts the exact public command contract", () => {
    expect(verify(fixture())).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it("binds machine schemas and stream ordering into the fingerprint", () => {
    const program = createProductionProgramForDocumentation();
    const current = commandContractFingerprint(commandRegistry, program);
    const changed = commandContractFingerprint(commandRegistry, program, {
      ...CLI_AUTOMATION_CONTRACT,
      planJson: "agentscope.cli.plan.v2",
    });
    const reordered = commandContractFingerprint(commandRegistry, program, {
      ...CLI_AUTOMATION_CONTRACT,
      channels: {
        ...CLI_AUTOMATION_CONTRACT.channels,
        plan: "stderr-after-mutation",
      },
    });
    expect(changed).not.toBe(current);
    expect(reordered).not.toBe(current);
  });

  it.each([
    [
      "missing page",
      (root) => {
        unlinkSync(join(root, "cli/index.mdx"));
      },
    ],
    [
      "stale fingerprint",
      (root) => {
        const page = join(root, "cli/index.mdx");
        writeFileSync(
          page,
          readFileSync(page, "utf8").replace(
            /sha256:[a-f0-9]{64}/u,
            "sha256:".padEnd(71, "0"),
          ),
        );
      },
    ],
    [
      "orphan page",
      (root) => {
        writeFileSync(
          join(root, "cli/orphan.mdx"),
          "---\ntitle: orphan\n---\n",
        );
      },
    ],
    [
      "missing navigation",
      (root) => {
        writeFileSync(join(root, "cli/meta.json"), '{"pages":[]}\n');
      },
    ],
    [
      "missing required section",
      (root) => {
        const page = join(root, "cli/index.mdx");
        writeFileSync(
          page,
          readFileSync(page, "utf8").replace(
            "\n## Automation\n",
            "\n### Automation\n",
          ),
        );
      },
    ],
  ])("rejects %s", (_name, mutate) => {
    const root = fixture();
    mutate(root);
    expect(() => verify(root)).toThrow("cli.documentation.invalid");
  });
});
