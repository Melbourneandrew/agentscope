import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAgentscopeHomeResolver } from "@agentscope/core/configuration-management";
import { describe, expect, it, vi } from "vitest";

import { PRODUCT_DESTINATION_REGISTRY } from "./product-destination-registry.js";
import { createProductionCliServices } from "./production-services.js";

// AC-SQL-001.1: deferred capability must not create durable trace storage.
describe("alpha Local SQLite exclusion", () => {
  it("keeps discovery but refuses Local before plan or filesystem mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentscope-alpha-local-"));
    try {
      const services = createProductionCliServices({
        environment: {},
        homeResolver: createAgentscopeHomeResolver({
          environment: { AGENTSCOPE_HOME: root },
          environmentOverrideAuthority: "test",
          platform: process.platform,
        }),
        workspace: root,
      });
      expect(
        PRODUCT_DESTINATION_REGISTRY.descriptors.map(
          (descriptor) => descriptor.commandName,
        ),
      ).toContain("local-sqlite");
      const presentPlan = vi.fn();
      const unavailable = {
        status: "failure",
        diagnostic: {
          category: "unavailable",
          code: "destination.capability-unavailable",
        },
      };
      const configure = (
        apply: boolean,
        options: {
          settingsJson?: string;
          credentialEnvironment?: string[];
        } = {},
      ) =>
        services.configureDestination({
          apply,
          credentialEnvironment: options.credentialEnvironment ?? [],
          name: "local",
          presentPlan,
          settingsJson: options.settingsJson ?? "{}",
          type: "local-sqlite",
        });
      for (const apply of [false, true]) {
        await expect(configure(apply)).resolves.toEqual(unavailable);
        expect(await readdir(root)).toEqual([]);
      }
      await expect(
        services.init({ apply: true, presentPlan: async () => {} }),
      ).resolves.toMatchObject({ status: "success" });
      const beforeEntries = await readdir(root, { recursive: true });
      expect(await readdir(join(root, "destinations"))).toEqual([]);
      const beforeConfig = await readFile(join(root, "config.json"));
      for (const apply of [false, true]) {
        await expect(configure(apply)).resolves.toEqual(unavailable);
        expect(await readFile(join(root, "config.json"))).toEqual(beforeConfig);
        expect(await readdir(root, { recursive: true })).toEqual(beforeEntries);
      }
      await expect(
        configure(true, {
          settingsJson: "{malformed",
          credentialEnvironment: ["invalid-slot=UNSET_SECRET"],
        }),
      ).resolves.toEqual(unavailable);
      expect(await readdir(root, { recursive: true })).toEqual(beforeEntries);
      expect(presentPlan).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
