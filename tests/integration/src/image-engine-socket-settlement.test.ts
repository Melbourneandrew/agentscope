import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareImageOperation } from "../image-preparation/preparation.mjs";
import {
  BUILDKIT_IMAGE,
  preparePinnedDockerImages,
} from "../image-preparation.mjs";

const image = BUILDKIT_IMAGE;
describe("deterministic timeout and cleanup precedence", () => {
  it.each([false, true])(
    "keeps the original cutoff and fails without admission (cleanup fails: %s)",
    async (cleanupFails) => {
      const clock = vi.spyOn(performance, "now").mockReturnValue(100);
      const primary = Object.assign(new Error("integration.images.timeout"), {
        code: "ETIMEDOUT",
      });
      const state = { admitPreparedSet: vi.fn() };
      const cleanup = vi.fn((_owned, deadline: number) => {
        expect(deadline).toBe(600);
        if (cleanupFails) throw new Error("SYNTHETIC-SUBSTITUTED-CLEANUP");
      });
      const prepare = vi.fn((input: unknown) => {
        expect((input as { policy: unknown }).policy).toEqual({
          deadline: 600,
          workDeadline: 500,
          reconciliationDeadline: 550,
          maximumPreparationMilliseconds: 500,
          teardownMilliseconds: 100,
        });
        // This seam proves the passed cutoff and precedence, not real cleanup
        // success after expiry: production cleanup must still enforce it.
        clock.mockReturnValue(700);
        return Promise.reject(primary);
      });
      try {
        const operation = prepareImageOperation(
          state,
          {
            createPrivateClientRoot: () => ({
              root: "/synthetic-private-root",
            }),
            cleanupPrivateClient: cleanup,
            engineTransport: () => undefined,
            prepareImageSet: prepare,
          },
          [image],
          {
            socketIdentityForTesting: {
              path: "/synthetic.sock",
              device: "1",
              inode: "2",
              mode: "600",
              owner: "0",
            },
            maximumPreparationMilliseconds: 500,
            teardownMilliseconds: 100,
          },
        );
        if (cleanupFails) {
          await expect(operation).rejects.toThrow("integration.images.cleanup");
        } else await expect(operation).rejects.toBe(primary);
        expect(cleanup).toHaveBeenCalledTimes(1);
        expect(prepare).toHaveBeenCalledTimes(1);
        expect(state.admitPreparedSet).not.toHaveBeenCalled();
      } finally {
        clock.mockRestore();
      }
    },
  );
});
const roots: { path: string; deadline: number }[] = [];
const listenForFixture = async (
  server: ReturnType<typeof createServer>,
  socketPath: string,
  directory: string,
  connections: ReadonlySet<Socket>,
) => {
  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(socketPath, resolveListen);
    });
  } catch (primary) {
    if (server.listening === false && connections.size === 0) {
      try {
        rmSync(directory, { recursive: true });
      } catch {
        // Failed rollback preserves both the root and controlling setup error.
      }
    }
    throw primary;
  }
};
afterEach(() => {
  for (const value of roots.splice(0)) {
    expect(performance.now()).toBeLessThanOrEqual(value.deadline);
    rmSync(value.path, { force: true, recursive: true });
    expect(existsSync(value.path)).toBe(false);
    expect(performance.now()).toBeLessThanOrEqual(value.deadline);
  }
});

describe("Engine socket setup rollback", () => {
  it("rolls back only its owned root on definite listen setup failure", async () => {
    const directory = mkdtempSync(resolve(tmpdir(), "ags-engine-"));
    const server = createServer();
    const primary = new Error("synthetic listen setup failure");
    const listen = vi.spyOn(server, "listen").mockImplementationOnce(() => {
      throw primary;
    });
    try {
      await expect(
        listenForFixture(
          server,
          resolve(directory, "engine.sock"),
          directory,
          new Set(),
        ),
      ).rejects.toBe(primary);
      expect(server.listening).toBe(false);
      expect(existsSync(directory)).toBe(false);
    } finally {
      listen.mockRestore();
    }
  });
});

describe("real Engine socket terminal settlement", () => {
  it.each([false, true])(
    "settles cancellation (already aborted: %s)",
    async (alreadyAborted) => {
      const directory = mkdtempSync(resolve(tmpdir(), "ags-engine-"));
      let privateRoot: string | undefined;
      const registryRequest = vi.fn(() =>
        Promise.reject(new Error("unexpected registry request")),
      );
      const socketPath = resolve(directory, "engine.sock");
      const connections = new Set<Socket>();
      const controller = new AbortController();
      let requestCount = 0;
      let observePeerClose: () => void = () => {};
      const peerClosed = new Promise<void>((resolveClose) => {
        observePeerClose = resolveClose;
      });
      const server = createServer(() => {
        // Deliberately never send headers or a body.
        requestCount += 1;
        controller.abort();
      });
      server.on("connection", (connection) => {
        connections.add(connection);
        connection.once("close", () => {
          connections.delete(connection);
          observePeerClose();
        });
      });
      await listenForFixture(server, socketPath, directory, connections);
      // One fixture observation authority, entered before preparation; no join reset.
      const fixtureDeadline = performance.now() + 500;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let workGuardFired = false;
      const workTimer = setTimeout(
        () => {
          workGuardFired = true;
          controller.abort();
          for (const connection of connections) connection.destroy();
        },
        Math.max(1, Math.floor(fixtureDeadline - 100 - performance.now())),
      );
      const fixtureExpired = new Promise<never>((_, rejectExpired) => {
        timer = setTimeout(
          () => {
            controller.abort();
            rejectExpired(
              new Error("Engine request or peer close not observed"),
            );
          },
          Math.max(1, Math.floor(fixtureDeadline - performance.now())),
        );
      });
      if (alreadyAborted) controller.abort();
      const preparation = preparePinnedDockerImages([image], {
        dockerSocketForTesting: socketPath,
        registryRequestForTesting: registryRequest,
        signal: controller.signal,
        maximumPreparationMilliseconds: 500,
        teardownMilliseconds: 100,
        afterPrivateRootCreatedForTesting: (value: string) => {
          privateRoot = value;
        },
      });
      try {
        await Promise.race([
          Promise.all([
            expect(preparation).rejects.toThrow(
              "integration.images.interrupted",
            ),
            alreadyAborted ? Promise.resolve() : peerClosed,
          ]),
          fixtureExpired,
        ]);
        expect(requestCount).toBe(alreadyAborted ? 0 : 1);
        expect(connections.size).toBe(0);
        expect(workGuardFired).toBe(false);
        expect(registryRequest).not.toHaveBeenCalled();
      } finally {
        controller.abort();
        server.closeAllConnections();
        try {
          await Promise.race([
            Promise.all([
              Promise.allSettled([preparation]),
              new Promise<void>((resolveClose) => {
                server.close(() => {
                  resolveClose();
                });
              }),
            ]),
            fixtureExpired,
          ]);
          // Only terminally joined work grants this fixture root cleanup.
          roots.push({ path: directory, deadline: fixtureDeadline });
          if (privateRoot !== undefined)
            roots.push({ path: privateRoot, deadline: fixtureDeadline });
          expect(privateRoot).toBeTypeOf("string");
          expect(existsSync(privateRoot ?? "")).toBe(true);
        } finally {
          clearTimeout(timer);
          clearTimeout(workTimer);
        }
      }
    },
  );
});
