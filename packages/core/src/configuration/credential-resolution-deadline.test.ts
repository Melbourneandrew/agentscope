import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  compileCredentialBackendRegistry,
  createCiEnvironmentCredentialAdapter,
  createCredentialResolutionContext,
  createStoredCredentialReference,
  defineStoredCredentialBackendAdapter,
  isCredentialResolutionContext,
  readResolvedCredentialForCore,
  resolveCredentialReference,
} from "./credential-adapter.js";

const reference = createStoredCredentialReference(
  "macos-keychain",
  `credential-reference-v1-${"a".repeat(64)}`,
  `credential-generation-v1-${"b".repeat(64)}`,
);

const registry = (
  resolve: () => Promise<Readonly<{ ok: true; secret: string }>>,
) =>
  compileCredentialBackendRegistry([
    defineStoredCredentialBackendAdapter("macos-keychain", {
      createPending: () => Promise.resolve({ ok: false, code: "denied" }),
      activate: () => Promise.resolve(false),
      removePending: () => Promise.resolve(false),
      removeOwned: () => Promise.resolve(false),
      resolve,
    }),
  ]);

afterEach(() => vi.restoreAllMocks());

describe("credential resolution inherits the caller cutoff", () => {
  it("keeps the original context brand and immutable numeric expiry", () => {
    const signal = new AbortController().signal;
    const context = createCredentialResolutionContext("hook", signal, 200);
    expect(isCredentialResolutionContext(context)).toBe(true);
    expect(Object.isFrozen(context)).toBe(true);
    expect(context.expiresAtMonotonicMilliseconds).toBe(200);
    expect(isCredentialResolutionContext({ ...context })).toBe(false);
    expect(isCredentialResolutionContext(new Proxy(context, {}))).toBe(false);
    expect(
      createCredentialResolutionContext("interactive", signal),
    ).not.toHaveProperty("expiresAtMonotonicMilliseconds");
  });

  it("rejects malformed cutoff primitives without coercion", () => {
    let coercions = 0;
    for (const cutoff of [
      NaN,
      Infinity,
      -1,
      "200",
      null,
      {
        valueOf: () => {
          coercions += 1;
          return 200;
        },
      },
    ]) {
      expect(() =>
        createCredentialResolutionContext(
          "hook",
          new AbortController().signal,
          cutoff as number,
        ),
      ).toThrow("core.credential.invalid");
    }
    expect(coercions).toBe(0);
  });

  it("refuses expired and cancelled resolution before touching the backend", async () => {
    vi.spyOn(performance, "now").mockReturnValue(200);
    const resolve = vi.fn(() =>
      Promise.resolve({ ok: true as const, secret: "CANARY" }),
    );
    const controller = new AbortController();
    const expired = createCredentialResolutionContext(
      "hook",
      controller.signal,
      200,
    );
    await expect(
      resolveCredentialReference(registry(resolve), reference, expired),
    ).resolves.toEqual({ ok: false, code: "unavailable" });
    controller.abort();
    await expect(
      resolveCredentialReference(
        registry(resolve),
        reference,
        createCredentialResolutionContext(
          "interactive",
          controller.signal,
          500,
        ),
      ),
    ).resolves.toEqual({ ok: false, code: "unavailable" });
    expect(resolve).not.toHaveBeenCalled();
  });

  it("does not promote an authentic success after expiry or cancellation", async () => {
    for (const cancel of [false, true]) {
      let now = 100;
      vi.spyOn(performance, "now").mockImplementation(() => now);
      const controller = new AbortController();
      const context = createCredentialResolutionContext(
        "hook",
        controller.signal,
        200,
      );
      const resolve = vi.fn(() => {
        if (cancel) controller.abort();
        else now = 200;
        return Promise.resolve({ ok: true as const, secret: "CANARY" });
      });
      await expect(
        resolveCredentialReference(registry(resolve), reference, context),
      ).resolves.toEqual({ ok: false, code: "unavailable" });
      expect(resolve).toHaveBeenCalledOnce();
      vi.restoreAllMocks();
    }
  });
});

describe("credential context compatibility", () => {
  it("preserves successful legacy resolution and CI environment behavior", async () => {
    vi.spyOn(performance, "now").mockReturnValue(100);
    const context = createCredentialResolutionContext(
      "interactive",
      new AbortController().signal,
      200,
    );
    const result = await resolveCredentialReference(
      registry(() => Promise.resolve({ ok: true, secret: "CANARY" })),
      reference,
      context,
    );
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(readResolvedCredentialForCore(result.credential)).toBe("CANARY");
    const ci = compileCredentialBackendRegistry([
      createCiEnvironmentCredentialAdapter({ TOKEN: "CI_CANARY" }),
    ]);
    const ciReference = {
      referenceVersion: 1 as const,
      backend: "ci-environment" as const,
      generationId: reference.generationId,
      environmentVariable: "TOKEN",
    };
    const ciResult = await resolveCredentialReference(ci, ciReference, context);
    expect(ciResult.ok).toBe(true);
    await expect(
      resolveCredentialReference(
        ci,
        ciReference,
        createCredentialResolutionContext("hook", context.signal, 100),
      ),
    ).resolves.toEqual({ ok: false, code: "unavailable" });
  });

  it("does not accept a cloned context at the resolver seam", async () => {
    const context = createCredentialResolutionContext(
      "hook",
      new AbortController().signal,
      200,
    );
    await expect(
      resolveCredentialReference(
        registry(() => Promise.resolve({ ok: true, secret: "CANARY" })),
        reference,
        { ...context },
      ),
    ).rejects.toThrow("core.credential.invalid");
  });
});
