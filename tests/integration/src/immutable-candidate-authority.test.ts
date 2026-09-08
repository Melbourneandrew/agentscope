/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return */
import { describe, expect, it } from "vitest";

// The authority is deliberately private integration JavaScript, not a package API.
// @ts-expect-error no declaration file is published for this private module
import * as immutableAuthority from "../immutable-candidate-authority.mjs";

const {
  compileCandidateInventory,
  compileImmutableCandidateHandoff,
  compileInstalledCliPtyReceipt,
  decodeInstalledCliPtyReceipt,
  decodeImmutableCandidateHandoff,
  selectedRuntimeFiles,
  validateImmutableScenarioContainer,
  validateInstalledCliBoundary,
} = immutableAuthority;

const hex = (character: string): string => character.repeat(64);
const candidate = () => ({
  evidenceVersion: 1,
  bundleIdentity: `sha256-${hex("a")}`,
  candidateRevision: "1".repeat(40),
  platform: { os: "linux", architecture: "x64", nodeVersion: "22.23.2" },
  lockfile: {
    fileName: "pnpm-lock.yaml",
    bytes: 3,
    sha256: `sha256-${hex("b")}`,
  },
  artifacts: [
    {
      id: "agentscope-cli",
      kind: "npm-tarball",
      fileName: "agentscope-cli.tgz",
      bytes: 7,
      sha256: `sha256-${hex("c")}`,
    },
  ],
  scenarioNetworkPolicy: "offline-no-package-or-registry-download",
});
const image = () => ({ Id: `sha256:${hex("d")}`, Config: { User: "node" } });
const plan = () => ({ runId: "0123456789abcdef", scenarioId: "codex-smoke" });
const compiled = () =>
  compileImmutableCandidateHandoff({
    candidate: candidate(),
    image: image(),
    plan: plan(),
  });
const expected = () => ({
  candidateBundleIdentity: candidate().bundleIdentity,
  candidateInventorySha256: compileCandidateInventory(candidate()).sha256,
  candidateRoot: "/opt/agentscope/prepared",
  ...plan(),
});
const ptyExpected = () => ({
  candidateBundleIdentity: candidate().bundleIdentity,
  candidateInventorySha256: compileCandidateInventory(candidate()).sha256,
  ...plan(),
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const container = (handoff: ReturnType<typeof compiled>): any => ({
  Image: handoff.imageId,
  Config: {
    User: "1000:1000",
    Env: [`AGENTSCOPE_IMMUTABLE_CANDIDATE_AUTHORITY=${handoff.encoded}`],
  },
  HostConfig: {
    ReadonlyRootfs: true,
    NetworkMode: "selected-network",
    CapDrop: ["ALL"],
    SecurityOpt: ["no-new-privileges"],
    Tmpfs: { "/tmp": "rw,noexec,nosuid,nodev,size=1024" },
  },
  Mounts: [],
});
const ptyReceipt = () => ({
  receiptVersion: 1,
  runId: plan().runId,
  scenarioId: plan().scenarioId,
  candidateBundleIdentity: candidate().bundleIdentity,
  candidateInventorySha256: compileCandidateInventory(candidate()).sha256,
  caseId: "installed-cli-version",
  outcome: "completed",
  semanticState: "completed",
  cleanup: "clean",
  isTTY: true,
  eofByteWritten: true,
  processJoined: true,
  terminalInputJoined: true,
  terminalOutputJoined: true,
  terminalTransportClosed: true,
  residualProcessCount: 0,
  initialGeometry: { columns: 40, rows: 12 },
  outputBytes: 42,
  outputSha256: hex("e"),
});

// eslint-disable-next-line max-lines-per-function
describe("immutable candidate authority", () => {
  const installedCliFacts = () => ({
    argv: ["/opt/agentscope/installed/bin/agentscope", "--version"],
    binIsSymlink: true,
    binTarget: "../node_modules/agentscope-cli/dist/bin/agentscope.js",
    cliDigest: hex("f"),
    cliMode: 0o755,
    cliPrefix: "#!/usr/bin/env node\n",
    expectedDigest: hex("f"),
  });

  it("causally validates the exact installed CLI command boundary", () => {
    expect(validateInstalledCliBoundary(installedCliFacts())).toBe(true);
  });

  it.each([
    ["link", { binTarget: "../substituted.js" }],
    ["type", { binIsSymlink: false }],
    ["mode", { cliMode: 0o644 }],
    ["shebang", { cliPrefix: "#!/bin/sh\n" }],
    ["digest", { cliDigest: hex("e") }],
    ["argv", { argv: ["/opt/agentscope/installed/bin/agentscope", "help"] }],
  ] as const)(
    "rejects installed CLI %s substitution",
    (_seed, substitution) => {
      expect(() =>
        validateInstalledCliBoundary({
          ...installedCliFacts(),
          ...substitution,
        }),
      ).toThrow("integration.immutable-candidate.authority");
    },
  );
  it("binds a canonical candidate inventory and closed handoff", () => {
    const handoff = compiled();
    expect(
      decodeImmutableCandidateHandoff(handoff.encoded, expected()),
    ).toEqual(expect.objectContaining(expected()));
    expect(selectedRuntimeFiles).toEqual(
      expect.arrayContaining([
        "testkit/bounded-terminal-emulator.js",
        "testkit/pty-terminal-contract.js",
        "testkit/pty-runtime/node127-linux-x64-musl/pty.node",
      ]),
    );
  });

  it.each(["missing", "extra", "malformed", "substituted"] as const)(
    "rejects %s handoff authority",
    (seed) => {
      const handoff = compiled();
      let encoded = handoff.encoded;
      if (seed === "missing") encoded = "";
      if (seed === "malformed") encoded = "not_base64+";
      if (seed === "substituted")
        encoded = compileImmutableCandidateHandoff({
          candidate: candidate(),
          image: image(),
          plan: { ...plan(), scenarioId: "other" },
        }).encoded;
      const expectedRecord = expected() as ReturnType<typeof expected> & {
        extra?: boolean;
      };
      if (seed === "extra") expectedRecord.extra = true;
      expect(() =>
        decodeImmutableCandidateHandoff(encoded, expectedRecord),
      ).toThrow("integration.immutable-candidate.authority");
    },
  );

  it("accepts only the exact read-only selected container and image", () => {
    const handoff = compiled();
    expect(
      validateImmutableScenarioContainer({
        container: container(handoff),
        handoff,
        image: image(),
        networkName: "selected-network",
        tmpfs: container(handoff).HostConfig.Tmpfs,
      }),
    ).toBe(true);
  });

  it("rejects duplicate and non-closed candidate inventory entries", () => {
    const duplicate = candidate();
    duplicate.artifacts.push({
      id: duplicate.artifacts[0]!.id,
      kind: duplicate.artifacts[0]!.kind,
      fileName: duplicate.artifacts[0]!.fileName,
      bytes: duplicate.artifacts[0]!.bytes,
      sha256: duplicate.artifacts[0]!.sha256,
    });
    expect(() => compileCandidateInventory(duplicate)).toThrow(
      "integration.immutable-candidate.authority",
    );
    expect(() =>
      compileCandidateInventory({ ...candidate(), extra: true }),
    ).toThrow("integration.immutable-candidate.authority");
  });

  it.each(["duplicate-id", "count", "bytes", "id", "kind"] as const)(
    "rejects production candidate artifact %s substitution",
    (seed) => {
      const value = candidate();
      if (seed === "duplicate-id")
        value.artifacts.push({
          ...value.artifacts[0]!,
          fileName: "other.tgz",
        });
      if (seed === "count")
        value.artifacts = Array.from({ length: 33 }, (_, index) => ({
          ...value.artifacts[0]!,
          id: `artifact-${index}`,
          fileName: `artifact-${index}.tgz`,
        }));
      if (seed === "bytes") value.artifacts[0]!.bytes = 256 * 1024 * 1024 + 1;
      if (seed === "id") value.artifacts[0]!.id = "other";
      if (seed === "kind") value.artifacts[0]!.kind = "runtime-binary";
      expect(() => compileCandidateInventory(value)).toThrow(
        "integration.immutable-candidate.authority",
      );
    },
  );

  it("accepts exactly one closed installed-CLI PTY completion", () => {
    const compiledReceipt = compileInstalledCliPtyReceipt(ptyReceipt());
    const output = `prefix\nAGENTSCOPE_PTY_RECEIPT=${compiledReceipt.encoded}\nsuffix\n`;
    expect(decodeInstalledCliPtyReceipt(output, ptyExpected())).toEqual(
      compiledReceipt.record,
    );
  });

  it.each([
    "missing",
    "duplicate",
    "malformed",
    "substituted",
    "extra",
  ] as const)("rejects %s installed-CLI completion evidence", (seed) => {
    const value = ptyReceipt() as ReturnType<typeof ptyReceipt> & {
      extra?: boolean;
    };
    if (seed === "substituted") value.outputSha256 = hex("f");
    if (seed === "extra") value.extra = true;
    const encoded =
      seed === "malformed"
        ? "not+base64"
        : Buffer.from(JSON.stringify(value)).toString("base64url");
    const line = `AGENTSCOPE_PTY_RECEIPT=${encoded}`;
    const output =
      seed === "missing"
        ? ""
        : seed === "duplicate"
          ? `${line}\n${line}`
          : line;
    const receiptExpected = ptyExpected();
    if (seed === "substituted") receiptExpected.scenarioId = "other";
    expect(() => decodeInstalledCliPtyReceipt(output, receiptExpected)).toThrow(
      "integration.immutable-candidate.authority",
    );
  });

  it.each([
    "image",
    "config",
    "user",
    "root-writable",
    "capability",
    "privilege",
    "mount",
    "handoff",
  ] as const)("rejects selected-container %s substitution", (seed) => {
    const handoff = compiled();
    const selected = structuredClone(container(handoff));
    const selectedImage = structuredClone(image());
    if (seed === "image") selected.Image = `sha256:${hex("e")}`;
    if (seed === "config") selectedImage.Config.User = "root";
    if (seed === "user") selected.Config.User = "0:0";
    if (seed === "root-writable") selected.HostConfig.ReadonlyRootfs = false;
    if (seed === "capability") selected.HostConfig.CapDrop = [];
    if (seed === "privilege") selected.HostConfig.SecurityOpt = [];
    if (seed === "mount") selected.Mounts = [{ Type: "bind" }];
    if (seed === "handoff") selected.Config.Env = [];
    expect(() =>
      validateImmutableScenarioContainer({
        container: selected,
        handoff,
        image: selectedImage,
        networkName: "selected-network",
        tmpfs: selected.HostConfig.Tmpfs,
      }),
    ).toThrow("integration.immutable-candidate.authority");
  });
});
