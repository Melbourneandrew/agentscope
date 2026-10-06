import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import { describe, expect, it } from "vitest";
import { isAbsolute, resolve } from "node:path";
import ts from "typescript";

const driver = readFileSync(
  new URL("../native-directory/build-candidate.mjs", import.meta.url),
  "utf8",
);
const primitive = readFileSync(
  new URL("../native-directory/primitive.c", import.meta.url),
  "utf8",
);
const proof = readFileSync(
  new URL("../native-directory/component-proof.mjs", import.meta.url),
  "utf8",
);
const workflow = readFileSync(
  new URL(
    "../../../../.github/workflows/directory-native-candidate.yml",
    import.meta.url,
  ),
  "utf8",
);
const first = driver.indexOf("export const candidateProfile =");
const end = driver.indexOf("const within =", first);
if (first < 0 || end <= first)
  throw new Error("actual candidate source boundary unavailable");
const actual = new Script(
  `${driver.slice(first, end).replaceAll("export const", "const")}\n` +
    "({ candidateProfile, compilerArguments })",
).runInNewContext({
  source: "/work/primitive.c",
  xcode: "/Applications/Xcode_16.2.app",
  isAbsolute,
  resolve,
  fail: () => {
    throw new Error("harness.directory.candidate-invalid");
  },
}) as Record<string, unknown>;
const invoke = (name: string, args: readonly unknown[]): unknown => {
  const fn = actual[name];
  if (typeof fn !== "function")
    throw new Error("actual source function missing");
  return Reflect.apply(fn, undefined, [...args]) as unknown;
};

describe("nonpublishing directory native candidate", () => {
  it("uses the existing Linux user baseline and deliberate Node22 Darwin baseline", () => {
    expect(invoke("candidateProfile", ["linux-x64"])).toMatchObject({
      platform: "linux",
      architecture: "x64",
      minimumOsVersion: "5.15",
      libcFamily: "glibc",
      minimumLibcVersion: "2.34",
      admittedNodeMajors: [22],
    });
    expect(invoke("candidateProfile", ["darwin-arm64"])).toMatchObject({
      platform: "darwin",
      architecture: "arm64",
      minimumOsVersion: "11.0",
      libcFamily: null,
      minimumLibcVersion: null,
      admittedNodeMajors: [22],
    });
  });
  it.each(["linux-arm64", "darwin-x64", "windows-x64", "latest", "", null])(
    "does not invent a %s platform row",
    (row) => {
      expect(() => invoke("candidateProfile", [row])).toThrow(
        "candidate-invalid",
      );
    },
  );
  it("constructs the exact direct C compiler argv without shell/package hooks", () => {
    expect(
      invoke("compilerArguments", [
        "linux-x64",
        null,
        "/work/headers",
        "/work/output.node",
      ]),
    ).toEqual([
      "-std=c11",
      "-O2",
      "-fPIC",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-I",
      "/work/headers",
      "-shared",
      "/work/primitive.c",
      "-o",
      "/work/output.node",
    ]);
    expect(
      invoke("compilerArguments", [
        "darwin-arm64",
        "/Applications/Xcode_16.2.app/Contents/Developer/SDK",
        "/work/headers",
        "/work/output.node",
      ]),
    ).toEqual([
      "-std=c11",
      "-O2",
      "-fPIC",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-I",
      "/work/headers",
      "-arch",
      "arm64",
      "-isysroot",
      "/Applications/Xcode_16.2.app/Contents/Developer/SDK",
      "-mmacosx-version-min=11.0",
      "-bundle",
      "-undefined",
      "dynamic_lookup",
      "/work/primitive.c",
      "-o",
      "/work/output.node",
    ]);
  });
  it.each([
    ["linux-x64", "/ambient/sdk", "/work/headers", "/work/output.node"],
    ["darwin-arm64", "/ambient/sdk", "/work/headers", "/work/output.node"],
    [
      "darwin-arm64",
      "/Applications/Xcode_16.2.app/Contents/Developer/../escape",
      "/work/headers",
      "/work/output.node",
    ],
    ["linux-x64", null, "relative", "/work/output.node"],
    ["linux-x64", null, "/work/headers", "/work/../escape"],
  ])("rejects substituted/noncanonical compiler inputs", (...args) => {
    expect(() => invoke("compilerArguments", args)).toThrow(
      "candidate-invalid",
    );
  });
});

describe("candidate material and workflow boundaries", () => {
  it("conforms to the actual terminal-stream policy and rejects the prior optional write", () => {
    const policy = readFileSync(
      new URL(
        "../../../../scripts/restricted-import-policy.mjs",
        import.meta.url,
      ),
      "utf8",
    );
    const constants = policy.slice(
      policy.indexOf("const restrictedSpecifiers ="),
      policy.indexOf("const sourceFiles ="),
    );
    const body = policy.slice(
      policy.indexOf("const assertNoIntegrationStreams ="),
      policy.indexOf("export const auditCoreFinalizationImports"),
    );
    const literal = policy.slice(
      policy.indexOf("const isLiteralModuleSpecifier ="),
      policy.indexOf("const assertLiteralSpecifierAllowed ="),
    );
    const check = new Script(
      `${constants}\n${literal}\n${body}\nassertNoIntegrationStreams;`,
    ).runInNewContext({ ts }) as (
      source: string,
      file: string,
      name: string,
    ) => void;
    const path = "packages/harnesses/core/native-directory/build-candidate.mjs";
    expect(() => {
      check(driver, path, "@agentscope/harnesses-core");
    }).not.toThrow();
    expect(() => {
      check(
        `${driver}\nprocess.stdout.write("synthetic");`,
        path,
        "@agentscope/harnesses-core",
      );
    }).toThrow("terminal streams are CLI-owned");
  });
  it("pins the all-and-only external action closure to reviewed immutable revisions", () => {
    const actions = [...workflow.matchAll(/uses: (\S+)/gu)].map(
      (match) => match[1],
    );
    expect(actions).toEqual([
      "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
      "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
      "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
      "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
      "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
      "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093",
      "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
    ]);
    for (const action of actions) expect(action).toMatch(/@[a-f0-9]{40}$/u);
    const oldActions = [
      ...workflow
        .replaceAll(/@[a-f0-9]{40}/gu, "@v4")
        .matchAll(/uses: (\S+)/gu),
    ].map((match) => match[1]);
    expect(
      oldActions.every((action) => /@[a-f0-9]{40}$/u.test(action ?? "")),
    ).toBe(false);
  });
  it("uses one original candidate deadline and authenticates Apple seal before SDK reads", () => {
    expect(driver.match(/entry \+ 300_000/gu)).toHaveLength(1);
    expect(driver).toContain("deadline - performance.now()");
    const start = driver.indexOf("const darwinMaterials =");
    const seal = driver.indexOf('run("/usr/bin/codesign",', start);
    const compiler = driver.indexOf("const compiler = realpathSync", start);
    expect(seal).toBeGreaterThan(start);
    expect(compiler).toBeGreaterThan(seal);
    expect(driver).toMatch(
      /"--verify",\s*"--deep",\s*"--strict",\s*"-R",\s*"anchor apple"/u,
    );
    expect(driver).toContain("sealedSdkInputs(run, inputs, outputRoot)");
  });
  it("retains only unadmitted candidate artifacts in a read-only workflow", () => {
    expect(workflow).toContain("contents: read");
    expect(workflow).toContain(
      "artifact-ids: ${{ needs.linux-x64.outputs.header-artifact-id }}",
    );
    expect(workflow).toContain("needs: [linux-x64, darwin-arm64]");
    expect(workflow).toContain(
      "bb6834c0669aa71cbc8d94606561a721adf489f6b93d7b8b825f0cf1b498c2c4",
    );
    expect(workflow).not.toMatch(
      /npm publish|id-token: write|pull_request_target|sudo/u,
    );
    expect(driver).toContain('disposition: "unadmitted-candidate"');
    expect(driver).toContain("assertToolchainImageAuthority(proof)");
  });
  it("keeps the conventional primitive fd-only and closes its stream before projection", () => {
    expect(primitive).toContain("#define NAPI_VERSION 8");
    expect(primitive).toContain("#define MAX_NAMES 1024");
    expect(primitive).toContain("#define MAX_BYTES 1048576");
    expect(primitive).toContain("F_DUPFD_CLOEXEC");
    expect(primitive).toContain("fdopendir(duplicate)");
    expect(primitive.indexOf("closedir(stream)")).toBeLessThan(
      primitive.lastIndexOf("project(env,"),
    );
    expect(primitive).not.toMatch(/\bopendir\(|system\(|execve\(|sysctl/u);
    expect(proof).toContain("primitive.observeDirectory(held)");
    expect(proof).toContain(
      "primitive.observeDirectory(countFd).entries.length, 1024",
    );
    expect(driver).toContain(
      'import { componentProof } from "./component-proof.mjs"',
    );
    expect(driver).toContain("staticFacts,");
  });
});
