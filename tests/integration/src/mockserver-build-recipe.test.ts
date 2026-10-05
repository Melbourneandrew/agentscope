import { describe, expect, it } from "vitest";

import {
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
