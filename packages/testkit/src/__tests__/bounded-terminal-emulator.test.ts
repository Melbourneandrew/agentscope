import { describe, expect, it, vi } from "vitest";

import {
  BoundedTerminalEmulator,
  BoundedTerminalEmulatorError,
  defaultPtyTerminalEmulatorLimits,
  validatePtyTerminalSemanticSnapshot,
} from "../bounded-terminal-emulator.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const bytes = (value: string): Uint8Array => encoder.encode(value);

// These cases share one bounded emulator fixture surface across semantic states.
// eslint-disable-next-line max-lines-per-function
describe("bounded semantic terminal emulator", () => {
  it("derives readiness across fragmented ANSI and resize operations", () => {
    const terminal = new BoundedTerminalEmulator({ columns: 80, rows: 24 });
    terminal.write(bytes("\u001b[?1049h\u001b]0;fixture"));
    terminal.write(bytes(" title\u001b\\\u001b[2J\u001b[6n"));
    terminal.write(bytes("AGENTSCOPE_PTY_"));
    terminal.resize({ columns: 100, rows: 30 });
    terminal.write(bytes("READY\r\n"));
    const snapshot = terminal.end();

    expect(snapshot).toMatchObject({
      alternateScreen: true,
      geometry: { columns: 100, rows: 30 },
      malformedControlCount: 0,
      sawCursorPositionQuery: true,
      semanticState: "ready",
      titlePresent: true,
      unsupportedControlCount: 0,
    });
    expect(snapshot.titleSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(snapshot.screenSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("tracks cursor movement, clearing, completion, and visibility semantically", () => {
    const terminal = new BoundedTerminalEmulator({ columns: 20, rows: 4 });
    terminal.write(
      bytes(
        "first\r\nsecond\u001b[1A\u001b[3C!\u001b[?25l\u001b[?25h\r\nAGENTSCOPE_PTY_COMPLETE",
      ),
    );
    const snapshot = terminal.end();
    expect(snapshot.semanticState).toBe("completed");
    expect(snapshot.cursorVisible).toBe(true);
    expect(snapshot.printableCellCount).toBeGreaterThan(0);
    expect(snapshot.nonEmptyLineCount).toBeGreaterThan(0);
  });

  it("retains same-write completion after later output leaves the recent window", () => {
    const terminal = new BoundedTerminalEmulator(
      { columns: 40, rows: 8 },
      {
        ...defaultPtyTerminalEmulatorLimits,
        maximumRecentCodePoints: 32,
      },
    );
    terminal.write(bytes(`AGENTSCOPE_PTY_COMPLETE\r\n${"x".repeat(64)}`));

    expect(terminal.end().semanticState).toBe("completed");
  });

  it("recognizes fragmented completion without accepting a near marker", () => {
    const near = new BoundedTerminalEmulator({ columns: 40, rows: 8 });
    near.write(bytes("AGENTSCOPE_PTY_COMPLET"));
    near.write(bytes("X"));
    expect(near.end().semanticState).toBe("active");

    const fragmented = new BoundedTerminalEmulator({ columns: 40, rows: 8 });
    fragmented.write(bytes("AGENTSCOPE_PTY_COM"));
    fragmented.write(bytes("PLETE"));
    expect(fragmented.end().semanticState).toBe("completed");
  });

  it.each([
    [
      "readiness then completion",
      "AGENTSCOPE_PTY_READY\r\nAGENTSCOPE_PTY_COMPLETE",
    ],
    [
      "completion then readiness",
      "AGENTSCOPE_PTY_COMPLETE\r\nAGENTSCOPE_PTY_READY",
    ],
  ])("latches independent semantic markers for %s", (_label, output) => {
    const terminal = new BoundedTerminalEmulator({ columns: 40, rows: 8 });
    terminal.write(bytes(output));

    expect(terminal.readinessObserved()).toBe(true);
    expect(terminal.completionObserved()).toBe(true);
    expect(terminal.end().semanticState).toBe("completed");
  });

  it("derives selected post-completion readiness from styled text", () => {
    const terminal = new BoundedTerminalEmulator(
      { columns: 40, rows: 8 },
      defaultPtyTerminalEmulatorLimits,
      {
        kind: "styled-text-after-completion",
        text: "›",
        bold: true,
        dim: false,
      },
    );
    terminal.write(bytes("\u001b[1m›\u001b[0m "));
    expect(terminal.readinessObserved()).toBe(false);

    terminal.write(bytes("AGENTSCOPE_PTY_COMPLETE\r\n\u001b[2m›\u001b[0m "));
    expect(terminal.completionObserved()).toBe(true);
    expect(terminal.readinessObserved()).toBe(false);

    terminal.write(bytes("\u001b[1"));
    terminal.write(bytes("m›\u001b[22m "));
    expect(terminal.readinessObserved()).toBe(true);
  });

  it("accepts only the exact per-run challenge marker", () => {
    const challenge = "a".repeat(64);
    const terminal = new BoundedTerminalEmulator(
      { columns: 40, rows: 8 },
      defaultPtyTerminalEmulatorLimits,
      { kind: "challenge-marker", challenge },
    );

    terminal.write(bytes("AGENTSCOPE_PTY_READY"));
    expect(terminal.readinessObserved()).toBe(false);
    terminal.write(bytes(`:${"b".repeat(64)}`));
    expect(terminal.readinessObserved()).toBe(false);
    terminal.write(bytes(`\r\nAGENTSCOPE_PTY_READY:${challenge}`));
    expect(terminal.readinessObserved()).toBe(true);
  });

  it("holds challenged input until the exact styled TUI prompt", () => {
    const challenge = "a".repeat(64);
    const terminal = new BoundedTerminalEmulator(
      { columns: 40, rows: 8 },
      defaultPtyTerminalEmulatorLimits,
      {
        kind: "challenge-styled-text",
        challenge,
        text: "›",
        requiredText: "fixture-model default",
        requiredTerminalProtocol: "csi-u-flags-7-query-v1",
        bold: true,
        dim: false,
      },
    );
    terminal.write(
      bytes(
        "\u001b[>7u\u001b[6n\u001b]10;?\u001b\\\u001b]11;?\u001b\\\u001b[?u\u001b[c",
      ),
    );

    terminal.write(bytes("\u001b[1m›\u001b[22m "));
    expect(terminal.readinessObserved()).toBe(false);
    terminal.write(bytes(`AGENTSCOPE_PTY_READY:${"b".repeat(64)}\r\n`));
    terminal.write(bytes("\u001b[1m›\u001b[22m "));
    expect(terminal.readinessObserved()).toBe(false);
    terminal.write(bytes(`AGENTSCOPE_PTY_READY:${challenge}\r\n`));
    expect(terminal.readinessObserved()).toBe(false);
    terminal.write(bytes("[2m›[22m "));
    expect(terminal.readinessObserved()).toBe(false);
    terminal.write(bytes("[1m›[22m "));
    expect(terminal.readinessObserved()).toBe(false);
    terminal.write(bytes("fixture-model defaul"));
    expect(terminal.readinessObserved()).toBe(false);
    terminal.write(bytes("t"));
    expect(terminal.readinessObserved()).toBe(true);
    expect(terminal.readinessObservationGeneration()).toBe(1);

    terminal.write(bytes("\u0007fixture-model default"));
    expect(terminal.readinessObservationGeneration()).toBe(1);
    terminal.write(bytes("\u001b[1m›\u001b[22m unrelated"));
    expect(terminal.readinessObservationGeneration()).toBe(1);
    terminal.write(
      bytes("\u001b[1m›\u001b[22m \u001b[2mfixture-model default\u001b[22m"),
    );
    expect(terminal.readinessObserved()).toBe(true);
    expect(terminal.readinessObservationGeneration()).toBe(2);

    terminal.write(bytes("\u001b[2J"));
    expect(terminal.readinessObserved()).toBe(false);

    terminal.write(
      bytes("\u001b[H\u001b[1m›\u001b[22m \u001b[2mfixture-model default"),
    );
    expect(terminal.readinessObservationGeneration()).toBe(3);
    expect(terminal.readinessObserved()).toBe(true);
    terminal.write(bytes("\rX"));
    expect(terminal.readinessObserved()).toBe(false);
  });

  it("admits CSI-u input only after the required terminal protocol", () => {
    const challenge = "a".repeat(64);
    const terminal = () =>
      new BoundedTerminalEmulator(
        { columns: 40, rows: 8 },
        defaultPtyTerminalEmulatorLimits,
        {
          kind: "challenge-styled-text",
          challenge,
          text: "›",
          requiredText: "fixture-model default",
          requiredTerminalProtocol: "csi-u-flags-7-query-v1",
          bold: true,
          dim: false,
        },
      );
    const queries =
      "\u001b[6n\u001b]10;?\u001b\\\u001b]11;?\u001b\\\u001b[?u\u001b[c";

    const exact = terminal();
    exact.write(bytes(`\u001b[>7u${queries}`));
    expect(exact.requiredTerminalProtocolReady()).toBe(true);

    const earlyReadiness = terminal();
    earlyReadiness.write(
      bytes(
        `AGENTSCOPE_PTY_READY:${challenge}\r\n\u001b[1m›\u001b[22m fixture-model default`,
      ),
    );
    earlyReadiness.write(bytes(`\u001b[>7u${queries}`));
    expect(earlyReadiness.readinessObserved()).toBe(false);
    expect(earlyReadiness.requiredTerminalProtocolReady()).toBe(false);

    const resetAfterReady = terminal();
    resetAfterReady.write(bytes(`\u001b[>7u${queries}`));
    resetAfterReady.write(bytes("\u001bc"));
    resetAfterReady.write(
      bytes(
        `AGENTSCOPE_PTY_READY:${challenge}\r\n\u001b[1m›\u001b[22m fixture-model default`,
      ),
    );
    expect(resetAfterReady.readinessObserved()).toBe(false);
    expect(resetAfterReady.requiredTerminalProtocolReady()).toBe(false);

    for (const sequence of [
      queries,
      `\u001b[>6u${queries}`,
      `${queries}\u001b[>7u`,
      `\u001b[>7u${queries}\u001b[<u`,
      `\u001b[>7u\u001b[>7u${queries}`,
    ]) {
      const rejected = terminal();
      rejected.write(bytes(sequence));
      expect(rejected.requiredTerminalProtocolReady()).toBe(false);
    }
  });

  it("revokes challenged readiness when resize truncates the live footer", () => {
    const challenge = "a".repeat(64);
    const terminal = new BoundedTerminalEmulator(
      { columns: 40, rows: 4 },
      defaultPtyTerminalEmulatorLimits,
      {
        kind: "challenge-styled-text",
        challenge,
        text: "›",
        requiredText: "fixture-model default",
        requiredTerminalProtocol: "csi-u-flags-7-query-v1",
        bold: true,
        dim: false,
      },
    );
    terminal.write(
      bytes(
        "\u001b[>7u\u001b[6n\u001b]10;?\u001b\\\u001b]11;?\u001b\\\u001b[?u\u001b[c",
      ),
    );
    terminal.write(
      bytes(
        `AGENTSCOPE_PTY_READY:${challenge}\r\n\u001b[2J\u001b[H\u001b[1m›\u001b[22m \u001b[2mfixture-model default`,
      ),
    );
    expect(terminal.readinessObserved()).toBe(true);

    terminal.resize({ columns: 10, rows: 4 });
    expect(terminal.readinessObserved()).toBe(false);
  });

  it("revokes challenged readiness when scrolling removes the live composer", () => {
    const challenge = "a".repeat(64);
    const terminal = new BoundedTerminalEmulator(
      { columns: 40, rows: 2 },
      defaultPtyTerminalEmulatorLimits,
      {
        kind: "challenge-styled-text",
        challenge,
        text: "›",
        requiredText: "fixture-model default",
        requiredTerminalProtocol: "csi-u-flags-7-query-v1",
        bold: true,
        dim: false,
      },
    );
    terminal.write(
      bytes(
        "\u001b[>7u\u001b[6n\u001b]10;?\u001b\\\u001b]11;?\u001b\\\u001b[?u\u001b[c",
      ),
    );
    terminal.write(
      bytes(
        `AGENTSCOPE_PTY_READY:${challenge}\r\n\u001b[2J\u001b[H\u001b[1m›\u001b[22m \u001b[2mfixture-model default`,
      ),
    );
    expect(terminal.readinessObserved()).toBe(true);

    terminal.write(bytes(`\r\n${"x".repeat(40)}`));
    expect(terminal.readinessObserved()).toBe(false);
  });

  it("does not mistake mismatched styled text for post-completion readiness", () => {
    const terminal = new BoundedTerminalEmulator(
      { columns: 40, rows: 8 },
      defaultPtyTerminalEmulatorLimits,
      {
        kind: "styled-text-after-completion",
        text: "›",
        bold: true,
        dim: false,
      },
    );

    terminal.write(bytes("AGENTSCOPE_PTY_COMPLETE\r\n"));
    terminal.write(
      bytes("\u001b[2m›\u001b[1m›\u001b[22m \u001b[1mtext\u001b[0m›"),
    );

    expect(terminal.completionObserved()).toBe(true);
    expect(terminal.readinessObserved()).toBe(false);
  });

  it("retains a later credential prompt after it leaves the recent window", () => {
    const terminal = new BoundedTerminalEmulator(
      { columns: 40, rows: 8 },
      {
        ...defaultPtyTerminalEmulatorLimits,
        maximumRecentCodePoints: 32,
      },
    );

    terminal.write(bytes("AGENTSCOPE_PTY_COMPLETE\r\n"));
    terminal.write(bytes(`Password: ${"x".repeat(64)}`));

    expect(terminal.end().semanticState).toBe("credential-prompt");
  });

  it("accepts the exact bounded terminal controls emitted by the pinned Codex TUI", () => {
    const terminal = new BoundedTerminalEmulator({ columns: 80, rows: 24 });
    terminal.write(
      bytes(
        [
          "\u001b[6n",
          "\u001b]10;?\u001b\\",
          "\u001b]11;?\u001b\\",
          "\u001b[?u",
          "\u001b[c",
          "\u001b[?2004h",
          "\u001b[?1004h",
          "\u001b[?7l",
          "\u001b[>7u",
          "\u001b[?2026h",
          "\u001b7",
          "\u001b(B",
          "\u001bD",
          "\u001bE",
          "\u001bM",
          "\u001b=",
          "\u001b>",
          "\u001b[12G",
          "\u001b[1J",
          "\u001b[3J",
          "\u001b[1K",
          "\u001b[r",
          "\u001b8",
          "\u001b[0 q",
          "\u001b[?2026l",
          "AGENTSCOPE_PTY_COMPLETE",
          "\u001b[<u",
          "\u001b[?7h",
          "\u001b[?1004l",
          "\u001b[?2004l",
        ].join(""),
      ),
    );

    expect(terminal.end()).toMatchObject({
      malformedControlCount: 0,
      semanticState: "completed",
      unsupportedControlCount: 0,
    });
    expect(decoder.decode(terminal.takeTerminalResponses())).toBe(
      [
        "\u001b[1;1R",
        "\u001b]10;rgb:ffff/ffff/ffff\u001b\\",
        "\u001b]11;rgb:0000/0000/0000\u001b\\",
        "\u001b[?0u",
        "\u001b[?1;2c",
      ].join(""),
    );
    expect(terminal.takeTerminalResponses()).toHaveLength(0);
  });

  it("classifies credential prompts without retaining their bytes", () => {
    const terminal = new BoundedTerminalEmulator({ columns: 80, rows: 24 });
    terminal.write(bytes("Please sign in\r\nPassword: "));
    const snapshot = terminal.end();
    expect(snapshot.semanticState).toBe("credential-prompt");
    expect(JSON.stringify(snapshot)).not.toContain("Password");
    expect(JSON.stringify(snapshot)).not.toContain("sign in");
  });

  it.each([
    "API token: ",
    "Access token: ",
    "Passphrase: ",
    "Username: ",
    "Email: ",
  ])("classifies the common credential prompt %s", (prompt) => {
    const terminal = new BoundedTerminalEmulator({ columns: 80, rows: 24 });
    terminal.write(bytes(`AGENTSCOPE_PTY_READY\r\n${prompt}`));
    const snapshot = terminal.end();
    expect(snapshot.semanticState).toBe("credential-prompt");
    expect(JSON.stringify(snapshot)).not.toContain(prompt.trim());
  });
});

// These cases share one bounded emulator fixture surface across all hostile inputs.
// eslint-disable-next-line max-lines-per-function
describe("bounded semantic terminal emulator adversarial inputs", () => {
  it("bounds malformed, incomplete, unsupported, and invalid UTF-8 controls", () => {
    const malformed = new BoundedTerminalEmulator(
      { columns: 10, rows: 2 },
      { ...defaultPtyTerminalEmulatorLimits, maximumControlBytes: 4 },
    );
    malformed.write(bytes("\u001b[12345"));
    expect(malformed.end()).toMatchObject({
      malformedControlCount: 1,
      semanticState: "malformed-control",
    });

    const unsupported = new BoundedTerminalEmulator({ columns: 10, rows: 2 });
    unsupported.write(bytes("\u001b[?9999hvalue"));
    expect(unsupported.end()).toMatchObject({
      semanticState: "malformed-control",
      unsupportedControlCount: 1,
    });

    const invalidUtf8 = new BoundedTerminalEmulator({ columns: 10, rows: 2 });
    expect(() => {
      invalidUtf8.write(new Uint8Array([0xff]));
    }).toThrowError(
      new BoundedTerminalEmulatorError("testkit.pty.emulator.utf8"),
    );
    expect(invalidUtf8.end().semanticState).toBe("malformed-control");
  });

  it("fails closed at the exact output ceiling and after terminal close", () => {
    const terminal = new BoundedTerminalEmulator(
      { columns: 10, rows: 2 },
      { ...defaultPtyTerminalEmulatorLimits, maximumOutputBytes: 4 },
    );
    terminal.write(bytes("1234"));
    expect(() => {
      terminal.write(bytes("5"));
    }).toThrowError(
      new BoundedTerminalEmulatorError("testkit.pty.emulator.output-limit"),
    );
    expect(terminal.end().semanticState).toBe("output-limit");
    expect(() => {
      terminal.write(bytes("x"));
    }).toThrowError(
      new BoundedTerminalEmulatorError("testkit.pty.emulator.ended"),
    );
    expect(() => {
      terminal.resize({ columns: 11, rows: 2 });
    }).toThrowError(
      new BoundedTerminalEmulatorError("testkit.pty.emulator.ended"),
    );
  });

  it("bounds generated terminal-query responses across drains", () => {
    const terminal = new BoundedTerminalEmulator(
      { columns: 10, rows: 2 },
      { ...defaultPtyTerminalEmulatorLimits, maximumOutputBytes: 16_384 },
    );
    for (let index = 0; index < 682; index += 1) {
      terminal.write(bytes("\u001b[6n"));
      terminal.takeTerminalResponses();
    }
    expect(() => {
      terminal.write(bytes("\u001b[6n"));
    }).toThrowError(
      new BoundedTerminalEmulatorError("testkit.pty.emulator.response-limit"),
    );
  });

  it("uses captured response byte and encoding authority", () => {
    const byteLengthDescriptor = Object.getOwnPropertyDescriptor(
      Buffer,
      "byteLength",
    )!;
    const encodeDescriptor = Object.getOwnPropertyDescriptor(
      TextEncoder.prototype,
      "encode",
    )!;
    const query = bytes("\u001b[6n");
    const terminal = new BoundedTerminalEmulator({ columns: 80, rows: 24 });
    terminal.write(query);
    Object.defineProperty(Buffer, "byteLength", {
      ...byteLengthDescriptor,
      value: () => 0,
    });
    Object.defineProperty(TextEncoder.prototype, "encode", {
      ...encodeDescriptor,
      value: () => new Uint8Array(5_000).fill(65),
    });
    let response: Uint8Array | undefined;
    try {
      response = terminal.takeTerminalResponses();
      const bounded = new BoundedTerminalEmulator({ columns: 80, rows: 24 });
      expect(() => {
        for (let index = 0; index < 683; index += 1) bounded.write(query);
      }).toThrowError(
        new BoundedTerminalEmulatorError("testkit.pty.emulator.response-limit"),
      );
    } finally {
      Object.defineProperty(Buffer, "byteLength", byteLengthDescriptor);
      Object.defineProperty(TextEncoder.prototype, "encode", encodeDescriptor);
    }
    expect(decoder.decode(response)).toBe("\u001b[1;1R");
  });

  it("rejects geometry, limits, and snapshots outside the closed schema", () => {
    expect(
      () => new BoundedTerminalEmulator({ columns: 0, rows: 24 }),
    ).toThrowError(
      new BoundedTerminalEmulatorError("testkit.pty.emulator.geometry"),
    );
    expect(
      () =>
        new BoundedTerminalEmulator(
          { columns: 80, rows: 24 },
          { ...defaultPtyTerminalEmulatorLimits, maximumCells: 1 },
        ),
    ).toThrowError(
      new BoundedTerminalEmulatorError("testkit.pty.emulator.geometry"),
    );

    const terminal = new BoundedTerminalEmulator({ columns: 80, rows: 24 });
    terminal.write(bytes("AGENTSCOPE_PTY_READY"));
    const snapshot = terminal.end();
    expect(validatePtyTerminalSemanticSnapshot(snapshot)).toEqual(snapshot);
    expect(validatePtyTerminalSemanticSnapshot(snapshot)).not.toBe(snapshot);
    expect(() =>
      validatePtyTerminalSemanticSnapshot({
        ...snapshot,
        screenSha256: "not-a-digest",
      }),
    ).toThrowError(new BoundedTerminalEmulatorError("testkit.pty.snapshot"));
    expect(() =>
      validatePtyTerminalSemanticSnapshot({ ...snapshot, raw: "forbidden" }),
    ).toThrowError(new BoundedTerminalEmulatorError("testkit.pty.snapshot"));
    let coercions = 0;
    expect(() =>
      validatePtyTerminalSemanticSnapshot({
        ...snapshot,
        screenSha256: {
          [Symbol.toPrimitive]: () => {
            coercions += 1;
            return snapshot.screenSha256;
          },
          toJSON: () => "synthetic-canary",
        },
      }),
    ).toThrowError(new BoundedTerminalEmulatorError("testkit.pty.snapshot"));
    expect(coercions).toBe(0);
  });

  it("rejects accessors and proxies before reading hostile values", () => {
    let reads = 0;
    const hostileGeometry = Object.defineProperty({}, "columns", {
      enumerable: true,
      get: () => {
        reads += 1;
        return 80;
      },
    });
    Object.defineProperty(hostileGeometry, "rows", {
      enumerable: true,
      value: 24,
    });
    expect(
      () => new BoundedTerminalEmulator(hostileGeometry as never),
    ).toThrowError(
      new BoundedTerminalEmulatorError("testkit.pty.emulator.geometry"),
    );
    expect(reads).toBe(0);
    expect(
      () =>
        new BoundedTerminalEmulator(
          new Proxy({ columns: 80, rows: 24 }, {}) as never,
        ),
    ).toThrowError(
      new BoundedTerminalEmulatorError("testkit.pty.emulator.geometry"),
    );
  });

  it("keeps memory bounded while scrolling and processing hostile tabs", () => {
    const terminal = new BoundedTerminalEmulator(
      { columns: 8, rows: 2 },
      { ...defaultPtyTerminalEmulatorLimits, maximumOutputBytes: 32_768 },
    );
    terminal.write(bytes(`${"x\t\r\n".repeat(2_000)}tail`));
    const snapshot = terminal.end();
    expect(snapshot.geometry).toEqual({ columns: 8, rows: 2 });
    expect(snapshot.printableCellCount).toBeLessThanOrEqual(16);
    expect(snapshot.outputBytes).toBeLessThanOrEqual(32_768);
  });

  it("processes the exact advertised byte ceiling and rejects overflow", async () => {
    expect(defaultPtyTerminalEmulatorLimits.maximumOutputBytes).toBe(1_048_576);
    const exactBoundaryLimits = {
      ...defaultPtyTerminalEmulatorLimits,
      maximumOutputBytes: 32_768,
    };
    const terminal = new BoundedTerminalEmulator(
      { columns: 80, rows: 24 },
      exactBoundaryLimits,
    );
    const payload = bytes("x".repeat(exactBoundaryLimits.maximumOutputBytes));
    terminal.write(payload);
    const snapshot = terminal.end();
    expect(snapshot.outputBytes).toBe(exactBoundaryLimits.maximumOutputBytes);

    const overflow = new BoundedTerminalEmulator(
      { columns: 80, rows: 24 },
      exactBoundaryLimits,
    );
    expect(() => {
      overflow.write(
        bytes("x".repeat(exactBoundaryLimits.maximumOutputBytes + 1)),
      );
    }).toThrowError(
      new BoundedTerminalEmulatorError("testkit.pty.emulator.output-limit"),
    );

    const originalConstructor = Object.getOwnPropertyDescriptor(
      globalThis,
      "Uint8Array",
    )!;
    const OriginalUint8Array = Uint8Array;
    const oversized = new OriginalUint8Array(8 * 1_048_576);
    let constructorCalls = 0;
    const guardedConstructor = new Proxy(OriginalUint8Array, {
      construct: () => {
        constructorCalls += 1;
        return new OriginalUint8Array(0);
      },
    });
    Object.defineProperty(globalThis, "Uint8Array", {
      ...originalConstructor,
      value: guardedConstructor,
    });
    let hostileError: unknown;
    try {
      vi.resetModules();
      const freshModule = await import("../bounded-terminal-emulator.js");
      const hostile = new freshModule.BoundedTerminalEmulator({
        columns: 80,
        rows: 24,
      });
      try {
        hostile.write(oversized);
      } catch (error) {
        hostileError = error;
      }
    } finally {
      Object.defineProperty(globalThis, "Uint8Array", originalConstructor);
    }
    expect(hostileError).toEqual(
      new BoundedTerminalEmulatorError("testkit.pty.emulator.output-limit"),
    );
    expect(constructorCalls).toBe(0);
  });

  it("decodes through captured authority after typed-array prototype mutation", () => {
    const typedArrayPrototype: object = Reflect.getPrototypeOf(
      Uint8Array.prototype,
    )!;
    const bufferDescriptor = Object.getOwnPropertyDescriptor(
      typedArrayPrototype,
      "buffer",
    )!;
    const byteLengthDescriptor = Object.getOwnPropertyDescriptor(
      typedArrayPrototype,
      "byteLength",
    )!;
    const terminal = new BoundedTerminalEmulator({ columns: 80, rows: 24 });
    const input = bytes("AGENTSCOPE_PTY_READY\r\nAccess token: ");
    Object.defineProperty(typedArrayPrototype, "buffer", {
      ...bufferDescriptor,
      get: () => {
        throw new Error("synthetic live buffer getter");
      },
    });
    Object.defineProperty(typedArrayPrototype, "byteLength", {
      ...byteLengthDescriptor,
      get: () => {
        throw new Error("synthetic live byteLength getter");
      },
    });
    let snapshot;
    try {
      terminal.write(input);
      snapshot = terminal.end();
    } finally {
      Object.defineProperty(typedArrayPrototype, "buffer", bufferDescriptor);
      Object.defineProperty(
        typedArrayPrototype,
        "byteLength",
        byteLengthDescriptor,
      );
    }
    expect(snapshot?.semanticState).toBe("credential-prompt");
  });

  it("does not invoke caller-controlled backing-buffer species authority", () => {
    let speciesCalls = 0;
    class HostileArrayBuffer extends ArrayBuffer {
      public constructor(_length: number) {
        speciesCalls += 1;
        super(8 * 1_048_576);
      }
    }
    const backing = new ArrayBuffer(1);
    const input = new Uint8Array(backing);
    input[0] = 120;
    Object.defineProperty(backing, "constructor", {
      configurable: true,
      value: { [Symbol.species]: HostileArrayBuffer },
    });
    const terminal = new BoundedTerminalEmulator({ columns: 80, rows: 24 });
    terminal.write(input);
    const snapshot = terminal.end();
    expect(snapshot.outputBytes).toBe(1);
    expect(speciesCalls).toBe(0);
  });

  it("does not dispatch screen or recent text through inherited numeric setters", () => {
    const prior = Object.getOwnPropertyDescriptor(Array.prototype, "0");
    let setterCalls = 0;
    Object.defineProperty(Array.prototype, "0", {
      configurable: true,
      set: () => {
        setterCalls += 1;
      },
    });
    let snapshot;
    try {
      const terminal = new BoundedTerminalEmulator({ columns: 80, rows: 24 });
      terminal.resize({ columns: 100, rows: 30 });
      terminal.write(bytes("x"));
      snapshot = terminal.end();
    } finally {
      if (prior === undefined) Reflect.deleteProperty(Array.prototype, "0");
      else Object.defineProperty(Array.prototype, "0", prior);
    }
    expect(setterCalls).toBe(0);
    expect(snapshot?.semanticState).toBe("active");
  });
});
