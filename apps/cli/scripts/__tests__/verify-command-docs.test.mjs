import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

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
  vi.unstubAllEnvs();
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("CLI command lazy-import failure boundaries", () => {
  it.each(["deadline", "abort", "import-error"])(
    "refuses input/services after a %s during the actual lazy Core import",
    (failure) => {
      vi.stubEnv("FORCE_COLOR", "1");
      vi.stubEnv("NO_COLOR", "1");
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "-e",
          `import { registerHooks } from 'node:module';
           let clock = 0;
           Object.defineProperty(performance, 'now', { value: () => clock });
           registerHooks({ resolve(specifier, context, next) {
             if (specifier === '@agentscope/core') {
               if (${JSON.stringify(failure)} === 'deadline') clock = 60000;
               if (${JSON.stringify(failure)} === 'abort') process.emit('SIGINT');
               if (${JSON.stringify(failure)} === 'import-error')
                 throw new Error('docs.fixture.core-dist-unavailable');
             }
             return next(specifier, context);
           }});
           const { runCli } = await import('./apps/cli/src/program.ts');
           const { configurationCommandModules } =
             await import('./apps/cli/src/configuration-commands.ts');
           const module = configurationCommandModules.find(value => value.id === 'destination.list');
           let reads = 0, services = 0, executions = 0, timers = 0;
           const set = globalThis.setTimeout, clear = globalThis.clearTimeout;
           globalThis.setTimeout = (...args) => { timers++; return set(...args); };
           globalThis.clearTimeout = handle => { timers--; clear(handle); };
           const before = ['SIGINT', 'SIGTERM'].map(signal => process.listenerCount(signal));
           const diagnostics = [];
           const exit = await runCli(['destination', 'list', '--output', 'json'], {
             version: '0.0.0',
             modules: [{ ...module,
               readInput: command => { reads++; return module.readInput(command); },
               execute: () => { executions++; throw new Error('fixture.execution'); }
             }],
             createServices: () => { services++; return {}; },
             output: { writeOut: () => { throw new Error('fixture.output'); },
               writeErr: value => diagnostics.push(JSON.parse(value).code) }
           });
           process.stdout.write(JSON.stringify({ exit, reads, services, executions, timers,
             signalsRestored: before.every((count, index) => count === process.listenerCount(['SIGINT', 'SIGTERM'][index])),
             diagnostics }));`,
        ],
        {
          cwd: repositoryRoot,
          env: { ...process.env, FORCE_COLOR: undefined, NO_COLOR: undefined },
          encoding: "utf8",
          timeout: 5_000,
          killSignal: "SIGKILL",
          maxBuffer: 16_384,
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual({
        exit: 70,
        reads: 0,
        services: 0,
        executions: 0,
        timers: 0,
        signalsRestored: true,
        diagnostics: ["cli.internal"],
      });
    },
  );
});

describe("CLI command source-only documentation graph", () => {
  it.each([
    [false, false],
    [false, true],
    [true, true],
  ])(
    "keeps the source docs graph cold (legacy edge: %s, caller color conflict: %s)",
    (legacyEdge, colorConflict) => {
      if (colorConflict) {
        vi.stubEnv("FORCE_COLOR", "1");
        vi.stubEnv("NO_COLOR", "1");
      }
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "-e",
          `import { registerHooks } from 'node:module';
           registerHooks({
             resolve(specifier, context, next) {
               if (specifier === '@agentscope/core')
                 throw new Error('docs.fixture.core-dist-unavailable');
               return next(specifier, context);
             },
             load(url, context, next) {
               const loaded = next(url, context);
               if (${legacyEdge} && url.endsWith('/command-runtime.ts'))
                 return { ...loaded, source:
                   'import { createCredentialResolutionContext } from "@agentscope/core";\\n'
                   + loaded.source };
               return loaded;
             }
           });
           process.argv[1] = ${JSON.stringify(join(repositoryRoot, "apps/cli/scripts/verify-command-docs.mjs"))};
           await import(process.argv[1]);`,
        ],
        {
          cwd: repositoryRoot,
          env: { ...process.env, FORCE_COLOR: undefined, NO_COLOR: undefined },
          encoding: "utf8",
          timeout: 5_000,
          killSignal: "SIGKILL",
          maxBuffer: 16_384,
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status).toBe(legacyEdge ? 1 : 0);
      if (legacyEdge) {
        expect(result.stderr).toContain("docs.fixture.core-dist-unavailable");
        expect(result.stdout).toBe("");
      } else {
        expect(result.stderr).toBe("");
        expect(result.stdout).toMatch(
          /^Verified CLI command documentation \(sha256:[a-f0-9]{64}\)\n$/u,
        );
      }
    },
  );
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
