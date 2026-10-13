import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { runInNewContext } from "node:vm";
import { transpileModule } from "typescript";
import { deriveIdentityBundle } from "@agentscope/protocol";
import { sanitizeFixtureResult } from "../../operations.js";
import { failureEvidenceCoverageIsExact } from "../../controller.js";
import {
  compileIsolationEvidence,
  compileIsolationExecutionPolicy,
  ISOLATION_EXECUTOR_LIMITS,
} from "../../isolation.js";
import { parsePersistedHarnessSupportEvidence } from "../../harness-admission.js";
import {
  compileVerifiedNpmHarnessMaterial,
  compileVerifiedSignedManifestHarnessMaterial,
} from "../../harness-material.js";
import { assertPersistedHarnessMaterialPrivacy } from "../../harness-material-privacy.js";
import * as integrationCanonical from "../../canonical.js";
// @ts-expect-error existing repository release consumer has no declaration
import * as consumer from "../../../../../scripts/release-lane/admission.mjs";
// @ts-expect-error existing repository canonical helpers have no declaration
import * as canonical from "../../../../../scripts/release-lane/validation.mjs";

const roots: string[] = [];
export const cleanFixtureRoots = () => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
};
type Fixture = {
  prepared: unknown;
  support: { entries: { binding: { seed: { runId: string } } }[] };
  evidence: {
    runId: string;
    scenarioId: string;
    outcome: string;
    cleanup: { outcome: string };
  };
  lifecycle: { artifactFileName: string };
  model: unknown;
  destination: unknown;
  observation: unknown;
};
const helpers = canonical as {
  canonicalJson: (value: unknown) => string;
  sha256: (value: string) => string;
};
export const release = consumer as {
  bindScenarioEvidence: (
    prepared: Buffer,
    support: Buffer,
    files: Record<string, Buffer>,
    family: string,
  ) => { family: string };
  requireActualSemanticAdmission: (values: unknown) => unknown;
};
export const documents = (input: Fixture) => ({
  "evidence.json": input.evidence,
  "fixture-lifecycle.json": input.lifecycle,
  "model-ledger.json": input.model,
  "destination-ledger.json": input.destination,
  "harness-observation.json": input.observation,
});
const componentFixture = (family: "codex" | "claude-code") => {
  const source = fs.readFileSync(
    new URL(
      "../../../../../scripts/__tests__/release-admission.test.mjs",
      import.meta.url,
    ),
    "utf8",
  );
  const begin = source.indexOf("function fixture() {"),
    end = source.indexOf("const bindCodex =", begin);
  const claude = source.indexOf("function claudeFixture() {"),
    claudeEnd = source.indexOf("const bindClaude =", claude);
  if ([begin, end, claude, claudeEnd].some((value) => value < 0))
    throw Error("synthetic-consumer-source-boundary");
  const factory = runInNewContext(
    `${source.slice(begin, end)}\n${source.slice(claude, claudeEnd)}\n({codexFixture,claudeFixture,codexSupportFixture});`,
    {
      Buffer,
      createHash,
      ...helpers,
      deriveIdentityBundle: (
        input: Parameters<typeof deriveIdentityBundle>[0],
      ) =>
        deriveIdentityBundle(
          JSON.parse(JSON.stringify(input)) as Parameters<
            typeof deriveIdentityBundle
          >[0],
        ),
    },
    { timeout: 1_000 },
  ) as {
    codexFixture: () => unknown;
    claudeFixture: () => unknown;
    codexSupportFixture: (input: unknown, family: string) => unknown;
  };
  const value = JSON.parse(
    JSON.stringify(
      family === "codex" ? factory.codexFixture() : factory.claudeFixture(),
    ),
  ) as Fixture;
  Object.assign(value.evidence, {
    preparedHarnessMaterial: materialFixture(false, family),
  });
  completeProducerFixture(value, family);
  // The existing consumer preimage uses a placeholder lifecycle filename;
  // use the current producer's ordinary sanitized fixture envelope here.
  value.lifecycle.artifactFileName = "agentscope-cli.tgz";
  value.support = JSON.parse(
    JSON.stringify(factory.codexSupportFixture(value, family)),
  ) as Fixture["support"];
  const support = value.support as unknown as {
    entries: {
      binding: { seed: unknown; controller: Record<string, unknown> };
      [key: string]: unknown;
    }[];
  };
  const entry = support.entries[0];
  if (entry === undefined) throw Error("synthetic-entry");
  const sourceSeed = fs.readFileSync(
    new URL("../../harness-admission.test.ts", import.meta.url),
    "utf8",
  );
  const seedFactory = runInNewContext(
    transpileModule(
      `${sourceSeed.slice(sourceSeed.indexOf("const digest ="), sourceSeed.indexOf("const completion ="))}\nvalidSeed;`,
      {},
    ).outputText,
    integrationCanonical,
  ) as (value: unknown) => {
    harness: Record<string, unknown>;
    component: unknown;
    catalogRowIdentity: string;
  };
  const baseline = seedFactory({});
  const seed = seedFactory({
    ...(entry.binding.seed as object),
    harness: {
      ...baseline.harness,
      registryIdentity: `@agentscope/harness-${family}`,
      artifactDigest: (
        value.evidence as unknown as {
          preparedHarnessMaterial: { materialIdentity: string };
        }
      ).preparedHarnessMaterial.materialIdentity,
    },
    preparedImage: {
      ...(baseline as unknown as { preparedImage: object }).preparedImage,
      scenarioImageDigest: (
        value.evidence as unknown as { builtImageDigest: string }
      ).builtImageDigest,
    },
  });
  entry.binding.seed = seed;
  entry.binding.controller.authorityIdentity = `sha256:${"a".repeat(64)}`;
  Object.assign(entry, {
    evidenceSlot: seed.harness.evidenceSlot,
    testedVersion: seed.harness.exactVersion,
    catalogRowIdentity: seed.catalogRowIdentity,
    contractSuiteDigest: integrationCanonical.sha256(
      integrationCanonical.canonicalJson(seed.component),
    ),
    realScenarioDigest: integrationCanonical.sha256(
      integrationCanonical.canonicalJson(entry.binding),
    ),
  });
  return value;
};
const completeProducerFixture = (value: Fixture, family: string) => {
  const source = fs.readFileSync(
    new URL("../../isolation.test.ts", import.meta.url),
    "utf8",
  );
  const sections = [
    source.slice(
      source.indexOf("const executionPolicyFor ="),
      source.indexOf("const terminalContainer ="),
    ),
    source.slice(
      source.indexOf("const emptyCleanupInventory ="),
      source.indexOf("const ptyChallengeReceiptFor ="),
    ),
    source.slice(
      source.indexOf("const compiledEvidenceFixture ="),
      source.indexOf("const compileWithPreparedAuthority ="),
    ),
  ];
  const factory = runInNewContext(
    transpileModule(
      `${sections.join("\n")}\n({compiledEvidenceFixture,ptyReceiptFor,executionPolicyFor});`,
      {},
    ).outputText,
    {
      Buffer,
      createHash,
      readFileSync: fs.readFileSync,
      resolve,
      integrationRoot: resolve(import.meta.dirname, "../../.."),
      manifest: {
        manifestIdentity: (
          value.evidence as unknown as { manifestIdentity: string }
        ).manifestIdentity,
      },
      compileIsolationExecutionPolicy,
      ISOLATION_EXECUTOR_LIMITS,
      preparedIdentityFor: (image: string, fill: string) => ({
        image,
        platform: { os: "linux", architecture: "amd64" },
        manifestDigest: `sha256:${fill.repeat(64)}`,
        configDigest: `sha256:${fill.repeat(64)}`,
      }),
    },
  ) as {
    compiledEvidenceFixture: () => { evidence: Record<string, unknown> };
    ptyReceiptFor: (run: string, scenario: string) => unknown;
    executionPolicyFor: (scenario: string) => unknown;
  };
  value.evidence = {
    ...factory.compiledEvidenceFixture().evidence,
    ...value.evidence,
    terminalAction: "eof",
    executionPolicy: factory.executionPolicyFor(value.evidence.scenarioId),
    builtImageDigest: `sha256-${(family === "codex" ? "a" : "b").repeat(64)}`,
    baseImageIdentity:
      factory.compiledEvidenceFixture().evidence.baseImageIdentity,
    mockServerImageIdentity:
      factory.compiledEvidenceFixture().evidence.mockServerImageIdentity,
    ptyTerminalReceipt: factory.ptyReceiptFor(
      value.evidence.runId,
      value.evidence.scenarioId,
    ),
  } as Fixture["evidence"];
};
export const materialFixture = (signed: boolean, family = "codex") => {
  const path = signed
    ? new URL("../../harness-material.test.ts", import.meta.url)
    : new URL(
        "../../../../../scripts/__tests__/release-admission.test.mjs",
        import.meta.url,
      );
  const source = fs.readFileSync(path, "utf8");
  const begin = source.indexOf(
    signed
      ? '  const binary = Buffer.from("exact signed harness binary")'
      : "function compiledNpmFixture(family)",
  );
  const end = source.indexOf(
    signed ? "  it(" : "function sourceMaterialFixture",
    begin,
  );
  const expression = signed
    ? "compileSigned();"
    : `compiledNpmFixture(${JSON.stringify(family)}).record;`;
  if (begin < 0 || end < 0) throw Error("synthetic-material-source-boundary");
  return JSON.parse(
    JSON.stringify(
      runInNewContext(
        transpileModule(`${source.slice(begin, end)}\n${expression}`, {})
          .outputText,
        {
          Buffer,
          Map,
          createHash,
          canonicalJson: integrationCanonical.canonicalJson,
          compileVerifiedNpmHarnessMaterial,
          compileVerifiedSignedManifestHarnessMaterial,
        },
      ),
    ),
  ) as Record<string, unknown>;
};
export const setup = () => {
  const root = fs.mkdtempSync(join(tmpdir(), "agentscope-success-cleanup-"));
  roots.push(root);
  const artifacts = join(root, "artifacts/integration");
  const integration = join(root, "tests/integration");
  const privateRoot = join(root, "private");
  for (const path of [artifacts, integration, privateRoot])
    fs.mkdirSync(path, { recursive: true, mode: 0o700 });
  const status = fs.lstatSync(privateRoot);
  const inputs = [componentFixture("codex"), componentFixture("claude-code")];
  const generic = "3".repeat(16);
  const entries = inputs.flatMap((input) => input.support.entries);
  const material = {
    manifestVersion: 1,
    disposition: "real-scenario-evidence-awaiting-release-gate",
    entries,
  };
  const support = {
    ...material,
    manifestIdentity: helpers
      .sha256(helpers.canonicalJson(material))
      .replace("sha256:", "sha256-"),
  };
  const write = (relative: string, value: unknown) => {
    const path = join(artifacts, relative);
    fs.mkdirSync(resolve(path, ".."), { recursive: true });
    fs.writeFileSync(path, `${JSON.stringify(value)}\n`, {
      mode: relative === "harness-support-evidence.json" ? 0o600 : 0o644,
    });
    return path;
  };
  write("harness-support-evidence.json", support);
  write("current-selection.json", {});
  for (const input of inputs) {
    for (const [name, value] of Object.entries(documents(input)))
      write(`runs/${input.evidence.runId}/${name}`, value);
    write(`runs/${input.evidence.runId}/raw-private.json`, {
      raw: "PRIVATE_CANARY",
    });
    write(`contexts/${input.evidence.runId}/private.json`, {
      raw: "PRIVATE_CANARY",
    });
  }
  write(`runs/${generic}/raw.json`, { raw: "PRIVATE_CANARY" });
  write("candidates/owned/private.json", { raw: "PRIVATE_CANARY" });
  const owned = {
    artifactFiles: ["harness-support-evidence.json", "current-selection.json"],
    candidateIdentities: ["owned"],
    runIds: [...inputs.map((input) => input.evidence.runId), generic],
    requiredFailureEvidence: [] as string[],
    failureEvidence: [],
    privateStorageRetirements: [],
  };
  const output: unknown[] = [];
  let dockerFailure = false;
  const run = () => {
    const source = fs.readFileSync(
      new URL("../../../clean.mjs", import.meta.url),
      "utf8",
    );
    runInNewContext(
      source
        .replace(/^import[\s\S]*?from "[^"]+";$/gmu, "")
        .replace("import.meta.dirname", JSON.stringify(integration)),
      {
        ...fs,
        Buffer,
        JSON,
        createHash,
        resolve,
        sep,
        process,
        sanitizeFixtureResult,
        compileIsolationEvidence,
        parsePersistedHarnessSupportEvidence,
        assertPersistedHarnessMaterialPrivacy,
        requireDisposableOuterHostCapability: () => ({
          binding: {
            dockerExecutable: "/inert",
            dockerEnvironment: {},
            privateStorage: {
              root: privateRoot,
              rootDev: status.dev,
              rootIno: status.ino,
              rootUid: status.uid,
              rootGid: status.gid,
              rootMode: status.mode & 0o7777,
            },
          },
        }),
        ownedIntegrationResources: () => owned,
        remainingIntegrationOperationMilliseconds: () => 1000,
        failureEvidenceCoverageIsExact,
        IMAGE_PREPARATION_LIMITS: { maximumEvidenceBytes: 1024 * 1024 },
        validInstalledPtyFailure: () => true,
        validCodexResearchDiagnostic: () => true,
        certificationFailureAuthorityIsValid: () => true,
        execFileSync: () => {
          if (dockerFailure) throw Error("synthetic-docker-refusal");
          return "";
        },
        console: { log: (value: unknown) => output.push(value) },
      },
      { timeout: 1000 },
    );
  };
  return {
    root,
    artifacts,
    inputs,
    owned,
    output,
    support,
    write,
    run,
    refuseDocker: () => {
      dockerFailure = true;
    },
  };
};
