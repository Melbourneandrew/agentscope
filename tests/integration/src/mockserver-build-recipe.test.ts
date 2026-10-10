import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  createSupplierGoalObservation,
  mockServerSupplierBuildPlan,
  mockServerSupplierLayout,
  supplierGlobalMavenSettings,
  supplierMavenSettings,
} from "../mockserver-material/build-recipe.mjs";

describe("fixed conventional MockServer supplier recipe", () => {
  it("retains the upstream reactor and automatic UI source layout", () => {
    const layout = mockServerSupplierLayout;
    expect(layout.reactor).toBe("/supplier/source/mockserver");
    expect(layout.frontend).toBe("/supplier/source/mockserver-ui");
    expect(layout.frontendNode).toBe(
      "/supplier/source/mockserver/mockserver-netty/target/frontend/node/node",
    );
    expect(layout.frontendNpm).toBe(
      "/supplier/source/mockserver/mockserver-netty/target/frontend/node/node_modules/npm/bin/npm-cli.js",
    );
    expect(layout.artifact).toBe(
      "/supplier/source/mockserver/mockserver-netty/target/mockserver-netty-7.6.0-jar-with-dependencies.jar",
    );
    expect(Object.isFrozen(layout)).toBe(true);
  });

  it("uses one fixed ordinary package lifecycle without disabling UI or plugins", () => {
    const plan = mockServerSupplierBuildPlan("dependency-research");
    expect(plan.executable).toBe("/supplier/tools/apache-maven-3.9.16/bin/mvn");
    expect(plan.arguments).toEqual([
      "--batch-mode",
      "--no-transfer-progress",
      "--strict-checksums",
      "--settings",
      "/supplier/settings.xml",
      "--global-settings",
      "/supplier/global-settings.xml",
      "-Dmaven.repo.local=/supplier/maven-repository",
      "--projects",
      "mockserver-netty",
      "--also-make",
      "-DskipTests",
      "package",
    ]);
    expect(plan.cwd).toBe(mockServerSupplierLayout.reactor);
    expect(plan.runNetwork).toBe("default");
    expect(plan.evidenceScope).toBe("dependency-research-plan");
  });

  it("uses the same lifecycle offline with both Maven and npm network denied", () => {
    const online = mockServerSupplierBuildPlan("dependency-research");
    const offline = mockServerSupplierBuildPlan("offline-build");
    expect(offline.arguments).toEqual(["--offline", ...online.arguments]);
    expect(offline.runNetwork).toBe("none");
    expect(offline.environment.NPM_CONFIG_OFFLINE).toBe("true");
    expect(online.environment.NPM_CONFIG_OFFLINE).toBe("false");
    expect(offline.environment).toEqual({
      ...online.environment,
      NPM_CONFIG_OFFLINE: "true",
    });
  });

  it("closes user/global Maven configuration and all transitive repositories", () => {
    expect(supplierMavenSettings).toContain("<mirrorOf>*</mirrorOf>");
    expect(supplierMavenSettings).toContain(
      "<url>https://repo.maven.apache.org/maven2/</url>",
    );
    expect(supplierGlobalMavenSettings).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n<settings xmlns="http://maven.apache.org/SETTINGS/1.2.0"/>\n',
    );
    for (const settings of [supplierMavenSettings, supplierGlobalMavenSettings])
      expect(settings).not.toMatch(/<(?:servers|proxies|profiles)>/u);
  });

  it("uses a closed credential-free environment without inherited config", () => {
    const plan = mockServerSupplierBuildPlan("dependency-research");
    expect(Object.keys(plan.environment).sort()).toEqual([
      "HOME",
      "JAVA_HOME",
      "LANG",
      "MAVEN_USER_HOME",
      "NPM_CONFIG_AUDIT",
      "NPM_CONFIG_CACHE",
      "NPM_CONFIG_FUND",
      "NPM_CONFIG_GLOBALCONFIG",
      "NPM_CONFIG_OFFLINE",
      "NPM_CONFIG_REGISTRY",
      "NPM_CONFIG_UPDATE_NOTIFIER",
      "NPM_CONFIG_USERCONFIG",
      "PATH",
    ]);
    expect(plan.environment.JAVA_HOME).toBe("/supplier/tools/jdk-17.0.20.1+1");
    expect(plan.environment.NPM_CONFIG_REGISTRY).toBe(
      "https://registry.npmjs.org/",
    );
    expect(plan.environment.NPM_CONFIG_IGNORE_SCRIPTS).toBeUndefined();
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.arguments)).toBe(true);
    expect(Object.isFrozen(plan.environment)).toBe(true);
  });

  it.each([undefined, null, "", "build", "latest", {}, new Proxy({}, {})])(
    "rejects nonclosed phase %# without coercion or caller effects",
    (input) => {
      expect(() => mockServerSupplierBuildPlan(input as never)).toThrow(
        "integration.mockserver-material.build-recipe",
      );
    },
  );
});

describe("fixed pending Maven INFO goal decoder", () => {
  const header =
    "[INFO] --- compiler:3.15.0:compile (default-compile) @ mockserver-core ---\n";
  it("observes actual default promisified execFile UTF8 string chunks", async () => {
    const observe = createSupplierGoalObservation();
    const pending = promisify(execFile)(
      process.execPath,
      ["-e", `process.stdout.write(${JSON.stringify(header)});`],
      { timeout: 1_000, maxBuffer: 4_096 },
    );
    const chunks: unknown[] = [];
    const stages: unknown[] = [];
    pending.child.stdout?.on("data", (chunk: unknown) => {
      chunks.push(typeof chunk);
      stages.push(observe(0, chunk as string));
    });
    await pending;
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((kind) => kind === "string")).toBe(true);
    expect(stages.filter((stage) => stage !== undefined)).toEqual([
      "supplier-package-goal-a",
    ]);
  });
  it("bounds UTF8 bytes without coercing boxed, malformed or oversized text", () => {
    for (const text of [
      "PRIVATE_CANARY\n",
      `prefix ${header}`,
      "X".repeat(16_385) + header,
    ])
      expect(createSupplierGoalObservation()(0, text)).toBeUndefined();
    const observe = createSupplierGoalObservation();
    expect(observe(0, "é".repeat(4 * 1024 * 1024 + 1))).toBeUndefined();
    expect(observe(0, header)).toBeUndefined();
    const combined = createSupplierGoalObservation();
    const text = "é".repeat(2 * 1024 * 1024);
    expect(Buffer.byteLength(text, "utf8")).toBe(4 * 1024 * 1024);
    expect(combined(0, text)).toBeUndefined();
    expect(combined(1, text)).toBeUndefined();
    expect(combined(0, header)).toBeUndefined();
    expect(
      createSupplierGoalObservation()(0, new String(header) as never),
    ).toBeUndefined();
    expect(createSupplierGoalObservation()(2 as never, header)).toBeUndefined();
  });
  it("bounds split headers, channels, unknown input and overflow without raw output", () => {
    for (let split = 0; split < header.length; split++) {
      const observe = createSupplierGoalObservation();
      expect(observe(0, Buffer.from(header.slice(0, split)))).toBeUndefined();
      expect(observe(0, Buffer.from(header.slice(split)))).toBe(
        "supplier-package-goal-a",
      );
      expect(observe(1, Buffer.from(header))).toBeUndefined();
    }
    for (const text of [
      "PRIVATE_CANARY\n",
      header.replace("compiler", "unknown"),
      `prefix ${header}`,
      "X".repeat(16_385) + header,
    ])
      expect(
        createSupplierGoalObservation()(0, Buffer.from(text)),
      ).toBeUndefined();
    const observe = createSupplierGoalObservation();
    expect(observe(0, Buffer.alloc(8 * 1024 * 1024 + 1))).toBeUndefined();
    expect(observe(0, Buffer.from(header))).toBeUndefined();
    const proxy = new Proxy(Buffer.from(header), {
      get() {
        throw Error("PRIVATE_CANARY");
      },
    });
    expect(createSupplierGoalObservation()(0, proxy)).toBeUndefined();
  });
  it.each([
    ["compiler:3.15.0:compile", "a"],
    ["compiler:3.15.0:testCompile", "b"],
    ["templating:3.1.0:filter-sources", "c"],
    ["enforcer:3.6.3:enforce", "d"],
    ["checkstyle:3.6.0:check", "e"],
    ["flatten:1.8.0:flatten", "f"],
    ["git-commit-id:9.0.1:revision", "g"],
    ["frontend:2.0.0:install-node-and-npm", "h"],
    ["frontend:2.0.0:npm", "i"],
    ["resources:3.5.0:copy-resources", "j"],
    ["exec:3.6.3:exec", "k"],
    ["assembly:3.8.0:single", "l"],
  ])("maps only pinned %s to pending ordinal %s", (goal, ordinal) => {
    const text = `[INFO] --- ${goal} (fixed-execution) @ mockserver-netty ---\n`;
    expect(createSupplierGoalObservation()(0, Buffer.from(text))).toBe(
      `supplier-package-goal-${ordinal}`,
    );
    expect(
      createSupplierGoalObservation()(
        1,
        Buffer.from(text.replace(goal, `${goal}-unknown`)),
      ),
    ).toBeUndefined();
  });
  it("preserves separate stream fragments and the last recognized goal in a batch", () => {
    const second = header.replace(
      "compiler:3.15.0:compile",
      "frontend:2.0.0:npm",
    );
    const observe = createSupplierGoalObservation();
    expect(observe(0, Buffer.from(header.slice(0, 15)))).toBeUndefined();
    expect(observe(1, Buffer.from(second))).toBe("supplier-package-goal-i");
    expect(observe(0, Buffer.from(header.slice(15)))).toBe(
      "supplier-package-goal-a",
    );
    expect(observe(0, Buffer.from(header + second))).toBe(
      "supplier-package-goal-i",
    );
    expect(observe(0, Buffer.from("PRIVATE_CANARY\n"))).toBeUndefined();
  });
});
