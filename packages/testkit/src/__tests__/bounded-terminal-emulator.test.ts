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

  it("retains observed semantic readiness across fixture alternate-screen exit", () => {
    const terminal = new BoundedTerminalEmulator({ columns: 80, rows: 24 });
    terminal.write(bytes("\u001b[?1049hAGENTSCOPE_PTY_READY\r\n"));
    expect(terminal.readinessObserved()).toBe(true);

    terminal.write(bytes("AGENTSCOPE_PTY_COMPLETE\u001b[?1049l\r\n"));
    expect(terminal.readinessObserved()).toBe(true);
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
    terminal.write(bytes("\u001b[?2026h[1m›[22m "));
    expect(terminal.readinessObserved()).toBe(false);
    terminal.write(bytes("fixture-model defaul"));
    expect(terminal.readinessObserved()).toBe(false);
    terminal.write(bytes("t\u001b[?2026l"));
    expect(terminal.readinessObserved()).toBe(true);
    expect(terminal.readinessObservationGeneration()).toBe(1);
    expect(terminal.challengedReadinessProgress()).toEqual({
      marker: true,
      synchronizedFrame: true,
      styledGlyph: true,
      requiredText: true,
      terminalProtocol: "complete",
      protocolRejectionKind: "none",
      protocolRejectedAtPhase: null,
      protocolRejectedStep: null,
      protocolRejectedModePrefix: null,
      protocolRejectedModeValue: null,
      readinessEverObserved: true,
      screenRevoked: false,
    });

    terminal.write(
      bytes(
        "\u001b[?2026h\u001b[1m›\u001b[22m \u0007fixture-model default\u001b[?2026l",
      ),
    );
    expect(terminal.readinessObservationGeneration()).toBe(1);
    terminal.write(
      bytes("\u001b[?2026h\u001b[1m›\u001b[22m unrelated\u001b[?2026l"),
    );
    expect(terminal.readinessObservationGeneration()).toBe(1);
    terminal.write(
      bytes(
        "\u001b[?2026h\u001b[H\u001b[1m›\u001b[22m \u001b[2mfixture-model default\u001b[22m\u001b[?2026l",
      ),
    );
    expect(terminal.readinessObserved()).toBe(true);
    expect(terminal.readinessObservationGeneration()).toBe(2);

    terminal.write(bytes("\u001b[2J"));
    expect(terminal.readinessObserved()).toBe(false);

    terminal.write(
      bytes(
        "\u001b[?2026h\u001b[H\u001b[1m›\u001b[22m \u001b[2mfixture-model default\u001b[?2026l",
      ),
    );
    expect(terminal.readinessObservationGeneration()).toBe(3);
    expect(terminal.readinessObserved()).toBe(true);
    terminal.write(bytes("\rX"));
    expect(terminal.readinessObserved()).toBe(false);
  });

  it("preserves Codex readiness across bounded color and italic rendition", () => {
    const challenge = "a".repeat(64);
    const createTerminal = () =>
      new BoundedTerminalEmulator(
        { columns: 100, rows: 30 },
        defaultPtyTerminalEmulatorLimits,
        {
          kind: "challenge-styled-text" as const,
          challenge,
          text: "›",
          requiredText: "Ask Codex to do anything",
          requiredTerminalProtocol: "csi-u-flags-7-query-v1" as const,
          bold: true,
          dim: false,
        },
      );
    const terminal = createTerminal();
    terminal.write(bytes(`AGENTSCOPE_PTY_READY:${challenge}\r\n`));
    terminal.write(
      bytes(
        "\u001b[>7u\u001b[6n\u001b]10;?\u001b\\\u001b]11;?\u001b\\\u001b[?u\u001b[c",
      ),
    );
    terminal.write(
      bytes(
        "\u001b[?2026h\u001b[48;5;234m \u001b[3mloading\u001b[23m \u001b[38;5;6;49m/model\u001b[39;49m\u001b[1m›\u001b[22m \u001b[2mAsk Codex to do anything\u001b[?2026l",
      ),
    );

    expect(terminal.readinessObserved()).toBe(true);
    expect(terminal.readinessObservationGeneration()).toBe(1);

    const malformedColor = createTerminal();
    malformedColor.write(bytes(`AGENTSCOPE_PTY_READY:${challenge}\r\n`));
    malformedColor.write(
      bytes(
        "\u001b[>7u\u001b[6n\u001b]10;?\u001b\\\u001b]11;?\u001b\\\u001b[?u\u001b[c\u001b[?2026h\u001b[38;5;256m\u001b[1m›\u001b[22m Ask Codex to do anything\u001b[?2026l",
      ),
    );
    expect(malformedColor.readinessObserved()).toBe(false);
    expect(malformedColor.readinessObservationGeneration()).toBe(0);
  });

  it.each([
    ["\u001b[6n", "order", 2],
    ["\u001b[>1u", "mode", null],
    ["\u001bc", "reset", null],
  ] as const)(
    "reports only the first closed terminal-protocol rejection for %s",
    (sequence, kind, step) => {
      const terminal = new BoundedTerminalEmulator(
        { columns: 100, rows: 30 },
        defaultPtyTerminalEmulatorLimits,
        {
          kind: "challenge-styled-text",
          challenge: "a".repeat(64),
          text: "›",
          requiredText: "Ask Codex to do anything",
          requiredTerminalProtocol: "csi-u-flags-7-query-v1",
          bold: true,
          dim: false,
        },
      );
      terminal.write(bytes(sequence));
      terminal.write(bytes("\u001b[>7u"));
      expect(terminal.challengedReadinessProgress()).toMatchObject({
        terminalProtocol: "rejected",
        protocolRejectionKind: kind,
        protocolRejectedAtPhase: 0,
        protocolRejectedStep: step,
        protocolRejectedModePrefix: kind === "mode" ? "greater" : null,
        protocolRejectedModeValue: kind === "mode" ? 1 : null,
        readinessEverObserved: false,
      });
    },
  );

  it("retains first post-readiness CSI-u rejection without terminal content", () => {
    const challenge = "a".repeat(64);
    const terminal = new BoundedTerminalEmulator(
      { columns: 100, rows: 30 },
      defaultPtyTerminalEmulatorLimits,
      {
        kind: "challenge-styled-text",
        challenge,
        text: "›",
        requiredText: "Ask Codex to do anything",
        requiredTerminalProtocol: "csi-u-flags-7-query-v1",
        bold: true,
        dim: false,
      },
    );
    terminal.write(bytes(`AGENTSCOPE_PTY_READY:${challenge}\r\n`));
    terminal.write(
      bytes(
        "\u001b[>7u\u001b[6n\u001b]10;?\u001b\\\u001b]11;?\u001b\\\u001b[?u\u001b[c\u001b[?2026h\u001b[1m›\u001b[22m \u001b[2mAsk Codex to do anything\u001b[?2026l",
      ),
    );
    expect(terminal.readinessObservationGeneration()).toBe(1);
    terminal.write(bytes("\u001b[<1u\u001b[>2u"));
    expect(terminal.challengedReadinessProgress()).toMatchObject({
      terminalProtocol: "rejected",
      protocolRejectionKind: "mode",
      protocolRejectedAtPhase: 6,
      protocolRejectedModePrefix: "less",
      protocolRejectedModeValue: 1,
      readinessEverObserved: true,
    });
  });

  it("derives readiness from an exact synchronized prompt after unrelated Unicode", () => {
    const challenge = "a".repeat(64);
    const terminal = new BoundedTerminalEmulator(
      { columns: 100, rows: 30 },
      defaultPtyTerminalEmulatorLimits,
      {
        kind: "challenge-styled-text" as const,
        challenge,
        text: "›",
        requiredText: "Ask Codex to do anything",
        requiredTerminalProtocol: "csi-u-flags-7-query-v1" as const,
        bold: true,
        dim: false,
      },
    );
    terminal.write(bytes(`AGENTSCOPE_PTY_READY:${challenge}\r\n`));
    terminal.write(bytes("\u001b[1;1H✓"));
    terminal.write(
      bytes(
        "\u001b[>7u\u001b[6n\u001b]10;?\u001b\\\u001b]11;?\u001b\\\u001b[?u\u001b[c",
      ),
    );
    terminal.write(
      bytes(
        "\u001b[?2026h\u001b[24;1H\u001b[1m›\u001b[22m \u001b[2mAsk Codex to do anything\u001b[?2026l",
      ),
    );

    expect(terminal.readinessObserved()).toBe(true);
    expect(terminal.readinessObservationGeneration()).toBe(1);
  });

  it("rejects readiness matchers without closed one-cell glyphs", () => {
    const challenge = "a".repeat(64);
    expect(
      () =>
        new BoundedTerminalEmulator(
          { columns: 40, rows: 8 },
          defaultPtyTerminalEmulatorLimits,
          {
            kind: "challenge-styled-text",
            challenge,
            text: "界",
            requiredText: "fixture-model default",
            requiredTerminalProtocol: "csi-u-flags-7-query-v1",
            bold: true,
            dim: false,
          },
        ),
    ).toThrowError(
      new BoundedTerminalEmulatorError("testkit.pty.emulator.readiness"),
    );
    expect(
      () =>
        new BoundedTerminalEmulator(
          { columns: 40, rows: 8 },
          defaultPtyTerminalEmulatorLimits,
          {
            kind: "challenge-styled-text",
            challenge,
            text: "›",
            requiredText: "fixture-model de\u0301fault",
            requiredTerminalProtocol: "csi-u-flags-7-query-v1",
            bold: true,
            dim: false,
          },
        ),
    ).toThrowError(
      new BoundedTerminalEmulatorError("testkit.pty.emulator.readiness"),
    );
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
    expect(earlyReadiness.readinessObserved()).toBe(false);
    earlyReadiness.write(bytes(`\u001b[>7u${queries}`));
    expect(earlyReadiness.readinessObserved()).toBe(true);
    expect(earlyReadiness.requiredTerminalProtocolReady()).toBe(true);

    const staleEarlyReadiness = terminal();
    staleEarlyReadiness.write(
      bytes(
        `AGENTSCOPE_PTY_READY:${challenge}\r\n\u001b[1m›\u001b[22m fixture-model default\u001b[2J`,
      ),
    );
    staleEarlyReadiness.write(bytes(`\u001b[>7u${queries}`));
    expect(staleEarlyReadiness.readinessObserved()).toBe(false);
    expect(staleEarlyReadiness.requiredTerminalProtocolReady()).toBe(true);

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

  it("counts complete synchronized redraws while the ready screen stays live", () => {
    const challenge = "a".repeat(64);
    const terminal = new BoundedTerminalEmulator(
      { columns: 100, rows: 30 },
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
        `AGENTSCOPE_PTY_READY:${challenge}\r\n\u001b[>7u\u001b[6n\u001b]10;?\u001b\\\u001b]11;?\u001b\\\u001b[?u\u001b[c`,
      ),
    );
    terminal.write(
      bytes(
        "\u001b[?2026h\u001b[1m›\u001b[22m fixture-model default\u001b[?2026l",
      ),
    );
    expect(terminal.readinessObservationGeneration()).toBe(1);
    terminal.write(
      bytes(
        "\u001b[?2026h\u001b[2J\u001b[H\u001b[1m›\u001b[22m fixture-model default prompt-rendered\u001b[?2026l",
      ),
    );
    expect(terminal.readinessObservationGeneration()).toBe(2);
    expect(terminal.readinessObserved()).toBe(true);
    terminal.write(
      bytes(
        "\u001b[?2026h\u001b[H\u001bM\u001b[H\u001b[1m›\u001b[22m fixture-model default\u001b[?2026l",
      ),
    );
    expect(terminal.readinessObservationGeneration()).toBe(3);
    expect(terminal.readinessObserved()).toBe(true);
    terminal.write(bytes("\u001b[?7l"));
    terminal.write(
      bytes(
        "\u001b[?2026h\u001b[100G\u001b[1m›\u001b[22m fixture-model default\u001b[?2026l",
      ),
    );
    expect(terminal.readinessObservationGeneration()).toBe(3);
    expect(terminal.readinessObserved()).toBe(false);
    terminal.write(bytes("\u001b[?7h"));
    terminal.write(
      bytes(
        "\u001b[?2026h\u001b[2J\u001b[H\u001b[1m›\u001b[22m fixture-model default\u001b[?2026l",
      ),
    );
    expect(terminal.readinessObservationGeneration()).toBe(4);
    expect(terminal.readinessObserved()).toBe(true);
    terminal.write(bytes("\u001b[?1049h\u001b[?1049l"));
    terminal.write(
      bytes(
        "\u001b[?2026h\u001b[2J\u001b[H\u001b[1m›\u001b[22m fixture-model default\u001b[?2026l",
      ),
    );
    expect(terminal.readinessObservationGeneration()).toBe(5);
    expect(terminal.readinessObserved()).toBe(true);
    terminal.write(
      bytes(
        "\u001b[?2026hstale\r\n\u001b[10;1H\u001b[1m›\u001b[22m \u001b[12;1Hfixture-model default\u001b[?2026l",
      ),
    );
    expect(terminal.readinessObservationGeneration()).toBe(6);
    expect(terminal.readinessObserved()).toBe(true);
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

  it("classifies post-submission idle evidence without exposing terminal content", () => {
    const challenge = "a".repeat(64);
    const response = `AGENTSCOPE_CODEX_RESPONSE:${challenge}`;
    const terminal = new BoundedTerminalEmulator(
      { columns: 100, rows: 8 },
      defaultPtyTerminalEmulatorLimits,
      {
        kind: "challenge-styled-text",
        challenge,
        text: "›",
        requiredText: "fixture-model default",
        postSubmissionResponseText: response,
        requiredTerminalProtocol: "csi-u-flags-7-query-v1",
        bold: true,
        dim: false,
      },
    );
    expect(terminal.postSubmissionIdleDiagnostic()).toBe("not-armed");
    terminal.write(
      bytes(
        "\u001b[>7u\u001b[6n\u001b]10;?\u001b\\\u001b]11;?\u001b\\\u001b[?u\u001b[c",
      ),
    );
    terminal.write(
      bytes(
        `AGENTSCOPE_PTY_READY:${challenge}\r\n\u001b[?2026h\u001b[2J\u001b[H\u001b[1m›\u001b[22m fixture-model default\u001b[?2026l`,
      ),
    );
    expect(terminal.readinessObserved()).toBe(true);
    terminal.armPostSubmissionIdleObservation();
    expect(terminal.postSubmissionIdleDiagnostic()).toBe(
      "response-not-observed",
    );
    expect(terminal.postSubmissionIdleAtTitleDiagnostic()).toBe(
      "title-not-observed",
    );
    terminal.write(
      bytes(`\u001b]2;AGENTSCOPE_PTY_COMPLETE:${challenge}\u001b\\`),
    );
    expect(terminal.completionObserved()).toBe(false);
    expect(terminal.readinessObserved()).toBe(true);
    terminal.write(bytes(response));
    expect(terminal.postSubmissionIdleDiagnostic()).toBe(
      "idle-frame-not-observed",
    );
    terminal.write(
      bytes("\u001b[?2026h\u001b[2J\u001b[Hprocessing\u001b[?2026l"),
    );
    expect(terminal.postSubmissionIdleDiagnostic()).toBe("idle-frame-rejected");
    terminal.write(
      bytes(
        "\u001b[?2026h\u001b[2J\u001b[H\u001b[1m›\u001b[22m fixture-model default\u001b[?2026l",
      ),
    );
    expect(terminal.postSubmissionIdleDiagnostic()).toBe("idle-ready");
    terminal.write(
      bytes(`\u001b]2;AGENTSCOPE_PTY_COMPLETE:${"b".repeat(64)}\u001b\\`),
    );
    expect(terminal.completionObserved()).toBe(false);
    terminal.write(
      bytes(`\u001b]2;AGENTSCOPE_PTY_COMPLETE:${challenge}\u001b`),
    );
    terminal.write(bytes("\\"));
    expect(terminal.completionObserved()).toBe(true);
    expect(terminal.snapshot().semanticState).toBe("completed");
    expect(terminal.postSubmissionIdlePromptObserved()).toBe(true);
    expect(terminal.postSubmissionIdleAtTitleDiagnostic()).toBe("idle-ready");
    terminal.write(bytes("\u001b[?2026h\u001b[2J\u001b[Hbusy\u001b[?2026l"));
    expect(terminal.postSubmissionIdleDiagnostic()).toBe(
      "idle-readiness-revoked",
    );
    expect(terminal.postSubmissionIdleAtTitleDiagnostic()).toBe("idle-ready");
    terminal.write(
      bytes(`\u001b]2;AGENTSCOPE_PTY_COMPLETE:${challenge}\u001b\\`),
    );
    expect(terminal.postSubmissionIdleAtTitleDiagnostic()).toBe("idle-ready");
  });

  it("latches the challenged title even after generic printable completion", () => {
    const challenge = "a".repeat(64);
    const terminal = new BoundedTerminalEmulator(
      { columns: 100, rows: 8 },
      defaultPtyTerminalEmulatorLimits,
      {
        kind: "challenge-styled-text",
        challenge,
        text: "›",
        requiredText: "fixture-model default",
        postSubmissionResponseText: `AGENTSCOPE_CODEX_RESPONSE:${challenge}`,
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
    terminal.write(bytes(`AGENTSCOPE_PTY_READY:${challenge}`));
    terminal.armPostSubmissionIdleObservation();
    terminal.write(bytes(`AGENTSCOPE_CODEX_RESPONSE:${challenge}`));
    terminal.write(bytes("AGENTSCOPE_PTY_COMPLETE"));
    expect(terminal.completionObserved()).toBe(true);
    expect(terminal.postSubmissionIdleAtTitleDiagnostic()).toBe(
      "title-not-observed",
    );
    terminal.write(
      bytes(
        "\u001b[?2026h\u001b[2J\u001b[H\u001b[1m›\u001b[22m fixture-model default\u001b[?2026l",
      ),
    );
    expect(terminal.postSubmissionIdleDiagnostic()).toBe("idle-ready");
    Object.defineProperty(terminal, "postSubmissionIdleDiagnostic", {
      value: () => {
        throw new Error("substituted-public-diagnostic");
      },
    });
    terminal.write(
      bytes(`\u001b]2;AGENTSCOPE_PTY_COMPLETE:${challenge}\u001b\\`),
    );
    expect(terminal.postSubmissionIdleAtTitleDiagnostic()).toBe("idle-ready");
  });

  it("classifies fixed readiness losses at the exact challenged title", () => {
    const challenge = "a".repeat(64);
    for (const [mutation, category] of [
      [
        "\u001b[?2026h\u001b[2J\u001b[Hbusy\u001b[?2026l",
        "idle-revoked-screen",
      ],
      ["\u001b[?1049h", "idle-revoked-alternate-screen-enter"],
      ["\u001b[?1049l", "idle-revoked-alternate-screen-exit"],
      ["\u001b[?7h", "idle-revoked-autowrap-enable"],
      ["\u001b[?7l", "idle-revoked-autowrap-disable"],
      ["\u001b[;8r", "idle-revoked-scroll-region"],
      ["\u001b[0;8r", "idle-revoked-scroll-region"],
      ["\u001b[7;7r", "idle-revoked-scroll-region"],
      ["\u001b[?6h\u001b[r", "idle-revoked-scroll-region"],
      ["\u001b[@", "idle-revoked-screen-edit"],
    ] as const) {
      const terminal = new BoundedTerminalEmulator(
        { columns: 100, rows: 8 },
        defaultPtyTerminalEmulatorLimits,
        {
          kind: "challenge-styled-text",
          challenge,
          text: "›",
          requiredText: "fixture-model default",
          postSubmissionResponseText: `AGENTSCOPE_CODEX_RESPONSE:${challenge}`,
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
      terminal.write(bytes(`AGENTSCOPE_PTY_READY:${challenge}`));
      terminal.armPostSubmissionIdleObservation();
      terminal.write(bytes(`AGENTSCOPE_CODEX_RESPONSE:${challenge}`));
      terminal.write(
        bytes(
          "\u001b[?2026h\u001b[2J\u001b[H\u001b[1m›\u001b[22m fixture-model default\u001b[?2026l",
        ),
      );
      expect(terminal.postSubmissionIdlePromptObserved()).toBe(true);
      terminal.write(bytes(mutation));
      terminal.write(
        bytes(`\u001b]2;AGENTSCOPE_PTY_COMPLETE:${challenge}\u001b\\`),
      );
      expect(terminal.postSubmissionIdleAtTitleDiagnostic()).toBe(category);
    }
  });

  it("models a canonical full-height scroll-region reset without losing the idle screen", () => {
    const challenge = "a".repeat(64);
    for (const reset of ["\u001b[r", "\u001b[1r", "\u001b[1;8r"]) {
      const terminal = new BoundedTerminalEmulator(
        { columns: 100, rows: 8 },
        defaultPtyTerminalEmulatorLimits,
        {
          kind: "challenge-styled-text",
          challenge,
          text: "›",
          requiredText: "fixture-model default",
          postSubmissionResponseText: `AGENTSCOPE_CODEX_RESPONSE:${challenge}`,
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
      terminal.write(bytes(`AGENTSCOPE_PTY_READY:${challenge}`));
      terminal.armPostSubmissionIdleObservation();
      terminal.write(bytes(`AGENTSCOPE_CODEX_RESPONSE:${challenge}`));
      terminal.write(
        bytes(
          "\u001b[?2026h\u001b[2J\u001b[H\u001b[1m›\u001b[22m fixture-model default\u001b[?2026l",
        ),
      );
      expect(terminal.postSubmissionIdleDiagnostic()).toBe("idle-ready");
      terminal.write(bytes(reset));
      expect(terminal.snapshot().cursor).toEqual({ column: 0, row: 0 });
      terminal.resize({ columns: 100, rows: 9 });
      expect(terminal.postSubmissionIdleDiagnostic()).toBe("idle-ready");
      terminal.write(
        bytes(`\u001b]2;AGENTSCOPE_PTY_COMPLETE:${challenge}\u001b\\`),
      );
      expect(terminal.postSubmissionIdleAtTitleDiagnostic()).toBe("idle-ready");
      terminal.write(bytes("x"));
      expect(terminal.readinessObserved()).toBe(false);
    }
  });

  it("models a bounded partial scroll region without moving cells outside it", () => {
    const challenge = "a".repeat(64);
    const terminal = new BoundedTerminalEmulator(
      { columns: 100, rows: 8 },
      defaultPtyTerminalEmulatorLimits,
      {
        kind: "challenge-styled-text",
        challenge,
        text: "›",
        requiredText: "fixture-model default",
        postSubmissionResponseText: `AGENTSCOPE_CODEX_RESPONSE:${challenge}`,
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
    terminal.write(bytes(`AGENTSCOPE_PTY_READY:${challenge}`));
    terminal.armPostSubmissionIdleObservation();
    terminal.write(bytes(`AGENTSCOPE_CODEX_RESPONSE:${challenge}`));
    terminal.write(
      bytes(
        "\u001b[?2026h\u001b[2J\u001b[H\u001b[1m›\u001b[22m fixture-model default\u001b[?2026l",
      ),
    );
    expect(terminal.postSubmissionIdleDiagnostic()).toBe("idle-ready");
    terminal.write(bytes("\u001b[2;7r"));
    expect(terminal.snapshot().cursor).toEqual({ column: 0, row: 0 });
    terminal.write(bytes("\u001b[2;1Htransient\u001b[7;1H\n"));
    terminal.write(
      bytes(`\u001b]2;AGENTSCOPE_PTY_COMPLETE:${challenge}\u001b\\`),
    );
    expect(terminal.postSubmissionIdleAtTitleDiagnostic()).toBe("idle-ready");
    terminal.write(bytes("\u001b[H"));

    const withoutTransient = new BoundedTerminalEmulator(
      { columns: 100, rows: 8 },
      defaultPtyTerminalEmulatorLimits,
      { kind: "semantic-marker" },
    );
    withoutTransient.write(
      bytes("\u001b[1m›\u001b[22m fixture-model default\u001b[2;7r"),
    );
    expect(terminal.snapshot().screenSha256).toBe(
      withoutTransient.snapshot().screenSha256,
    );
    terminal.resize({ columns: 100, rows: 9 });
    expect(terminal.postSubmissionIdleDiagnostic()).toBe(
      "idle-readiness-revoked",
    );
  });

  it("requires a fresh complete synchronized prompt after a scroll reset inside a frame", () => {
    const challenge = "a".repeat(64);
    const terminal = new BoundedTerminalEmulator(
      { columns: 100, rows: 8 },
      defaultPtyTerminalEmulatorLimits,
      {
        kind: "challenge-styled-text",
        challenge,
        text: "›",
        requiredText: "fixture-model default",
        postSubmissionResponseText: `AGENTSCOPE_CODEX_RESPONSE:${challenge}`,
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
    terminal.write(bytes(`AGENTSCOPE_PTY_READY:${challenge}`));
    terminal.armPostSubmissionIdleObservation();
    terminal.write(bytes(`AGENTSCOPE_CODEX_RESPONSE:${challenge}`));
    terminal.write(
      bytes(
        "\u001b[?2026h\u001b[2J\u001b[H\u001b[1m›\u001b[22m fixture-model default\u001b[r\u001b[?2026l",
      ),
    );
    expect(terminal.postSubmissionIdleDiagnostic()).toBe("idle-frame-rejected");
    terminal.write(
      bytes(
        "\u001b[?2026h\u001b[2J\u001b[H\u001b[1m›\u001b[22m fixture-model default\u001b[?2026l",
      ),
    );
    expect(terminal.postSubmissionIdleDiagnostic()).toBe("idle-ready");
  });

  it("models in-frame line breaks only while the proved idle screen survives", () => {
    const challenge = "a".repeat(64);
    const title = `\u001b]2;AGENTSCOPE_PTY_COMPLETE:${challenge}\u001b\\`;
    const readyTerminal = () => {
      const terminal = new BoundedTerminalEmulator(
        { columns: 100, rows: 8 },
        defaultPtyTerminalEmulatorLimits,
        {
          kind: "challenge-styled-text",
          challenge,
          text: "›",
          requiredText: "fixture-model default",
          postSubmissionResponseText: `AGENTSCOPE_CODEX_RESPONSE:${challenge}`,
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
      terminal.write(bytes(`AGENTSCOPE_PTY_READY:${challenge}`));
      terminal.armPostSubmissionIdleObservation();
      terminal.write(bytes(`AGENTSCOPE_CODEX_RESPONSE:${challenge}`));
      terminal.write(
        bytes(
          "\u001b[?2026h\u001b[2J\u001b[H\u001b[1m›\u001b[22m fixture-model default\u001b[?2026l",
        ),
      );
      expect(terminal.postSubmissionIdleDiagnostic()).toBe("idle-ready");
      return terminal;
    };

    const unchanged = readyTerminal();
    unchanged.write(bytes("\u001b[?2026h\r\n\u001b[?2026l"));
    unchanged.write(bytes(title));
    expect(unchanged.postSubmissionIdleAtTitleDiagnostic()).toBe("idle-ready");

    const scrolled = readyTerminal();
    scrolled.write(bytes("\u001b[8;1H\u001b[?2026h\n\u001b[?2026l"));
    scrolled.write(bytes(title));
    expect(scrolled.postSubmissionIdleAtTitleDiagnostic()).toBe(
      "idle-revoked-screen",
    );
  });

  it("does not stitch a fresh prompt witness across an in-frame line break", () => {
    const challenge = "a".repeat(64);
    for (const lineBreak of ["\r", "\n"]) {
      const terminal = new BoundedTerminalEmulator(
        { columns: 100, rows: 8 },
        defaultPtyTerminalEmulatorLimits,
        {
          kind: "challenge-styled-text",
          challenge,
          text: "›",
          requiredText: "fixture-model default",
          postSubmissionResponseText: `AGENTSCOPE_CODEX_RESPONSE:${challenge}`,
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
      terminal.write(bytes(`AGENTSCOPE_PTY_READY:${challenge}`));
      terminal.armPostSubmissionIdleObservation();
      terminal.write(bytes(`AGENTSCOPE_CODEX_RESPONSE:${challenge}`));
      terminal.write(
        bytes(
          `\u001b[?2026h\u001b[2J\u001b[H\u001b[1m›\u001b[22m fixture-model default${lineBreak}\u001b[?2026l`,
        ),
      );
      expect(terminal.postSubmissionIdleDiagnostic()).toBe(
        "idle-frame-rejected",
      );
      terminal.write(
        bytes(
          "\u001b[?2026h\u001b[2J\u001b[H\u001b[1m›\u001b[22m fixture-model default\u001b[?2026l",
        ),
      );
      expect(terminal.postSubmissionIdleDiagnostic()).toBe("idle-ready");
    }
  });

  it("admits only pinned one-cell Codex status glyphs beside a live prompt", () => {
    const challenge = "a".repeat(64);
    const readyTerminal = () => {
      const terminal = new BoundedTerminalEmulator(
        { columns: 100, rows: 8 },
        defaultPtyTerminalEmulatorLimits,
        {
          kind: "challenge-styled-text",
          challenge,
          text: "›",
          requiredText: "fixture-model default",
          postSubmissionResponseText: `AGENTSCOPE_CODEX_RESPONSE:${challenge}`,
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
      terminal.write(bytes(`AGENTSCOPE_PTY_READY:${challenge}`));
      terminal.armPostSubmissionIdleObservation();
      terminal.write(bytes(`AGENTSCOPE_CODEX_RESPONSE:${challenge}`));
      terminal.write(
        bytes(
          "\u001b[?2026h\u001b[2J\u001b[H\u001b[1m›\u001b[22m fixture-model default\u001b[?2026l",
        ),
      );
      expect(terminal.postSubmissionIdleDiagnostic()).toBe("idle-ready");
      return terminal;
    };
    const title = `\u001b]2;AGENTSCOPE_PTY_COMPLETE:${challenge}\u001b\\`;
    const pinned = readyTerminal();
    pinned.write(bytes("\u001b[2;1H…•└✗"));
    expect(pinned.snapshot().cursor).toEqual({ column: 4, row: 1 });
    pinned.write(bytes(title));
    expect(pinned.postSubmissionIdleAtTitleDiagnostic()).toBe("idle-ready");

    const unknown = readyTerminal();
    unknown.write(bytes("\u001b[2;1H界"));
    unknown.write(bytes(title));
    expect(unknown.postSubmissionIdleAtTitleDiagnostic()).toBe(
      "idle-revoked-untrusted-cell",
    );
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
