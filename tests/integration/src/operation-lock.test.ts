import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { Server } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { acquireIntegrationOperationLock } from "../operation-lock.mjs";

const operationLockModule = pathToFileURL(
  resolve(import.meta.dirname, "../operation-lock.mjs"),
).href;
const roots: string[] = [];
const createRoot = () => {
  const root = mkdtempSync(resolve(tmpdir(), "agentscope-operation-lock-"));
  roots.push(root);
  return root;
};
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { force: true, recursive: true });
});

describe("integration operation lock", () => {
  it("waits for the current kernel-owned lease and then acquires", async () => {
    const root = createRoot();
    const releaseFirst = await acquireIntegrationOperationLock(
      root,
      "integration.lock.handoff",
    );
    const secondAcquisition = acquireIntegrationOperationLock(
      root,
      "integration.lock.handoff",
    );
    let secondState = "waiting";
    void secondAcquisition.then(
      () => {
        secondState = "acquired";
      },
      () => {
        secondState = "rejected";
      },
    );
    await Promise.resolve();
    expect(secondState).toBe("waiting");
    await releaseFirst();
    const releaseSecond = await secondAcquisition;
    expect(secondState).toBe("acquired");
    await releaseSecond();
  });

  it("returns one stable timeout without stealing the live lease", async () => {
    const root = createRoot();
    const releaseFirst = await acquireIntegrationOperationLock(
      root,
      "integration.lock.timeout",
    );
    let failure: unknown;
    try {
      await acquireIntegrationOperationLock(root, "integration.lock.timeout", {
        maximumWaitMilliseconds: 25,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: "ETIMEDOUT",
      message: "integration.lock.timeout",
    });
    await releaseFirst();
    const releaseAfterTimeout = await acquireIntegrationOperationLock(
      root,
      "integration.lock.timeout",
    );
    await releaseAfterTimeout();
  });

  it("reclaims the lease through kernel release after owner death", async () => {
    const root = createRoot();
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const { acquireIntegrationOperationLock } = await import(${JSON.stringify(operationLockModule)}); await acquireIntegrationOperationLock(${JSON.stringify(root)}, "integration.lock.owner-death"); process.stdout.write("ready\\n"); setInterval(() => {}, 1000);`,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    try {
      if (child.stdout === null)
        throw new Error("integration.lock.owner-death");
      await once(child.stdout, "data");
      const waiting = acquireIntegrationOperationLock(
        root,
        "integration.lock.owner-death",
      );
      child.kill("SIGKILL");
      await once(child, "exit");
      const release = await waiting;
      await release();
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await once(child, "exit");
      }
    }
  });

  it("serializes repeated concurrent contenders without retry", async () => {
    const root = createRoot();
    const entered: number[] = [];
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        (async () => {
          const release = await acquireIntegrationOperationLock(
            root,
            `integration.lock.concurrent.${index}`,
          );
          entered.push(index);
          await release();
        })(),
      ),
    );
    expect(new Set(entered).size).toBe(8);
  });
});

describe("integration operation lock shared release settlement", () => {
  it("makes every release caller join the same pending settlement", async () => {
    const root = createRoot();
    const release = await acquireIntegrationOperationLock(
      root,
      "integration.lock.shared-release",
    );
    const close = Object.getOwnPropertyDescriptor(Server.prototype, "close")
      ?.value as Server["close"] | undefined;
    if (close === undefined) throw new Error("integration.lock.close-method");
    let finishClose: (() => void) | undefined;
    const closeSpy = vi
      .spyOn(Server.prototype, "close")
      .mockImplementation(function (
        this: Server,
        callback?: Parameters<Server["close"]>[0],
      ) {
        finishClose = () => {
          Reflect.apply(close, this, [callback]);
        };
        return this;
      });
    try {
      const firstRelease = release();
      const secondRelease = release();
      expect(secondRelease).toBe(firstRelease);
      let settlement = "waiting";
      void secondRelease.then(
        () => {
          settlement = "resolved";
        },
        () => {
          settlement = "rejected";
        },
      );
      await Promise.resolve();
      expect(settlement).toBe("waiting");
      closeSpy.mockRestore();
      if (finishClose === undefined)
        throw new Error("integration.lock.close-settlement");
      finishClose();
      await Promise.all([firstRelease, secondRelease]);
      expect(settlement).toBe("resolved");
    } finally {
      closeSpy.mockRestore();
    }
  });
});

describe("integration operation lock release failure", () => {
  it("shares one release failure with every caller", async () => {
    const root = createRoot();
    const release = await acquireIntegrationOperationLock(
      root,
      "integration.lock.shared-release-failure",
    );
    const close = Object.getOwnPropertyDescriptor(Server.prototype, "close")
      ?.value as Server["close"] | undefined;
    if (close === undefined) throw new Error("integration.lock.close-method");
    const closeSpy = vi
      .spyOn(Server.prototype, "close")
      .mockImplementation(function (
        this: Server,
        callback?: Parameters<Server["close"]>[0],
      ) {
        return Reflect.apply(close, this, [
          () => callback?.(new Error("synthetic close failure")),
        ]);
      });
    try {
      const firstRelease = release();
      const secondRelease = release();
      expect(secondRelease).toBe(firstRelease);
      const [firstResult, secondResult] = await Promise.allSettled([
        firstRelease,
        secondRelease,
      ]);
      expect(firstResult.status).toBe("rejected");
      expect(secondResult.status).toBe("rejected");
      if (
        firstResult.status !== "rejected" ||
        secondResult.status !== "rejected"
      )
        throw new Error("integration.lock.release-result");
      expect(secondResult.reason).toBe(firstResult.reason);
      expect(firstResult.reason).toMatchObject({
        message: "integration.lock.shared-release-failure",
      });
    } finally {
      closeSpy.mockRestore();
    }
  });
});

describe("integration operation lock late waiter settlement", () => {
  it("joins a waiter accepted after release starts", async () => {
    const root = createRoot();
    const release = await acquireIntegrationOperationLock(
      root,
      "integration.lock.late-waiter",
    );
    let destroyed = false;
    const lateSocket = {
      destroy: () => {
        destroyed = true;
      },
      once: () => lateSocket,
    };
    const close = Object.getOwnPropertyDescriptor(Server.prototype, "close")
      ?.value as Server["close"] | undefined;
    if (close === undefined) throw new Error("integration.lock.close-method");
    const closeSpy = vi
      .spyOn(Server.prototype, "close")
      .mockImplementation(function (
        this: Server,
        callback?: Parameters<Server["close"]>[0],
      ) {
        queueMicrotask(() => this.emit("connection", lateSocket));
        return Reflect.apply(close, this, [callback]);
      });
    try {
      await release();
      expect(destroyed).toBe(true);
    } finally {
      closeSpy.mockRestore();
    }
  });
});
