import { describe, expect, it, vi } from "vitest";

import { createCapturedOutput } from "./__tests__/cli-fixture.js";
import type { CliHarnessServices } from "./harness-commands.js";
import { runCli } from "./program.js";

const unavailable = {
  diagnostic: { category: "unavailable" as const, code: "harness.unavailable" },
  status: "failure" as const,
};

const services = (
  overrides: Partial<CliHarnessServices> = {},
): CliHarnessServices => ({
  installHarness: () => Promise.resolve(unavailable),
  listHarnesses: () => Promise.resolve(unavailable),
  migrateHarness: () => Promise.resolve(unavailable),
  statusHarness: () => Promise.resolve(unavailable),
  uninstallHarness: () => Promise.resolve(unavailable),
  ...overrides,
});

const discovery = {
  configurationLocationCount: 1,
  configurationPresentCount: 1,
  harness: "example",
  harnessType: "@agentscope/harness-example",
  reason: "compatible" as const,
  state: "installed" as const,
  version: "1.2.0",
};

describe("harness command modules", () => {
  it("renders discovery in human and versioned machine output", async () => {
    const listHarnesses = vi
      .fn<CliHarnessServices["listHarnesses"]>()
      .mockResolvedValue({
        status: "success",
        value: { harnesses: [discovery] },
      });
    for (const arguments_ of [
      ["harness", "list"],
      ["harness", "list", "--output", "json"],
    ]) {
      const captured = createCapturedOutput();
      await expect(
        runCli(arguments_, {
          output: captured.output,
          services: services({ listHarnesses }),
          version: "1.2.3",
        }),
      ).resolves.toBe(0);
      expect(captured.stderr).toEqual([]);
      expect(captured.stdout.join("")).toContain("example");
    }
    expect(listHarnesses).toHaveBeenCalledTimes(2);
  });

  it("passes explicit apply authority only when --yes is present", async () => {
    const installHarness = vi
      .fn<CliHarnessServices["installHarness"]>()
      .mockImplementation(({ apply, harness }) =>
        Promise.resolve({
          status: "success",
          value: {
            applied: apply,
            changedTargetCount: 1,
            disposition: apply ? ("committed" as const) : ("ready" as const),
            harness,
            operation: "install" as const,
            targetCount: 1,
          },
        }),
      );
    for (const arguments_ of [
      ["install", "example"],
      ["install", "example", "--yes"],
    ]) {
      const captured = createCapturedOutput();
      await expect(
        runCli(arguments_, {
          output: captured.output,
          services: services({ installHarness }),
          version: "1.2.3",
        }),
      ).resolves.toBe(0);
    }
    expect(
      installHarness.mock.calls.map(([input]) => ({
        apply: input.apply,
        harness: input.harness,
      })),
    ).toEqual([
      { apply: false, harness: "example" },
      { apply: true, harness: "example" },
    ]);
    for (const [input] of installHarness.mock.calls)
      expect(typeof input.presentPlan).toBe("function");
  });

  it("renders status and empty discovery in every supported presentation path", async () => {
    const statusHarness = vi
      .fn<CliHarnessServices["statusHarness"]>()
      .mockResolvedValue({
        status: "success",
        value: { discovery, installation: "unchanged" },
      });
    const listHarnesses = vi
      .fn<CliHarnessServices["listHarnesses"]>()
      .mockResolvedValue({ status: "success", value: { harnesses: [] } });
    for (const arguments_ of [
      ["harness", "status", "example"],
      ["harness", "status", "example", "--output", "json"],
      ["harness", "list"],
    ]) {
      await expect(
        runCli(arguments_, {
          output: createCapturedOutput().output,
          services: services({ listHarnesses, statusHarness }),
          version: "1.2.3",
        }),
      ).resolves.toBe(0);
    }
    expect(statusHarness).toHaveBeenCalledTimes(2);
    expect(listHarnesses).toHaveBeenCalledTimes(1);
  });
});

describe("harness mutation command authorities", () => {
  it("keeps migration and uninstall as separate command authorities", async () => {
    const migrateHarness = vi
      .fn<CliHarnessServices["migrateHarness"]>()
      .mockResolvedValue({
        diagnostic: {
          category: "conflict",
          code: "harness.overlap-conflict",
        },
        status: "partial",
        value: {
          applied: false,
          changedTargetCount: 0,
          disposition: "conflict",
          harness: "example",
          operation: "migrate",
          targetCount: 1,
        },
      });
    const uninstallHarness = vi
      .fn<CliHarnessServices["uninstallHarness"]>()
      .mockResolvedValue({
        status: "success",
        value: {
          applied: false,
          changedTargetCount: 0,
          disposition: "unchanged",
          harness: "example",
          operation: "uninstall",
          targetCount: 1,
        },
      });
    const migrationOutput = createCapturedOutput();
    await expect(
      runCli(["harness", "migrate", "example"], {
        output: migrationOutput.output,
        services: services({ migrateHarness }),
        version: "1.2.3",
      }),
    ).resolves.toBe(4);
    const migrateInput = migrateHarness.mock.calls[0]?.[0];
    expect(migrateInput).toMatchObject({ apply: false, harness: "example" });
    expect(typeof migrateInput?.presentPlan).toBe("function");
    await expect(
      runCli(["uninstall", "example"], {
        output: createCapturedOutput().output,
        services: services({ uninstallHarness }),
        version: "1.2.3",
      }),
    ).resolves.toBe(0);
    const uninstallInput = uninstallHarness.mock.calls[0]?.[0];
    expect(uninstallInput).toMatchObject({ apply: false, harness: "example" });
    expect(typeof uninstallInput?.presentPlan).toBe("function");

    for (const [arguments_, override] of [
      [
        ["install", "example", "--output", "json"],
        {
          installHarness: () =>
            Promise.resolve({
              status: "success" as const,
              value: {
                applied: false,
                changedTargetCount: 1,
                disposition: "ready" as const,
                harness: "example",
                operation: "install" as const,
                targetCount: 1,
              },
            }),
        },
      ],
      [["uninstall", "example", "--output", "json"], { uninstallHarness }],
      [
        ["harness", "migrate", "example", "--output", "json"],
        { migrateHarness },
      ],
    ] as const) {
      await runCli(arguments_, {
        output: createCapturedOutput().output,
        services: services(override),
        version: "1.2.3",
      });
    }
  });

  it("rejects malformed harness names before service invocation", async () => {
    const statusHarness = vi.fn<CliHarnessServices["statusHarness"]>();
    await expect(
      runCli(["harness", "status", "INVALID NAME"], {
        output: createCapturedOutput().output,
        services: services({ statusHarness }),
        version: "1.2.3",
      }),
    ).resolves.toBe(2);
    expect(statusHarness).not.toHaveBeenCalled();
  });
});
