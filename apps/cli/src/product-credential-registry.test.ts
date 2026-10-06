import { readFileSync } from "node:fs";
import {
  createCredentialResolutionContext,
  resolveCredentialReference,
} from "@agentscope/core";
import { createCiEnvironmentCredentialReference } from "@agentscope/core/configuration-management";
import { afterEach, describe, expect, it } from "vitest";
import { createProductCredentialBackendRegistry } from "./product-credential-registry.js";

const original = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => {
  Object.defineProperty(process, "platform", original);
});
describe("private product credential composition", () => {
  it("retains exact named CI resolution without enumerating other variables", async () => {
    let reads = 0;
    const environment = {
      NAMED_KEY: "private-value",
      get OTHER_KEY() {
        reads += 1;
        throw new Error("private-canary");
      },
    };
    const registry = createProductCredentialBackendRegistry(environment);
    const reference = createCiEnvironmentCredentialReference(
      "NAMED_KEY",
      `credential-generation-v1-${"a".repeat(64)}`,
    );
    expect(
      (
        await resolveCredentialReference(
          registry,
          reference,
          createCredentialResolutionContext(
            "hook-equivalent",
            new AbortController().signal,
            performance.now() + 1000,
          ),
        )
      ).ok,
    ).toBe(true);
    expect(reads).toBe(0);
  });
  it.each(["win32", "linux"] as const)(
    "never selects a %s native backend",
    async (platform) => {
      Object.defineProperty(process, "platform", {
        ...original,
        value: platform,
      });
      const registry = createProductCredentialBackendRegistry({});
      const reference = {
        backend:
          platform === "win32"
            ? ("windows-credential-manager" as const)
            : ("linux-secret-service" as const),
        referenceVersion: 1 as const,
        referenceId: `credential-reference-v1-${"a".repeat(64)}`,
        generationId: `credential-generation-v1-${"b".repeat(64)}`,
      };
      await expect(
        resolveCredentialReference(
          registry,
          reference,
          createCredentialResolutionContext(
            "hook",
            new AbortController().signal,
            performance.now() + 1000,
          ),
        ),
      ).rejects.toThrow();
    },
  );
  it("uses the same factory at ordinary CLI and machine-hook call sites", () => {
    for (const file of ["production-services.ts", "hook-production.ts"]) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(source).toContain('from "./product-credential-registry.js"');
      expect(source).toContain("createProductCredentialBackendRegistry(");
      expect(source).not.toContain("compileCredentialBackendRegistry(");
    }
  });
});
