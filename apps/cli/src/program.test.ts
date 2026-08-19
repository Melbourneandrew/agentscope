import { afterEach, describe, expect, it, vi } from "vitest";

import { CLI_EXIT_CODES } from "./cli-contract.js";
import { createCapturedOutput, runFixture } from "./__tests__/cli-fixture.js";
import { createProgram, runCli } from "./program.js";

const success = Object.freeze({
  status: "success",
  value: { items: [{ id: "one", label: "One" }] },
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("agentscope root command", () => {
  it("renders deterministic side-effect-free root help", async () => {
    // AC-CLI-001.1 AC-CLI-001.2 AC-CLI-001.4
    const captured = createCapturedOutput();
    const exitCode = await runCli(["--help"], {
      output: captured.output,
      version: "1.2.3",
    });

    expect(exitCode).toBe(0);
    expect(captured.stderr).toEqual([]);
    expect(captured.stdout.join("")).toMatchInlineSnapshot(`
      "Usage: agentscope [options] [command]

      Capture coding-agent traces and report them to trace destinations.

      Options:
        -V, --version                  output the installed version
        -h, --help                     display help for command

      Commands:
        destination                    Configure and inspect named trace destination
                                       connections.
        harness                        Discover harnesses and inspect or migrate owned
                                       integrations.
        init [options]                 Inspect the machine and produce or apply a
                                       non-destructive initialization plan.
        install [options] <harness>    Inspect or apply an owned harness integration
                                       plan.
        routing                        Inspect or replace the explicit destination
                                       routing selection.
        traces                         Search and retrieve portable traces from one
                                       named destination.
        uninstall [options] <harness>  Inspect or apply removal of only an
                                       Agentscope-owned hook.
        help [command]                 display help for command

      Documentation: https://melbourneandrew.github.io/agentscope/docs/cli/index

      "
    `);
  });

  it("prints only the injected package version", async () => {
    // AC-INS-001.1 AC-INS-001.2
    const captured = createCapturedOutput();
    const exitCode = await runCli(["--version"], {
      output: captured.output,
      version: "1.2.3",
    });

    expect(exitCode).toBe(0);
    expect(captured.stderr).toEqual([]);
    expect(captured.stdout).toEqual(["1.2.3\n"]);
  });

  it("uses a fixed usage diagnostic without echoing an unknown argument", async () => {
    const captured = createCapturedOutput();
    const exitCode = await runCli(["--does-not-exist-CANARY"], {
      output: captured.output,
      version: "1.2.3",
    });

    expect(exitCode).toBe(CLI_EXIT_CODES.usage);
    expect(captured.stdout).toEqual([]);
    expect(captured.stderr).toEqual(["error [cli.input.invalid]\n"]);
    expect(captured.stderr.join("")).not.toContain("CANARY");
  });

  it("rejects unsafe argv before program construction", async () => {
    const captured = createCapturedOutput();
    const exitCode = await runCli(["--name", "CANARY\nSECRET"], {
      output: captured.output,
      version: "not-a-version",
    });

    expect(exitCode).toBe(CLI_EXIT_CODES.usage);
    expect(captured.stdout).toEqual([]);
    expect(captured.stderr).toEqual(["error [cli.input.invalid]\n"]);
  });
});

describe("process output", () => {
  it("uses the real process streams when output is not injected", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(
      (value: unknown, encodingOrCallback?: unknown, callback?: unknown) => {
        stdout.push(String(value));
        const completion =
          typeof encodingOrCallback === "function"
            ? encodingOrCallback
            : callback;
        if (typeof completion === "function")
          Reflect.apply(completion, undefined, []);
        return true;
      },
    );
    vi.spyOn(process.stderr, "write").mockImplementation(
      (value: unknown, encodingOrCallback?: unknown, callback?: unknown) => {
        stderr.push(String(value));
        const completion =
          typeof encodingOrCallback === "function"
            ? encodingOrCallback
            : callback;
        if (typeof completion === "function")
          Reflect.apply(completion, undefined, []);
        return true;
      },
    );

    expect(await runCli(["--version"], { version: "1.2.3" })).toBe(0);
    expect(await runCli(["--bad"], { version: "1.2.3" })).toBe(2);
    expect(stdout).toEqual(["1.2.3\n"]);
    expect(stderr).toEqual(["error [cli.input.invalid]\n"]);
  });
});

describe("agentscope root command failures", () => {
  it("binds Commander help and error writers to the CLI output", () => {
    const captured = createCapturedOutput();
    const program = createProgram({
      output: captured.output,
      state: { exitCode: 0 },
      version: "1.2.3",
    });

    program.configureOutput().writeErr?.("fixture error\n");
    expect(captured.stderr).toEqual(["fixture error\n"]);
  });

  it("contains output failures and invalid program metadata", async () => {
    const output = {
      writeErr: () => {
        throw new Error("CANARY");
      },
      writeOut: () => {
        throw new Error("CANARY");
      },
    };
    expect(await runCli(["--bad"], { output, version: "not-a-version" })).toBe(
      70,
    );
  });

  it.each([
    ["not an array", {}],
    ["too many", Array.from({ length: 129 }, () => "x")],
    ["long value", ["x".repeat(8_193)]],
    ["sparse", new Array(1)],
    ["symbol property", Object.assign([], { [Symbol("x")]: true })],
  ])("rejects hostile argv: %s", async (_name, arguments_) => {
    const captured = createCapturedOutput();
    expect(
      await runCli(arguments_, {
        output: captured.output,
        version: "1.2.3",
      }),
    ).toBe(2);
  });
});

describe("typed command execution", () => {
  // AC-CLI-002.1 AC-CLI-002.2 AC-CLI-002.3 AC-CLI-002.4
  it("renders complete nested help without invoking services", async () => {
    // AC-CLI-001.1 AC-CLI-001.2
    const group = await runFixture(["sample", "--help"], () => success);
    const command = await runFixture(
      ["sample", "list", "--help"],
      () => success,
    );

    expect(group).toMatchObject({ exitCode: 0, serviceCalls: 0, stderr: [] });
    expect(group.stdout.join("")).toContain("Commands:\n  list");
    expect(command).toMatchObject({
      exitCode: 0,
      serviceCalls: 0,
      stderr: [],
    });
    expect(command.stdout.join("")).toContain("--name <name>");
    expect(command.stdout.join("")).toContain("--output <mode>");
    expect(command.stdout.join("")).toContain("cli/sample/list");
  });

  it("validates input and output mode before invoking services", async () => {
    const invalidInput = await runFixture(
      ["sample", "list", "--name", ""],
      () => success,
    );
    const invalidMode = await runFixture(
      ["sample", "list", "--name", "x", "--output", "xml"],
      () => success,
    );

    expect(invalidInput).toMatchObject({ exitCode: 2, serviceCalls: 0 });
    expect(invalidInput.stderr).toEqual(["error [cli.input.invalid]\n"]);
    expect(invalidMode).toMatchObject({ exitCode: 2, serviceCalls: 0 });
    expect(invalidMode.stderr).toEqual(["error [cli.output.unsupported]\n"]);
  });

  it("escapes unsafe terminal content in human output", async () => {
    const result = await runFixture(["sample", "list", "--name", "x"], () => ({
      status: "success",
      value: { items: [{ id: "one", label: "safe\n\u001b[31m\u202e" }] },
    }));

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toEqual([]);
    expect(result.stdout).toEqual(["safe\\u{000a}\\u{001b}[31m\\u{202e}\n"]);
  });

  it("writes one deterministic versioned JSON document", async () => {
    const result = await runFixture(
      ["sample", "list", "--name", "x", "--output", "json"],
      () => success,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toEqual([]);
    expect(result.stdout).toEqual([
      '{"command":"agentscope sample list","completion":"complete","dataSchema":"agentscope.cli.sample-list.v1","records":[{"id":"one","label":"One"}],"schema":"agentscope.cli.result.v1"}\n',
    ]);
  });

  it("writes independently typed JSONL data and summary records", async () => {
    const result = await runFixture(
      ["sample", "list", "--name", "x", "--output=jsonl"],
      () => success,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toEqual([]);
    expect(result.stdout).toEqual([
      '{"command":"agentscope sample list","data":{"id":"one","label":"One"},"dataSchema":"agentscope.cli.sample-list.v1","kind":"data","schema":"agentscope.cli.record.v1","sequence":0}\n',
      '{"command":"agentscope sample list","completion":"complete","count":1,"dataSchema":"agentscope.cli.sample-list.v1","kind":"summary","schema":"agentscope.cli.record.v1"}\n',
    ]);
  });

  it("returns data plus one nonzero diagnostic for partial results", async () => {
    const result = await runFixture(
      ["sample", "list", "--name", "x", "--output", "json"],
      () => ({
        diagnostic: { category: "unavailable", code: "sample.unavailable" },
        status: "partial",
        value: { items: [{ id: "one", label: "One" }] },
      }),
    );

    expect(result.exitCode).toBe(CLI_EXIT_CODES.unavailable);
    expect(result.stdout[0]).toContain('"completion":"partial"');
    expect(result.stderr).toEqual([
      '{"category":"unavailable","code":"sample.unavailable","command":"agentscope sample list","schema":"agentscope.cli.diagnostic.v1"}\n',
    ]);
  });
});

describe("typed failures", () => {
  it.each([
    ["usage", "sample.usage", 2],
    ["not-found", "sample.not-found", 3],
    ["conflict", "sample.conflict", 4],
    ["unavailable", "sample.unavailable", 5],
    ["permission-denied", "sample.permission-denied", 6],
    ["internal-error", "sample.internal", 70],
  ] as const)(
    "maps %s to its closed exit code",
    async (category, code, exit) => {
      const result = await runFixture(
        ["sample", "list", "--name", "x", "--output", "json"],
        () => ({ diagnostic: { category, code }, status: "failure" }),
      );

      expect(result.exitCode).toBe(exit);
      expect(result.stdout).toEqual([]);
      expect(result.stderr[0]).toContain(`"category":"${category}"`);
    },
  );

  it("collapses thrown values and undeclared diagnostics", async () => {
    const thrown = await runFixture(["sample", "list", "--name", "x"], () => {
      throw new Error("CANARY_SECRET");
    });
    const undeclared = await runFixture(
      ["sample", "list", "--name", "x"],
      () => ({
        diagnostic: { category: "conflict", code: "provider.CANARY" },
        status: "failure",
      }),
    );

    expect(thrown.exitCode).toBe(70);
    expect(undeclared.exitCode).toBe(70);
    expect([...thrown.stderr, ...undeclared.stderr].join(" ")).not.toContain(
      "CANARY",
    );
  });

  it.each([
    [
      "accessor",
      () => Object.defineProperty({}, "status", { get: () => "success" }),
    ],
    [
      "custom prototype",
      () => {
        const candidate: object = {};
        Object.setPrototypeOf(candidate, { status: "success" });
        return candidate;
      },
    ],
    ["function", () => ({ status: "success", value: () => undefined })],
    ["sparse", () => ({ status: "success", value: { items: new Array(1) } })],
    ["thenable", () => ({ then: () => undefined })],
    ["toJSON", () => ({ status: "success", toJSON: () => ({}) })],
  ])("rejects a hostile %s result without disclosure", async (_name, value) => {
    const result = await runFixture(
      ["sample", "list", "--name", "x", "--output", "json"],
      value,
    );

    expect(result.exitCode).toBe(70);
    expect(result.stdout).toEqual([]);
    expect(result.stderr).toEqual([
      '{"category":"internal-error","code":"cli.internal","command":"agentscope sample list","schema":"agentscope.cli.diagnostic.v1"}\n',
    ]);
  });

  it("rejects cycles and aliases before writing any machine record", async () => {
    const shared = { id: "one", label: "One" };
    const alias = await runFixture(
      ["sample", "list", "--name", "x", "--output", "jsonl"],
      () => ({
        status: "success",
        value: { items: [shared, shared] },
      }),
    );
    const cycle: Record<string, unknown> = { status: "success" };
    cycle.value = cycle;
    const cyclic = await runFixture(
      ["sample", "list", "--name", "x", "--output", "jsonl"],
      () => cycle,
    );

    expect(alias.exitCode).toBe(70);
    expect(cyclic.exitCode).toBe(70);
    expect(alias.stdout).toEqual([]);
    expect(cyclic.stdout).toEqual([]);
  });
});
