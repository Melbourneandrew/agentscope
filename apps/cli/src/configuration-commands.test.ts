import { describe, expect, it, vi } from "vitest";

import type { CliConfigurationServices } from "./configuration-commands.js";
import { createCapturedOutput } from "./__tests__/cli-fixture.js";
import { runCli } from "./program.js";

const connection = {
  connectionId: `destination-connection-v1-${"a".repeat(64)}`,
  destinationType: "@agentscope/destination-example",
  name: "primary",
  routed: false,
  settingsVersion: 1,
  transport: "remote" as const,
};

const unavailable = {
  diagnostic: {
    category: "unavailable" as const,
    code: "configuration.unavailable",
  },
  status: "failure" as const,
};

const services = (
  overrides: Partial<CliConfigurationServices> = {},
): CliConfigurationServices => ({
  configureDestination: () => Promise.resolve(unavailable),
  deleteDestination: () => Promise.resolve(unavailable),
  init: () => Promise.resolve(unavailable),
  inspectDestination: () => Promise.resolve(unavailable),
  listDestinations: () => Promise.resolve(unavailable),
  listRouting: () => Promise.resolve(unavailable),
  rotateDestinationCredential: () => Promise.resolve(unavailable),
  setRouting: () => Promise.resolve(unavailable),
  unconfigureDestination: () => Promise.resolve(unavailable),
  ...overrides,
});

describe("plan-first configuration command modules", () => {
  it("shows init plans without applying and passes explicit --yes authority", async () => {
    const init = vi
      .fn<CliConfigurationServices["init"]>()
      .mockImplementation(({ apply }) =>
        Promise.resolve({
          status: "success",
          value: {
            applied: apply,
            generation: apply ? 0 : null,
            steps: [
              {
                action: "create-configuration",
                destructive: false,
                id: "configuration-create",
                state: apply ? "applied" : "planned",
              },
            ],
          },
        }),
      );
    for (const arguments_ of [["init"], ["init", "--yes"]]) {
      const captured = createCapturedOutput();
      await expect(
        runCli(arguments_, {
          output: captured.output,
          services: services({ init }),
          version: "1.2.3",
        }),
      ).resolves.toBe(0);
      expect(captured.stderr).toEqual([]);
    }
    expect(init.mock.calls).toEqual([[{ apply: false }], [{ apply: true }]]);
  });

  it("passes only bounded generic destination settings and credential references", async () => {
    const configureDestination = vi
      .fn<CliConfigurationServices["configureDestination"]>()
      .mockResolvedValue({
        status: "success",
        value: { connection, generation: 2 },
      });
    const captured = createCapturedOutput();
    await expect(
      runCli(
        [
          "destination",
          "configure",
          "example",
          "--name",
          "primary",
          "--settings",
          '{"project":"agentscope"}',
          "--credential-env",
          "api-key=EXAMPLE_API_KEY",
          "--output",
          "json",
        ],
        {
          output: captured.output,
          services: services({ configureDestination }),
          version: "1.2.3",
        },
      ),
    ).resolves.toBe(0);
    expect(configureDestination).toHaveBeenCalledWith({
      credentialEnvironment: ["api-key=EXAMPLE_API_KEY"],
      name: "primary",
      settingsJson: '{"project":"agentscope"}',
      type: "example",
    });
    expect(JSON.parse(captured.stdout.join(""))).toMatchObject({
      dataSchema: "agentscope.cli.destination-configure.v1",
      records: [connection],
    });
  });
});

describe("configuration command safety", () => {
  it("supports explicit empty routing and never chooses a connection implicitly", async () => {
    const setRouting = vi
      .fn<CliConfigurationServices["setRouting"]>()
      .mockResolvedValue({
        status: "success",
        value: { generation: 3, selected: [] },
      });
    const captured = createCapturedOutput();
    await expect(
      runCli(["routing", "set"], {
        output: captured.output,
        services: services({ setRouting }),
        version: "1.2.3",
      }),
    ).resolves.toBe(0);
    expect(setRouting).toHaveBeenCalledWith({ names: [] });
    expect(captured.stdout).toEqual([
      "Delivery is disabled; no destination is selected.\n",
    ]);
  });

  it("requires delete confirmation and validates command inputs before services", async () => {
    const deleteDestination = vi
      .fn<CliConfigurationServices["deleteDestination"]>()
      .mockResolvedValue(unavailable);
    const captured = createCapturedOutput();
    await expect(
      runCli(["destination", "delete", "primary"], {
        output: captured.output,
        services: services({ deleteDestination }),
        version: "1.2.3",
      }),
    ).resolves.toBe(5);
    expect(deleteDestination).toHaveBeenCalledWith({
      confirm: false,
      name: "primary",
    });
    expect(
      await runCli(["destination", "inspect", "INVALID NAME"], {
        output: captured.output,
        services: services(),
        version: "1.2.3",
      }),
    ).toBe(2);
  });
});

describe("configuration command renderers", () => {
  it("renders every successful configuration command in human and machine modes", async () => {
    const successful = services({
      configureDestination: () =>
        Promise.resolve({
          status: "success",
          value: { connection, generation: 2 },
        }),
      deleteDestination: ({ name }) =>
        Promise.resolve({ status: "success", value: { deleted: true, name } }),
      init: ({ apply }) =>
        Promise.resolve({
          status: "success",
          value: {
            applied: apply,
            generation: 2,
            steps: [
              {
                action: "no-change",
                destructive: false,
                id: "configuration-current",
                state: "unchanged",
              },
            ],
          },
        }),
      inspectDestination: () =>
        Promise.resolve({
          status: "success",
          value: {
            connection,
            credentialSlots: [],
            documentationPath: "/docs/destinations/example",
            settingKeys: [],
          },
        }),
      listDestinations: () =>
        Promise.resolve({
          status: "success",
          value: { connections: [connection] },
        }),
      listRouting: () =>
        Promise.resolve({
          status: "success",
          value: { generation: 2, selected: ["primary"] },
        }),
      rotateDestinationCredential: ({ name, slot }) =>
        Promise.resolve({
          status: "success",
          value: { generation: 3, name, slot },
        }),
      setRouting: ({ names }) =>
        Promise.resolve({
          status: "success",
          value: { generation: 3, selected: [...names] },
        }),
      unconfigureDestination: ({ name }) =>
        Promise.resolve({
          status: "success",
          value: { dataPreserved: true, generation: 3, name },
        }),
    });
    const commands: readonly (readonly string[])[] = [
      ["init", "--yes"],
      ["destination", "configure", "example", "--name", "primary"],
      ["destination", "delete", "primary", "--confirm"],
      ["destination", "inspect", "primary"],
      ["destination", "list"],
      [
        "destination",
        "rotate",
        "primary",
        "--slot",
        "api-key",
        "--environment-variable",
        "EXAMPLE_API_KEY",
      ],
      ["destination", "unconfigure", "primary"],
      ["routing", "list"],
      ["routing", "set", "primary"],
    ];
    for (const command of commands) {
      for (const outputMode of ["human", "json"] as const) {
        const captured = createCapturedOutput();
        await expect(
          runCli([...command, "--output", outputMode], {
            output: captured.output,
            services: successful,
            version: "1.2.3",
          }),
        ).resolves.toBe(0);
        expect(captured.stderr).toEqual([]);
        expect(captured.stdout.join("")).not.toBe("");
      }
    }
  });

  it("renders empty destination and credential inventories explicitly", async () => {
    const captured = createCapturedOutput();
    await expect(
      runCli(["destination", "list"], {
        output: captured.output,
        services: services({
          listDestinations: () =>
            Promise.resolve({
              status: "success",
              value: { connections: [] },
            }),
        }),
        version: "1.2.3",
      }),
    ).resolves.toBe(0);
    expect(captured.stdout).toEqual([
      "No destination connections are configured.\n",
    ]);
  });
});
