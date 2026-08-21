import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineDestinationDescriptor } from "./descriptor.js";
import {
  bindLocalResourceLifecycleCapability,
  defineLocalResourceLifecycleDeclaration,
  DestinationLocalResourceLifecycleError,
  isLocalResourceLifecycleCapability,
  isLocalResourceLifecycleDeclaration,
  LOCAL_RESOURCE_LIFECYCLE_OPERATIONS,
  type LocalResourceLifecycleDeclarationInput,
} from "./local-resource-lifecycle.js";
import { createDestinationReporter } from "./reporter.js";

const input = (
  overrides: Partial<LocalResourceLifecycleDeclarationInput> = {},
): LocalResourceLifecycleDeclarationInput => ({
  artifactGrammarFingerprint: `sha256-${"a".repeat(64)}`,
  artifactGrammarVersion: 1,
  artifactKinds: ["active-database", "lifecycle-intent"],
  capabilityVersion: 1,
  destinationType: "@agentscope/destination-local-sqlite",
  operations: ["configure", "delete", "recover", "unconfigure"],
  receiptReasons: ["destination-busy", "destination-corrupt"],
  recoveryHandlerId: "@agentscope/destination-local-sqlite/lifecycle-v1",
  settingKeys: ["maximumAgeNanoseconds", "maximumTraceCount"],
  settingsVersion: 1,
  ...overrides,
});

describe("local-resource lifecycle capability", () => {
  it("compiles one frozen branded declaration", () => {
    const declaration = defineLocalResourceLifecycleDeclaration(input());
    expect(declaration).toMatchObject({
      capabilityVersion: 1,
      destinationType: "@agentscope/destination-local-sqlite",
      operations: ["configure", "delete", "recover", "unconfigure"],
      settingKeys: ["maximumAgeNanoseconds", "maximumTraceCount"],
    });
    expect(Object.isFrozen(declaration)).toBe(true);
    expect(Object.isFrozen(declaration.operations)).toBe(true);
    expect(isLocalResourceLifecycleDeclaration(declaration)).toBe(true);
    expect(isLocalResourceLifecycleDeclaration({ ...declaration })).toBe(false);
    expect(isLocalResourceLifecycleCapability(declaration)).toBe(false);
    expect(LOCAL_RESOURCE_LIFECYCLE_OPERATIONS).toEqual([
      "backup",
      "configure",
      "delete",
      "doctor",
      "recover",
      "restore",
      "unconfigure",
    ]);
  });

  it("canonicalizes declaration inventory order", () => {
    const first = defineLocalResourceLifecycleDeclaration(input());
    const second = defineLocalResourceLifecycleDeclaration(
      input({
        artifactKinds: ["lifecycle-intent", "active-database"],
        operations: ["unconfigure", "recover", "delete", "configure"],
        receiptReasons: ["destination-corrupt", "destination-busy"],
        settingKeys: ["maximumTraceCount", "maximumAgeNanoseconds"],
      }),
    );
    expect(second).toEqual(first);
  });
});

describe("local-resource lifecycle declaration safety", () => {
  it("exposes one fixed family error code", () => {
    expect(new DestinationLocalResourceLifecycleError().code).toBe(
      "destination.local-resource-lifecycle.invalid",
    );
  });

  it("rejects malformed or executable declarations without invoking accessors", () => {
    let calls = 0;
    const accessor = Object.defineProperty(input(), "artifactKinds", {
      get() {
        calls += 1;
        return ["active-database"];
      },
    });
    const sparse = new Array(1) as string[];
    const extra = Object.assign(["active-database"], { hidden: true });
    const indexedAccessor = ["active-database"];
    Object.defineProperty(indexedAccessor, "0", {
      get() {
        calls += 1;
        return "active-database";
      },
    });
    const invalid: unknown[] = [
      null,
      [],
      Object.create(null),
      accessor,
      input({ artifactKinds: [] }),
      input({ artifactKinds: null as never }),
      input({ artifactKinds: Array.from({ length: 65 }, () => "artifact") }),
      input({ artifactKinds: [1] as never }),
      input({ artifactKinds: ["A".repeat(97)] }),
      input({ artifactKinds: ["active-database", "active-database"] }),
      input({ artifactKinds: sparse }),
      input({ artifactKinds: extra }),
      input({ artifactKinds: indexedAccessor }),
      { ...input(), capabilityVersion: 2 },
      input({ artifactGrammarVersion: 0 }),
      input({ artifactGrammarVersion: 65_536 }),
      input({ artifactGrammarVersion: "1" as never }),
      input({ artifactGrammarFingerprint: "sha256-invalid" }),
      input({ settingsVersion: 0 }),
      input({ operations: ["configure", "future"] as never }),
      input({ receiptReasons: ["busy"] }),
      input({ receiptReasons: ["destination-future"] }),
      input({ recoveryHandlerId: "CANARY" }),
      input({
        recoveryHandlerId: "@agentscope/destination-other/lifecycle-v1",
      }),
      input({ settingKeys: ["bad-key"] }),
      { ...input(), extra: true },
    ];
    for (const candidate of invalid) {
      expect(() =>
        defineLocalResourceLifecycleDeclaration(candidate as never),
      ).toThrowError(DestinationLocalResourceLifecycleError);
    }
    expect(calls).toBe(0);
  });

  it("rejects forged declarations and malformed schema fingerprints at binding", () => {
    const declaration = defineLocalResourceLifecycleDeclaration(input());
    for (const [candidate, schemaFingerprint] of [
      [{ ...declaration }, `sha256-${"a".repeat(64)}`],
      [declaration, "sha256-invalid"],
    ] as const) {
      expect(() =>
        bindLocalResourceLifecycleCapability(
          candidate as typeof declaration,
          schemaFingerprint,
        ),
      ).toThrowError(DestinationLocalResourceLifecycleError);
    }
  });

  it("changes the capability identity when the concrete artifact grammar changes", () => {
    const schemaFingerprint = `sha256-${"c".repeat(64)}`;
    const first = bindLocalResourceLifecycleCapability(
      defineLocalResourceLifecycleDeclaration(input()),
      schemaFingerprint,
    );
    const second = bindLocalResourceLifecycleCapability(
      defineLocalResourceLifecycleDeclaration(
        input({ artifactGrammarFingerprint: `sha256-${"b".repeat(64)}` }),
      ),
      schemaFingerprint,
    );
    expect(second.fingerprint).not.toBe(first.fingerprint);
  });
});

describe("local-resource lifecycle descriptor binding", () => {
  it("binds a local capability to the exact descriptor settings authority", () => {
    const settingsSchema = z.strictObject({
      maximumAgeNanoseconds: z.string(),
      maximumTraceCount: z.string(),
    });
    void settingsSchema.shape;
    const declaration = defineLocalResourceLifecycleDeclaration(input());
    const descriptor = defineDestinationDescriptor({
      commandName: "local-sqlite",
      createReporter: () =>
        createDestinationReporter({
          report: () => Promise.resolve({ outcome: "accepted" }),
        }),
      credentialSlots: [],
      defaultSettings: {
        maximumAgeNanoseconds: "2592000000000000",
        maximumTraceCount: "100000",
      },
      deliveryIdentitySupport: "native-idempotency",
      descriptorVersion: 1,
      destinationType: "@agentscope/destination-local-sqlite",
      documentationPath:
        "/docs/blueprints/destinations/local-sqlite-destination",
      localResourceLifecycle: declaration,
      settingsSchema,
      settingsVersion: 1,
      transport: { kind: "local" },
    });
    expect(descriptor.localResourceLifecycle).toMatchObject(declaration);
    expect(
      descriptor.localResourceLifecycle?.settingsSchemaFingerprint,
    ).toMatch(/^sha256-[a-f0-9]{64}$/u);
    expect(descriptor.localResourceLifecycle?.fingerprint).toMatch(
      /^sha256-[a-f0-9]{64}$/u,
    );
    expect(
      isLocalResourceLifecycleCapability(descriptor.localResourceLifecycle),
    ).toBe(true);
    expect(() =>
      defineDestinationDescriptor({
        commandName: "local-sqlite",
        createReporter: () =>
          createDestinationReporter({
            report: () => Promise.resolve({ outcome: "accepted" }),
          }),
        credentialSlots: [],
        defaultSettings: {
          maximumAgeNanoseconds: "2592000000000000",
          maximumTraceCount: "100000",
        },
        deliveryIdentitySupport: "native-idempotency",
        descriptorVersion: 1,
        destinationType: "@agentscope/destination-local-sqlite",
        documentationPath:
          "/docs/blueprints/destinations/local-sqlite-destination",
        localResourceLifecycle: { ...declaration },
        settingsSchema,
        settingsVersion: 1,
        transport: { kind: "local" },
      }),
    ).toThrowError();
    expect(() =>
      defineDestinationDescriptor({
        ...{
          commandName: "local-sqlite",
          createReporter: () =>
            createDestinationReporter({
              report: () => Promise.resolve({ outcome: "accepted" }),
            }),
          credentialSlots: [],
          defaultSettings: {
            maximumAgeNanoseconds: "2592000000000000",
            maximumTraceCount: "100000",
          },
          deliveryIdentitySupport: "native-idempotency" as const,
          descriptorVersion: 1 as const,
          destinationType: "@agentscope/destination-local-sqlite",
          documentationPath:
            "/docs/blueprints/destinations/local-sqlite-destination",
          localResourceLifecycle: declaration,
          settingsSchema,
          settingsVersion: 1,
        },
        transport: {
          kind: "remote" as const,
          resolveEndpoint: () => ({
            allowInsecureLoopback: false,
            url: "https://example.com",
          }),
        },
      }),
    ).toThrowError();
  });
});

describe("local-resource lifecycle schema fingerprint", () => {
  it("changes when the descriptor settings schema changes", () => {
    const declaration = defineLocalResourceLifecycleDeclaration(input());
    const defineWith = (checked: boolean) => {
      const settingsSchema = z.strictObject({
        maximumAgeNanoseconds: checked
          ? z.string().regex(/^[0-9]+$/)
          : z.string(),
        maximumTraceCount: z.string(),
      });
      void settingsSchema.shape;
      return defineDestinationDescriptor({
        commandName: "local-sqlite",
        createReporter: () =>
          createDestinationReporter({
            report: () => Promise.resolve({ outcome: "accepted" }),
          }),
        credentialSlots: [],
        defaultSettings: {
          maximumAgeNanoseconds: "2592000000000000",
          maximumTraceCount: "100000",
        },
        deliveryIdentitySupport: "native-idempotency",
        descriptorVersion: 1,
        destinationType: "@agentscope/destination-local-sqlite",
        documentationPath:
          "/docs/blueprints/destinations/local-sqlite-destination",
        localResourceLifecycle: declaration,
        settingsSchema,
        settingsVersion: 1,
        transport: { kind: "local" },
      });
    };
    expect(defineWith(true).localResourceLifecycle?.fingerprint).not.toBe(
      defineWith(false).localResourceLifecycle?.fingerprint,
    );
  });

  it("is stable across semantically irrelevant property declaration order", () => {
    const declaration = defineLocalResourceLifecycleDeclaration(
      input({ settingKeys: ["a", "b", "c", "d"] }),
    );
    const defineOrdered = (reverse: boolean) => {
      const settingsSchema = reverse
        ? z.strictObject({
            d: z.string().nullable(),
            c: z.tuple([z.string(), z.number()]),
            b: z.union([z.literal("two"), z.literal("one")]),
            a: z.enum(["two", "one"]),
          })
        : z.strictObject({
            a: z.enum(["one", "two"]),
            b: z.union([z.literal("one"), z.literal("two")]),
            c: z.tuple([z.string(), z.number()]),
            d: z.string().nullable(),
          });
      void settingsSchema.shape;
      return defineDestinationDescriptor({
        commandName: "local-sqlite",
        createReporter: () =>
          createDestinationReporter({
            report: () => Promise.resolve({ outcome: "accepted" }),
          }),
        credentialSlots: [],
        defaultSettings: { a: "one", b: "two", c: ["three", 4], d: null },
        deliveryIdentitySupport: "native-idempotency",
        descriptorVersion: 1,
        destinationType: "@agentscope/destination-local-sqlite",
        documentationPath: "/docs/local-sqlite",
        localResourceLifecycle: declaration,
        settingsSchema,
        settingsVersion: 1,
        transport: { kind: "local" },
      });
    };
    expect(defineOrdered(true).localResourceLifecycle?.fingerprint).toBe(
      defineOrdered(false).localResourceLifecycle?.fingerprint,
    );
  });
});
