import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { createCredentialResolutionContext } from "@agentscope/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readHiddenCredentialForCli } from "./credential-input.js";

const fixture = (flowing: boolean | null = null, raw = false) => {
  const input = Object.assign(new EventEmitter(), {
    isTTY: true,
    isRaw: raw,
    readableFlowing: flowing,
    setRawMode(value: boolean) {
      this.isRaw = value;
      return this;
    },
    pause() {
      this.readableFlowing = false;
      return this;
    },
    resume() {
      this.readableFlowing = true;
      return this;
    },
  });
  const prompts: string[] = [];
  const output = Object.assign(new EventEmitter(), {
    isTTY: true,
    write(text: string, callback: (error?: Error) => void) {
      prompts.push(text);
      callback();
      return true;
    },
  });
  const abort = new AbortController();
  const context = createCredentialResolutionContext(
    "hook-equivalent",
    abort.signal,
    performance.now() + 100,
  );
  const read = () =>
    readHiddenCredentialForCli(
      "secret-key",
      context,
      input as unknown as NonNullable<
        Parameters<typeof readHiddenCredentialForCli>[2]
      >,
      output as unknown as NonNullable<
        Parameters<typeof readHiddenCredentialForCli>[3]
      >,
    );
  return { input, output, prompts, abort, context, read };
};
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("hidden bounded credential input", () => {
  it.each([null, false, true])(
    "never echoes input and restores original %s flow",
    async (flow) => {
      const value = fixture(flow);
      const pending = value.read();
      expect(value.input.isRaw).toBe(true);
      value.input.emit("data", Buffer.from("private-canary\r"));
      expect(await pending).toBe("private-canary");
      expect(value.prompts).toEqual(["secret-key: "]);
      expect(value.input.isRaw).toBe(false);
      expect(value.input.readableFlowing).toBe(flow === true);
      expect(value.input.eventNames()).toEqual([]);
      expect(value.output.eventNames()).toEqual([]);
    },
  );
  it("restores preexisting raw mode and removes only owned listeners", async () => {
    const value = fixture(false, true);
    const listener = () => undefined;
    value.input.on("end", listener);
    const pending = value.read();
    value.input.emit("data", Buffer.from("secret\n"));
    await pending;
    expect(value.input.isRaw).toBe(true);
    expect(value.input.listeners("end")).toEqual([listener]);
  });
  it.each([
    "eof",
    "close",
    "error",
    "abort",
    "interrupt",
    "overflow",
    "invalid-utf8",
    "multiple-lines",
  ])("refuses %s without secret/error output", async (mode) => {
    const value = fixture();
    const rejection = expect(value.read()).rejects.toThrow(
      "cli.credential-input.unavailable",
    );
    if (mode === "eof") value.input.emit("end");
    if (mode === "close") value.input.emit("close");
    if (mode === "error")
      value.input.emit("error", new Error("private-canary"));
    if (mode === "abort") value.abort.abort();
    if (mode === "interrupt") value.input.emit("data", Buffer.from([3]));
    if (mode === "overflow") value.input.emit("data", Buffer.alloc(8193, 65));
    if (mode === "invalid-utf8")
      value.input.emit("data", Buffer.from([255, 13]));
    if (mode === "multiple-lines")
      value.input.emit("data", Buffer.from("secret\rsecond\r"));
    await rejection;
    expect(value.input.isRaw).toBe(false);
    expect(value.input.eventNames()).toEqual([]);
    expect(value.prompts).toEqual(["secret-key: "]);
  });
  it("uses the original expiry with no activity-based reset", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const value = fixture();
    const rejection = expect(value.read()).rejects.toThrow(
      "cli.credential-input.unavailable",
    );
    await vi.advanceTimersByTimeAsync(80);
    value.input.emit("data", Buffer.from("partial-private"));
    await vi.advanceTimersByTimeAsync(20);
    await rejection;
    expect(value.input.isRaw).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("rejects non-TTY and already-aborted input before mode or prompt writes", async () => {
    const value = fixture();
    value.input.isTTY = false;
    await expect(value.read()).rejects.toThrow(
      "cli.credential-input.unavailable",
    );
    value.input.isTTY = true;
    value.abort.abort();
    await expect(value.read()).rejects.toThrow(
      "cli.credential-input.unavailable",
    );
    expect(value.prompts).toEqual([]);
    expect(value.input.eventNames()).toEqual([]);
  });
  it("erases a complete multibyte code point without echoing it", async () => {
    const value = fixture();
    const pending = value.read();
    value.input.emit("data", Buffer.from("aé\u007fb\r"));
    expect(await pending).toBe("ab");
    expect(value.prompts).toEqual(["secret-key: "]);
  });
  it("refuses success if raw-mode restoration throws", async () => {
    const value = fixture();
    const mode = value.input.setRawMode.bind(value.input);
    vi.spyOn(value.input, "setRawMode").mockImplementation((raw) => {
      if (!raw) throw new Error("private-canary");
      return mode(raw);
    });
    const rejection = expect(value.read()).rejects.toThrow(
      "cli.credential-input.unavailable",
    );
    value.input.emit("data", Buffer.from("secret\r"));
    await rejection;
    expect(value.prompts).toEqual(["secret-key: "]);
  });
});

describe("hidden input byte and setup refusals", () => {
  it("rejects expiry between entry and setup without raw-mode enablement or prompt", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const value = fixture();
    const raw = vi.spyOn(value.input, "setRawMode");
    vi.spyOn(performance, "now")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValue(101);
    await expect(value.read()).rejects.toThrow(
      "cli.credential-input.unavailable",
    );
    expect(raw).not.toHaveBeenCalledWith(true);
    expect(value.prompts).toEqual([]);
    expect(value.input.eventNames()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("accepts exactly the fixed byte ceiling without echoing bytes", async () => {
    const value = fixture();
    const pending = value.read();
    value.input.emit("data", Buffer.from(`${"a".repeat(8192)}\r\n`));
    expect((await pending).length).toBe(8192);
    expect(value.prompts).toEqual(["secret-key: "]);
  });
  it.each([
    "empty",
    "nul",
    "control",
    "proxy",
    "oversized-chunk",
    "write-throw",
    "raw-throw",
  ])("refuses %s and restores the input boundary", async (mode) => {
    const value = fixture();
    let traps = 0;
    if (mode === "write-throw")
      vi.spyOn(value.output, "write").mockImplementation(() => {
        throw new Error("private-canary");
      });
    if (mode === "raw-throw") {
      const original = value.input.setRawMode.bind(value.input);
      vi.spyOn(value.input, "setRawMode").mockImplementation((raw) => {
        if (raw) throw new Error("private-canary");
        return original(raw);
      });
    }
    const rejection = expect(value.read()).rejects.toThrow(
      "cli.credential-input.unavailable",
    );
    if (mode === "empty") value.input.emit("data", Buffer.from("\r"));
    if (mode === "nul") value.input.emit("data", Buffer.from([0]));
    if (mode === "control") value.input.emit("data", Buffer.from([1]));
    if (mode === "proxy")
      value.input.emit(
        "data",
        new Proxy(Buffer.from("secret"), {
          get() {
            traps += 1;
            throw new Error("private-canary");
          },
        }),
      );
    if (mode === "oversized-chunk")
      value.input.emit("data", Buffer.alloc(8195, 65));
    await rejection;
    expect(traps).toBe(0);
    expect(value.input.isRaw).toBe(false);
    expect(value.input.eventNames()).toEqual([]);
    expect(value.output.eventNames()).toEqual([]);
  });
});

describe("hidden input prompt output settlement", () => {
  it("refuses a successful prompt callback that crosses expiry before timer delivery", async () => {
    const value = fixture();
    let complete: ((error?: Error) => void) | undefined;
    vi.spyOn(value.output, "write").mockImplementation((_text, callback) => {
      complete = callback;
      return true;
    });
    const resume = vi.spyOn(value.input, "resume");
    const rejection = expect(value.read()).rejects.toThrow(
      "cli.credential-input.unavailable",
    );
    vi.spyOn(performance, "now").mockReturnValue(
      value.context.expiresAtMonotonicMilliseconds! + 1,
    );
    complete!();
    await rejection;
    expect(resume).not.toHaveBeenCalled();
    expect(value.input.isRaw).toBe(false);
    expect(value.input.eventNames()).toEqual([]);
  });
  it("observes a real pending write failure after input cancellation", async () => {
    const value = fixture();
    let failWrite: ((error?: Error | null) => void) | undefined;
    const output = Object.assign(
      new Writable({
        write(_chunk, _encoding, callback) {
          failWrite = callback;
        },
      }),
      { isTTY: true },
    );
    const rejected = expect(
      readHiddenCredentialForCli(
        "secret-key",
        value.context,
        value.input as unknown as NonNullable<
          Parameters<typeof readHiddenCredentialForCli>[2]
        >,
        output as unknown as NonNullable<
          Parameters<typeof readHiddenCredentialForCli>[3]
        >,
      ),
    ).rejects.toThrow("cli.credential-input.unavailable");
    value.abort.abort();
    await rejected;
    failWrite!(new Error("private-canary"));
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(output.listenerCount("error")).toBe(0);
    expect(value.input.isRaw).toBe(false);
  });
  it("handles a real Writable's asynchronous callback/error ordering", async () => {
    const value = fixture();
    const output = Object.assign(
      new Writable({
        write(_chunk, _encoding, callback) {
          setImmediate(() => {
            callback(new Error("private-canary"));
          });
        },
      }),
      { isTTY: true },
    );
    await expect(
      readHiddenCredentialForCli(
        "secret-key",
        value.context,
        value.input as unknown as NonNullable<
          Parameters<typeof readHiddenCredentialForCli>[2]
        >,
        output as unknown as NonNullable<
          Parameters<typeof readHiddenCredentialForCli>[3]
        >,
      ),
    ).rejects.toThrow("cli.credential-input.unavailable");
    expect(value.input.isRaw).toBe(false);
    expect(output.listenerCount("error")).toBe(0);
  });
});

describe("hidden input prompt readiness", () => {
  it("does not resume input until the prompt write completes", async () => {
    const value = fixture();
    let complete: ((error?: Error) => void) | undefined;
    vi.spyOn(value.output, "write").mockImplementation((_text, callback) => {
      complete = callback;
      return true;
    });
    const pending = value.read();
    expect(value.input.readableFlowing).toBe(false);
    complete!();
    expect(value.input.readableFlowing).toBe(true);
    value.input.emit("data", Buffer.from("secret\r"));
    expect(await pending).toBe("secret");
  });
  it("observes a failed prompt callback and subsequent error even after expiry", async () => {
    const value = fixture();
    let complete: ((error?: Error) => void) | undefined;
    vi.spyOn(value.output, "write").mockImplementation((_text, callback) => {
      complete = callback;
      return true;
    });
    const rejection = expect(value.read()).rejects.toThrow(
      "cli.credential-input.unavailable",
    );
    value.abort.abort();
    await rejection;
    complete!(new Error("private-canary"));
    expect(() =>
      value.output.emit("error", new Error("private-canary")),
    ).not.toThrow();
    await Promise.resolve();
    expect(value.output.eventNames()).toEqual([]);
    expect(value.input.isRaw).toBe(false);
  });
  it("contains a delayed resume exception and restores paused input", async () => {
    const value = fixture();
    let complete: ((error?: Error) => void) | undefined;
    vi.spyOn(value.output, "write").mockImplementation((_text, callback) => {
      complete = callback;
      return true;
    });
    const rejection = expect(value.read()).rejects.toThrow(
      "cli.credential-input.unavailable",
    );
    vi.spyOn(value.input, "resume").mockImplementation(() => {
      throw new Error("private-canary");
    });
    expect(() => {
      complete!();
    }).not.toThrow();
    await rejection;
    expect(value.input.isRaw).toBe(false);
    expect(value.input.readableFlowing).toBe(false);
  });
});
