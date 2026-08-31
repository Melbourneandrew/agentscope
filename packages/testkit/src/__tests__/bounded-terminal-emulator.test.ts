import { describe, expect, it } from "vitest";

import {
  BoundedTerminalEmulator,
  BoundedTerminalEmulatorError,
  defaultPtyTerminalEmulatorLimits,
  validatePtyTerminalSemanticSnapshot,
} from "../bounded-terminal-emulator.js";

const encoder = new TextEncoder();
const bytes = (value: string): Uint8Array => encoder.encode(value);

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

  it("classifies credential prompts without retaining their bytes", () => {
    const terminal = new BoundedTerminalEmulator({ columns: 80, rows: 24 });
    terminal.write(bytes("Please sign in\r\nPassword: "));
    const snapshot = terminal.end();
    expect(snapshot.semanticState).toBe("credential-prompt");
    expect(JSON.stringify(snapshot)).not.toContain("Password");
    expect(JSON.stringify(snapshot)).not.toContain("sign in");
  });
});

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
    expect(validatePtyTerminalSemanticSnapshot(snapshot)).toBe(snapshot);
    expect(() =>
      validatePtyTerminalSemanticSnapshot({
        ...snapshot,
        screenSha256: "not-a-digest",
      }),
    ).toThrowError(new BoundedTerminalEmulatorError("testkit.pty.snapshot"));
    expect(() =>
      validatePtyTerminalSemanticSnapshot({ ...snapshot, raw: "forbidden" }),
    ).toThrowError(new BoundedTerminalEmulatorError("testkit.pty.snapshot"));
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
});
