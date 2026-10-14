import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { types } from "node:util";
import { runInThisContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { verifyMockServerControlBoundary } from "../mockserver-control.mjs";

const readIntegration = (name: string) =>
  readFileSync(resolve(import.meta.dirname, "..", name), "utf8");
const controlSourceSection = (text: string, start: string, end: string) => {
  const first = text.indexOf(start),
    last = text.indexOf(end, first);
  expect(first).toBeGreaterThan(0);
  expect(last).toBeGreaterThan(first);
  return text.slice(first, last).replaceAll("export ", "");
};
type Control = Parameters<typeof verifyMockServerControlBoundary>[0];

// Actual transport and boundary composition with synthetic Node HTTP events;
// no network, service execution, post-handshake parser or renewed deadline.
const callbackUpgradeObservation = async (
  headBytes: number,
  mode:
    | "upgrade"
    | "wrong-status"
    | "no-upgrade"
    | "expired"
    | "join-refusal"
    | "timer" = "upgrade",
) => {
  const source = readIntegration("mockserver-control.mjs");
  const runner = readIntegration("run-scenarios.mjs");
  let clock = 0,
    ordinal = 0,
    timerCallback: (() => void) | undefined;
  const handles = {
    requestJoined: false,
    socketJoined: false,
    timerCleared: false,
    timerMilliseconds: 0,
  };
  const request = () => {
    const req = Object.assign(new EventEmitter(), {
      destroy() {
        handles.requestJoined = true;
        req.emit("close");
      },
      end() {
        queueMicrotask(() => {
          if (mode === "join-refusal") {
            req.destroy();
            return;
          }
          if (mode === "timer") {
            clock = 100;
            timerCallback!();
            return;
          }
          const socket = Object.assign(new EventEmitter(), {
            destroy() {
              queueMicrotask(() => {
                if (mode === "expired") clock = 100;
                handles.socketJoined = true;
                socket.emit("close");
              });
            },
          });
          req.emit(
            "upgrade",
            { statusCode: mode === "wrong-status" ? 200 : 101 },
            socket,
            Buffer.alloc(headBytes),
          );
        });
      },
    });
    return req;
  };
  const bindings = {
    Buffer,
    types,
    request,
    maximumBytes: 1024 * 1024,
    setTimeout: (callback: () => void, milliseconds: number) => {
      timerCallback = callback;
      handles.timerMilliseconds = milliseconds;
      return 1;
    },
    clearTimeout: () => {
      handles.timerCleared = true;
    },
  };
  const factory = runInThisContext(`(bindings) => {
    const {Buffer, types, request, maximumBytes, setTimeout, clearTimeout} = bindings;
    ${controlSourceSection(source, "const exchangeControlRequest =", "export const openMockServerControl =")}
    ${controlSourceSection(runner, "const observeBoundary =", "const controlBoundaryFailureObservation =")}
    return {exchangeControlRequest, observeBoundary};
  }`) as (input: typeof bindings) => {
    exchangeControlRequest(input: object): Promise<{ status: number }>;
    observeBoundary(control: Control, observation: object): Control;
  };
  const actual = factory(bindings),
    observation: { controlBoundary?: unknown } = {};
  const control = {
    send: async () =>
      ++ordinal === 3
        ? actual.exchangeControlRequest({
            host: "mockserver",
            method: "GET",
            path: "/_mockserver_callback_websocket",
            headers: {},
            bytes: Buffer.alloc(0),
            remaining: 100,
            deadline: 100,
            now: () => clock,
            upgrade: mode !== "no-upgrade",
          })
        : { status: 200 },
  };
  try {
    await verifyMockServerControlBoundary(
      actual.observeBoundary(control, observation),
    );
    return {
      outcome: "accepted",
      observation: observation.controlBoundary,
      handles,
      clock,
    };
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return {
      outcome: "rejected",
      code: (error as Error).message,
      observation: observation.controlBoundary,
      handles,
      clock,
    };
  }
};

describe("actual bounded callback upgrade transport", () => {
  it.each([0, 2, 1024 * 1024])(
    "accepts authenticated101 with %s bounded opaque head bytes only after joined closure",
    async (headBytes) => {
      const result = await callbackUpgradeObservation(headBytes);
      expect(result.outcome).toBe("accepted");
      expect(result.observation).toEqual({
        requestOrdinal: 4,
        refusal: "status",
        status: 200,
      });
      expect(result.handles).toEqual({
        requestJoined: true,
        socketJoined: true,
        timerCleared: true,
        timerMilliseconds: 100,
      });
      expect(result.clock).toBe(0);
    },
  );
  it.each([
    "wrong-status",
    "no-upgrade",
    "expired",
    "join-refusal",
    "timer",
  ] as const)(
    "refuses %s without renewing the original cutoff or advancing the boundary",
    async (mode) => {
      const result = await callbackUpgradeObservation(2, mode);
      expect(result.outcome).toBe("rejected");
      expect(result.code).toBe("integration.mockserver.control");
      expect(result.observation).toEqual({
        requestOrdinal: 3,
        refusal: "send",
        status: null,
      });
      expect(result.handles).toEqual({
        requestJoined: true,
        socketJoined: !["join-refusal", "timer"].includes(mode),
        timerCleared: true,
        timerMilliseconds: 100,
      });
      expect(result.clock).toBe(
        mode === "expired" || mode === "timer" ? 100 : 0,
      );
    },
  );
  it("refuses one byte beyond the existing output ceiling with every handle joined", async () => {
    const result = await callbackUpgradeObservation(1024 * 1024 + 1);
    expect(result.outcome).toBe("rejected");
    expect(result.code).toBe("integration.mockserver.control");
    expect(result.observation).toEqual({
      requestOrdinal: 3,
      refusal: "send",
      status: null,
    });
    expect(result.handles).toEqual({
      requestJoined: true,
      socketJoined: true,
      timerCleared: true,
      timerMilliseconds: 100,
    });
  });
});
