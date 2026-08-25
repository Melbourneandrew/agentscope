import {
  compileDestinationRegistry,
  compileLocalResourceLifecycleHandlerRegistry,
  completeLocalResourceLifecycle,
} from "@agentscope/destinations-core";
import {
  bindLocalResourceLifecycleContextForTesting,
  createLocalResourceLifecycleDeadlineForTesting,
} from "@agentscope/destinations-core/testing";
import { describe, expect, it, vi } from "vitest";

import { LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES } from "../lifecycle/capability.js";
import {
  bindLocalSqliteProductionLifecyclePorts,
  createLocalSqliteLifecycleHandlerWithInitializer,
} from "../lifecycle/configuration.js";
import { localSqliteDestinationDescriptor } from "./descriptor.js";

describe("Local SQLite production lifecycle binding", () => {
  it("lazily binds one exact native snapshot authority and rejects invalid initialization or rebinding", async () => {
    expect(() => {
      bindLocalSqliteProductionLifecyclePorts({} as never, {} as never, 0);
    }).toThrow("destination.local-sqlite.lifecycle-unavailable");

    const capability = compileDestinationRegistry([
      localSqliteDestinationDescriptor,
    ]).descriptors[0]!.localResourceLifecycle!;
    const registry = compileDestinationRegistry([
      localSqliteDestinationDescriptor,
    ]);
    const context = bindLocalResourceLifecycleContextForTesting({
      operation: "configure",
      operationId: "1".repeat(32),
      destinationType: localSqliteDestinationDescriptor.destinationType,
      connectionId: `destination-connection-v1-${"2".repeat(64)}`,
      connectionName: "local",
      owner: {
        processId: 123,
        processStartIdentity: `process-start-v1-${"7".repeat(64)}`,
      },
      settings: localSqliteDestinationDescriptor.defaultSettings,
      expectedConfigurationGeneration: 7,
      candidateConfigurationGeneration: 8,
      expectedConfigurationDigest: `sha256-${"3".repeat(64)}`,
      candidateConfigurationDigest: `sha256-${"4".repeat(64)}`,
      signal: new AbortController().signal,
      deadline: createLocalResourceLifecycleDeadlineForTesting(10_000),
    });
    await expect(
      completeLocalResourceLifecycle(
        compileLocalResourceLifecycleHandlerRegistry(registry, [
          createLocalSqliteLifecycleHandlerWithInitializer(
            capability,
            undefined as never,
          ),
        ]),
        context,
      ),
    ).rejects.toThrow("destination.local-sqlite.lifecycle-unavailable");

    const completeFinalization = vi.fn(() => Promise.resolve());
    const initialize = vi.fn(() => {
      bindLocalSqliteProductionLifecyclePorts(
        { completeFinalization } as never,
        {} as never,
        LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES,
      );
    });
    const handler = createLocalSqliteLifecycleHandlerWithInitializer(
      capability,
      initialize,
    );
    const handlers = compileLocalResourceLifecycleHandlerRegistry(registry, [
      handler,
    ]);
    await completeLocalResourceLifecycle(handlers, context);
    await completeLocalResourceLifecycle(handlers, context);
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(completeFinalization).toHaveBeenCalledTimes(2);

    expect(() => {
      bindLocalSqliteProductionLifecyclePorts(
        {} as never,
        {} as never,
        LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES,
      );
    }).toThrow("destination.local-sqlite.lifecycle-unavailable");
  });
});
