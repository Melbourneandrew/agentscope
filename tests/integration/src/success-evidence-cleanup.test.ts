import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertPersistedHarnessMaterialPrivacy } from "./harness-material-privacy.js";
import {
  cleanFixtureRoots,
  documents,
  materialFixture,
  release,
  setup,
} from "./__tests__/fixtures/success-evidence-fixture.js";
afterEach(cleanFixtureRoots);

describe("actual success cleanup handoff (synthetic component evidence only)", () => {
  it("retains exact support/five-document bytes, deletes raw state, and preserves the existing consumer", () => {
    const input = setup();
    const supportBytes = fs.readFileSync(
      join(input.artifacts, "harness-support-evidence.json"),
    );
    const before = input.inputs.map((value) =>
      Object.fromEntries(
        Object.keys(documents(value)).map((name) => [
          name,
          fs.readFileSync(
            join(input.artifacts, "runs", value.evidence.runId, name),
          ),
        ]),
      ),
    );
    input.run();
    expect(
      fs.readFileSync(join(input.artifacts, "harness-support-evidence.json")),
    ).toEqual(supportBytes);
    for (const [index, value] of input.inputs.entries()) {
      const retained = Object.fromEntries(
        Object.keys(documents(value)).map((name) => [
          name,
          fs.readFileSync(
            join(input.artifacts, "runs", value.evidence.runId, name),
          ),
        ]),
      );
      expect(retained).toEqual(before[index]);
      expect(
        fs
          .readdirSync(join(input.artifacts, "runs", value.evidence.runId))
          .sort(),
      ).toEqual(Object.keys(documents(value)).sort());
      const family = index === 0 ? "codex" : "claude-code";
      expect(
        release.bindScenarioEvidence(
          Buffer.from(JSON.stringify(value.prepared)),
          supportBytes,
          retained,
          family,
        ).family,
      ).toBe(family);
      retained["model-ledger.json"] = Buffer.from("{}");
      expect(() =>
        release.bindScenarioEvidence(
          Buffer.from(JSON.stringify(value.prepared)),
          supportBytes,
          retained,
          family,
        ),
      ).toThrow();
    }
    expect(() => release.requireActualSemanticAdmission([])).toThrow();
    for (const path of [
      "contexts",
      "candidates/owned",
      "current-selection.json",
      `runs/${"3".repeat(16)}`,
    ])
      expect(
        fs.existsSync(join(input.artifacts, path)) &&
          fs.readdirSync(join(input.artifacts, path)).length > 0,
      ).toBe(false);
    expect(input.output.at(-1)).toBe(
      "Agentscope integration cleanup complete.",
    );
  });
});

describe("actual cleanup rejects shadowed original upload bytes", () => {
  it.each(
    ["support", "evidence", "nested-support", "escaped-support"].flatMap(
      (kind) =>
        ["__proto__", "constructor", "toString"].map((key) => [kind, key]),
    ),
  )("refuses a hidden original %s %s prototype-name key", (kind, key) => {
    const input = setup();
    const first = input.inputs[0];
    if (first === undefined) throw Error("synthetic-input");
    const path = join(
      input.artifacts,
      kind === "evidence"
        ? `runs/${first.evidence.runId}/evidence.json`
        : "harness-support-evidence.json",
    );
    const bytes = fs.readFileSync(path, "utf8");
    const encoded =
      kind === "escaped-support"
        ? JSON.stringify(key).replace("o", "\\u006f")
        : JSON.stringify(key);
    const member = `${encoded}:"PRIVATE_CANARY",`;
    fs.writeFileSync(
      path,
      kind === "nested-support"
        ? bytes.replace('"seed":{', `"seed":{${member}`)
        : bytes.replace("{", `{${member}`),
    );
    expect(input.run).toThrow();
    expect(input.output).not.toContain(
      "Agentscope integration cleanup complete.",
    );
  });
  it.each([
    ["support", "disposition"],
    ["evidence", "runId"],
    ["fixture-lifecycle", "scenarioId"],
    ["model-ledger", "scenarioId"],
    ["destination-ledger", "scenarioId"],
    ["harness-observation", "kind"],
  ])("refuses duplicate original %s keys before upload", (document, key) => {
    const input = setup();
    const first = input.inputs[0];
    if (first === undefined) throw Error("synthetic-input");
    const path = join(
      input.artifacts,
      document === "support"
        ? "harness-support-evidence.json"
        : `runs/${first.evidence.runId}/${document}.json`,
    );
    const bytes = fs.readFileSync(path, "utf8");
    fs.writeFileSync(
      path,
      bytes.replace("{", `{${JSON.stringify(key)}:{"raw":"PRIVATE_CANARY"},`),
    );
    expect(input.run).toThrow();
    expect(input.output).not.toContain(
      "Agentscope integration cleanup complete.",
    );
  });
  it("refuses an escaped duplicate nested support key", () => {
    const input = setup();
    const path = join(input.artifacts, "harness-support-evidence.json");
    const bytes = fs.readFileSync(path, "utf8");
    fs.writeFileSync(
      path,
      bytes.replace(
        '"seed":{',
        '"seed":{"run\\u0049d":{"raw":"PRIVATE_CANARY"},',
      ),
    );
    expect(input.run).toThrow();
    expect(input.output).not.toContain(
      "Agentscope integration cleanup complete.",
    );
  });
  it.each(["modelLedger", "destinationLedger", "harnessObservation"])(
    "refuses a hidden original lifecycle %s field",
    (key) => {
      const input = setup();
      const first = input.inputs[0];
      if (first === undefined) throw Error("synthetic-input");
      input.write(`runs/${first.evidence.runId}/fixture-lifecycle.json`, {
        ...first.lifecycle,
        [key]: { raw: "PRIVATE_CANARY" },
      });
      expect(input.run).toThrow();
      expect(input.output).not.toContain(
        "Agentscope integration cleanup complete.",
      );
    },
  );
});

describe("actual cleanup rejects an unsafe or incomplete success handoff", () => {
  it.each([
    "evidence",
    "support",
    "seed",
    "completion",
    "controller",
    "material",
    "entry",
    "binding",
    "harness",
    "component",
    "preparedImage",
  ])(
    "rejects unreviewed raw fields at %s before retaining upload bytes",
    (kind) => {
      const input = setup();
      const first = input.inputs[0];
      if (first === undefined) throw Error("synthetic-input");
      const evidence = JSON.parse(JSON.stringify(first.evidence)) as Record<
        string,
        unknown
      >;
      const support = JSON.parse(JSON.stringify(input.support)) as {
        entries: { binding: Record<string, Record<string, unknown>> }[];
      } & Record<string, unknown>;
      if (kind === "evidence") evidence.unreviewedRaw = "PRIVATE_CANARY";
      else if (kind === "material")
        evidence.preparedHarnessMaterial = { unreviewedRaw: "PRIVATE_CANARY" };
      else if (kind === "support") support.unreviewedRaw = "PRIVATE_CANARY";
      else {
        const entry = support.entries[0];
        if (entry === undefined) throw Error("synthetic-entry");
        const target =
          kind === "entry"
            ? entry
            : kind === "binding"
              ? entry.binding
              : ["harness", "component", "preparedImage"].includes(kind)
                ? entry.binding.seed![kind]
                : entry.binding[kind];
        if (typeof target !== "object" || target === null)
          throw Error("synthetic-member");
        (target as Record<string, unknown>).unreviewedRaw = "PRIVATE_CANARY";
      }
      input.write(`runs/${first.evidence.runId}/evidence.json`, evidence);
      input.write("harness-support-evidence.json", support);
      expect(input.run).toThrow();
      expect(input.output).not.toContain(
        "Agentscope integration cleanup complete.",
      );
    },
  );
  it.each([
    "missing",
    "symlink",
    "hardlink",
    "oversized",
    "incomplete",
    "foreign-run",
    "unsafe-mode",
  ])("refuses %s without a successful handoff", (kind) => {
    const input = setup();
    const first = input.inputs[0];
    if (first === undefined) throw Error("synthetic-input");
    const path = join(
      input.artifacts,
      "runs",
      first.evidence.runId,
      "model-ledger.json",
    );
    if (kind === "missing") fs.unlinkSync(path);
    if (kind === "symlink") {
      fs.unlinkSync(path);
      fs.symlinkSync(join(input.artifacts, "current-selection.json"), path);
    }
    if (kind === "hardlink") fs.linkSync(path, join(input.root, "alias"));
    if (kind === "unsafe-mode") fs.chmodSync(path, 0o646);
    if (kind === "oversized") fs.writeFileSync(path, Buffer.alloc(1_048_577));
    if (kind === "incomplete") {
      first.evidence.cleanup.outcome = "failed";
      input.write(`runs/${first.evidence.runId}/evidence.json`, first.evidence);
    }
    if (kind === "foreign-run") {
      const entry = input.support.entries[0];
      if (entry === undefined) throw Error("synthetic-entry");
      entry.binding.seed.runId = "f".repeat(16);
      input.write("harness-support-evidence.json", input.support);
    }
    expect(input.run).toThrow();
    expect(input.output).not.toContain(
      "Agentscope integration cleanup complete.",
    );
  });
  it("retains no success handoff when exact resource cleanup fails", () => {
    const input = setup();
    input.refuseDocker();
    expect(input.run).toThrow("synthetic-docker-refusal");
    expect(input.output).not.toContain(
      "Agentscope integration cleanup complete.",
    );
  });
  it.each(["required-failure", "private-residue"])(
    "prevents successful handoff with %s",
    (kind) => {
      const input = setup();
      if (kind === "required-failure") {
        const first = input.inputs[0];
        if (first === undefined) throw Error("synthetic-input");
        input.owned.requiredFailureEvidence.push(first.evidence.runId);
      } else fs.mkdirSync(join(input.root, "private", "unexpected"));
      expect(input.run).toThrow();
      expect(input.output).not.toContain(
        "Agentscope integration cleanup complete.",
      );
    },
  );
});

describe("closed material projection and bounded wrong-file cleanup", () => {
  it.each([false, true])(
    "accepts compiler-produced signed=%s material and rejects nested raw/accessor/proxy data",
    (signed) => {
      const value = materialFixture(signed);
      expect(() => {
        assertPersistedHarnessMaterialPrivacy(value);
      }).not.toThrow();
      for (const key of signed
        ? ["verifier", "binary", "signingKey"]
        : ["verifier", "packages"]) {
        const altered = structuredClone(value);
        const target =
          key === "packages"
            ? (altered.packages as Record<string, unknown>[])[0]
            : (altered[key] as Record<string, unknown>);
        if (target === undefined) throw Error("synthetic-material-member");
        target.unreviewedRaw = "PRIVATE_CANARY";
        expect(() => {
          assertPersistedHarnessMaterialPrivacy(altered);
        }).toThrow();
      }
      let reads = 0;
      const hostile = { ...value };
      Object.defineProperty(hostile, "verifier", {
        get() {
          reads++;
          throw Error("PRIVATE_CANARY");
        },
      });
      expect(() => {
        assertPersistedHarnessMaterialPrivacy(hostile);
      }).toThrow();
      expect(() => {
        assertPersistedHarnessMaterialPrivacy(
          new Proxy(value, {
            ownKeys() {
              reads++;
              throw Error("PRIVATE_CANARY");
            },
          }),
        );
      }).toThrow();
      expect(reads).toBe(0);
    },
  );
  it.each(["fifo", "replace-during-open"])(
    "rejects an owned0600 %s support without blocking the child",
    (kind) => {
      const input = setup();
      const path = join(input.artifacts, "harness-support-evidence.json");
      if (kind === "fifo") {
        fs.unlinkSync(path);
        execFileSync("/usr/bin/mkfifo", ["-m", "600", path]);
      }
      const source = fs
        .readFileSync(new URL("../clean.mjs", import.meta.url), "utf8")
        .replace(/^import[\s\S]*?from "[^"]+";$/gmu, "")
        .replace(
          "import.meta.dirname",
          JSON.stringify(join(input.root, "tests/integration")),
        );
      const child = `import * as fs from 'node:fs'; import {execFileSync as createFifo} from 'node:child_process'; import {resolve,sep} from 'node:path'; import {runInNewContext} from 'node:vm'; import {createHash} from 'node:crypto';
      const root=${JSON.stringify(input.root)}, status=fs.lstatSync(resolve(root,'private'));
      try {runInNewContext(${JSON.stringify(source)}, {...fs, Buffer, JSON, resolve,sep,createHash, process,
        openSync:(path,flags)=>{if(${JSON.stringify(kind === "replace-during-open")} && path===${JSON.stringify(path)}){fs.unlinkSync(path);createFifo('/usr/bin/mkfifo',['-m','600',path]);}return fs.openSync(path,flags);},
        ownedIntegrationResources:()=>(${JSON.stringify(input.owned)}), failureEvidenceCoverageIsExact:()=>true,
        requireDisposableOuterHostCapability:()=>({binding:{privateStorage:{root:resolve(root,'private'),rootDev:status.dev,rootIno:status.ino,rootUid:status.uid,rootGid:status.gid,rootMode:status.mode&4095}}}),
        remainingIntegrationOperationMilliseconds:()=>1000, IMAGE_PREPARATION_LIMITS:{maximumEvidenceBytes:1048576},execFileSync:()=>'', console:{log:()=>{}},
        parsePersistedHarnessSupportEvidence:()=>{throw Error('unexpected-parser')},compileIsolationEvidence:()=>{throw Error('unexpected-parser')},assertPersistedHarnessMaterialPrivacy:()=>{throw Error('unexpected-parser')},sanitizeFixtureResult:()=>{throw Error('unexpected-parser')}});
        process.exitCode=2; } catch(error) {process.exitCode=error.message==='integration.cleanup.success-evidence'?0:3;}`;
      const result = spawnSync(
        process.execPath,
        ["--input-type=module", "-e", child],
        { timeout: 1500, maxBuffer: 16384, encoding: "utf8" },
      );
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
    },
  );
});
