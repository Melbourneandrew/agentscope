import { z } from "zod";
import { describe, expect, expectTypeOf, it, vi } from "vitest";

import {
  compileDestinationRegistry,
  defineDestinationDescriptor,
  DestinationDescriptorError,
  getDestinationDescriptor,
  parseDestinationSettings,
  prepareDestinationReporter,
  resolveDestinationConnection,
  type DestinationDescriptor,
  type DestinationDescriptorInput,
  type DestinationSettings,
  type ReporterFactoryContext,
} from "./descriptor.js";
import { validateDestinationEndpoint } from "./endpoint.js";
import { createDestinationConnectionId } from "./identity.js";
import { createDestinationReporter, type Reporter } from "./reporter.js";
import { bindDestinationTransport } from "./transport.js";

const connectionId = createDestinationConnectionId(
  "destination-connection-v1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
);
const remoteSchema = z.strictObject({
  endpoint: z.string(),
  insecure: z.boolean(),
  project: z.string(),
});
void remoteSchema.shape;
type RemoteSettings = z.infer<typeof remoteSchema>;

const materializeSchema = <Schema extends z.ZodType>(
  schema: Schema,
): Schema => {
  z.toJSONSchema(schema);
  return schema;
};

const materializeRootSchema = <Schema extends z.ZodType>(
  schema: Schema,
): Schema => {
  if (schema instanceof z.ZodObject) void schema.shape;
  return schema;
};

const reporter = () =>
  createDestinationReporter({
    report: () => Promise.resolve(Object.freeze({ outcome: "accepted" })),
  });

const remoteInput = (
  overrides: Partial<DestinationDescriptorInput<RemoteSettings>> = {},
): DestinationDescriptorInput<RemoteSettings> => ({
  descriptorVersion: 1,
  destinationType: "@agentscope/destination-langfuse",
  commandName: "langfuse",
  settingsVersion: 1,
  settingsSchema: remoteSchema,
  defaultSettings: {
    endpoint: "https://example.com/otlp",
    insecure: false,
    project: "default",
  },
  credentialSlots: [
    { id: "secret-key", required: true },
    { id: "public-key", required: false },
  ],
  documentationPath:
    "/docs/blueprints/destinations/reporters/langfuse-reporter",
  deliveryIdentitySupport: "native-idempotency",
  transport: {
    kind: "remote",
    resolveEndpoint: (settings) => ({
      url: settings.endpoint,
      allowInsecureLoopback: settings.insecure,
    }),
  },
  createReporter: reporter,
  ...overrides,
});

const authorityInput = (value: z.ZodType) => {
  const settingsSchema = z.strictObject({ value });
  void settingsSchema.shape;
  return remoteInput({
    settingsSchema: settingsSchema as never,
    defaultSettings: { value: "x" },
  });
};

const transport = () =>
  bindDestinationTransport(
    validateDestinationEndpoint("https://example.com/otlp", {
      allowInsecureLoopback: false,
    }),
    () => Promise.resolve({ status: 200, headers: {}, body: new Uint8Array() }),
  );

const prepareReporter = (
  descriptor: DestinationDescriptor,
  input: Readonly<{
    connectionId: typeof connectionId;
    settings: unknown;
    credentials: unknown;
    transport: ReturnType<typeof transport> | null;
  }>,
) => {
  const prepared = resolveDestinationConnection(descriptor, {
    connectionId: input.connectionId,
    settings: input.settings,
  });
  const exactTransport =
    prepared.endpoint && input.transport
      ? bindDestinationTransport(prepared.endpoint, () =>
          Promise.resolve({
            status: 200,
            headers: {},
            body: new Uint8Array(),
          }),
        )
      : input.transport;
  return prepareDestinationReporter(prepared, {
    credentials: input.credentials,
    transport: exactTransport,
  });
};

describe("DestinationDescriptor compilation", () => {
  it("binds schema inference to a frozen opaque descriptor", () => {
    const descriptor = defineDestinationDescriptor(remoteInput());
    type Settings = DestinationSettings<typeof descriptor>;
    expectTypeOf<Settings>().toEqualTypeOf<RemoteSettings>();
    expectTypeOf<
      ReporterFactoryContext<Settings>["settings"]
    >().toEqualTypeOf<RemoteSettings>();
    expect(descriptor).toMatchObject({
      descriptorVersion: 1,
      destinationType: "@agentscope/destination-langfuse",
      commandName: "langfuse",
      settingsVersion: 1,
      settingKeys: ["endpoint", "insecure", "project"],
      deliveryIdentitySupport: "native-idempotency",
      transport: { kind: "remote" },
    });
    expect(Object.isFrozen(descriptor)).toBe(true);
    expect(Object.isFrozen(descriptor.defaultSettings)).toBe(true);
    expect(Object.isFrozen(descriptor.credentialSlots)).toBe(true);
  });

  it("parses strict settings into fresh frozen JSON", () => {
    const descriptor = defineDestinationDescriptor(remoteInput());
    const input = { project: "selected" };
    const settings = parseDestinationSettings(descriptor, input);
    expect(settings).toEqual({
      endpoint: "https://example.com/otlp",
      insecure: false,
      project: "selected",
    });
    expect(settings).not.toBe(input);
    expect(Object.isFrozen(settings)).toBe(true);
    for (const value of [
      { unknown: true },
      { project: 1 },
      { authToken: "CANARY_SECRET" },
      Object.defineProperty({}, "project", { get: () => "CANARY_SECRET" }),
    ]) {
      expect(() => parseDestinationSettings(descriptor, value)).toThrowError(
        DestinationDescriptorError,
      );
    }
  });

  it("rejects malformed descriptor metadata and capabilities", () => {
    const base = remoteInput();
    const customIterator: unknown[] = [];
    Object.defineProperty(customIterator, Symbol.iterator, {
      value: function* () {
        yield { id: "hidden", required: false };
      },
    });
    const sparseSlots = new Array<unknown>(1);
    const invalidInputs: unknown[] = [
      null,
      { ...base, descriptorVersion: 2 },
      { ...base, settingsVersion: 0 },
      { ...base, settingsVersion: 65_536 },
      { ...base, destinationType: "langfuse" },
      { ...base, commandName: "Langfuse" },
      { ...base, documentationPath: "https://example.com/docs" },
      { ...base, deliveryIdentitySupport: "exactly-once" },
      {
        ...base,
        credentialSlots: [
          { id: "same", required: true },
          { id: "same", required: false },
        ],
      },
      {
        ...base,
        credentialSlots: Array.from({ length: 17 }, (_, index) => ({
          id: `slot-${index}`,
          required: false,
        })),
      },
      { ...base, credentialSlots: [{ id: "Bad", required: true }] },
      { ...base, credentialSlots: [{ id: "slot", required: "yes" }] },
      { ...base, credentialSlots: [null] },
      { ...base, credentialSlots: [{ id: "slot", required: true, extra: 1 }] },
      { ...base, credentialSlots: null },
      { ...base, credentialSlots: customIterator },
      { ...base, credentialSlots: sparseSlots },
      { ...base, settingsSchema: null },
      { ...base, transport: { kind: "remote" } },
      {
        ...base,
        transport: { kind: "remote", resolveEndpoint: "not a function" },
      },
      { ...base, transport: null },
      { ...base, transport: { kind: "local", resolveEndpoint: () => ({}) } },
      { ...base, transport: { kind: "unknown" } },
      { ...base, createReporter: "not a function" },
      { ...base, extra: true },
      Object.defineProperty({ ...base }, "commandName", {
        get: () => "CANARY_SECRET",
      }),
    ];
    for (const value of invalidInputs) {
      expect(() => defineDestinationDescriptor(value as never)).toThrowError(
        DestinationDescriptorError,
      );
    }
  });
});

describe("DestinationDescriptor callback safety", () => {
  it("absorbs accidental async callback misuse without leaking rejection", async () => {
    const resolverDescriptor = defineDestinationDescriptor(
      remoteInput({
        transport: {
          kind: "remote",
          resolveEndpoint: (() =>
            Promise.reject(new Error("CANARY_RESOLVER_SECRET"))) as never,
        },
      }),
    );
    expect(() =>
      resolveDestinationConnection(resolverDescriptor, {
        connectionId,
        settings: {},
      }),
    ).toThrowError(DestinationDescriptorError);

    const factoryDescriptor = defineDestinationDescriptor(
      remoteInput({
        createReporter: (() =>
          Promise.reject(new Error("CANARY_FACTORY_SECRET"))) as never,
      }),
    );
    const prepared = resolveDestinationConnection(factoryDescriptor, {
      connectionId,
      settings: {},
    });
    expect(() =>
      prepareDestinationReporter(prepared, {
        credentials: { "secret-key": "secret" },
        transport: transport(),
      }),
    ).toThrowError(DestinationDescriptorError);

    const hostileSchema = z.strictObject(remoteSchema.shape);
    materializeSchema(hostileSchema);
    Object.defineProperty(hostileSchema, "safeParse", {
      value: () => Promise.reject(new Error("CANARY_SCHEMA_SECRET")),
    });
    const hostileDescriptor = defineDestinationDescriptor(
      remoteInput({ settingsSchema: hostileSchema }),
    );
    expect(() =>
      parseDestinationSettings(hostileDescriptor, { endpoint: 42 }),
    ).toThrowError(DestinationDescriptorError);

    const nestedStrippingSchema = z.strictObject({
      ...remoteSchema.shape,
      nested: z.object({ safe: z.string() }).optional(),
    });
    materializeSchema(nestedStrippingSchema);
    const nestedStripping = defineDestinationDescriptor(
      remoteInput({ settingsSchema: nestedStrippingSchema }),
    );
    expect(() =>
      parseDestinationSettings(nestedStripping, {
        nested: { safe: "value", unknown: true },
      }),
    ).toThrowError(DestinationDescriptorError);

    await Promise.resolve();
  });
});

describe("DestinationDescriptor schema safety", () => {
  it("rejects unsafe defaults and schema behavior", () => {
    expect(() =>
      defineDestinationDescriptor(
        remoteInput({
          defaultSettings: {
            endpoint: "https://example.com/otlp",
            insecure: false,
            project: "default",
            apiKey: "x",
          },
        }),
      ),
    ).toThrowError(DestinationDescriptorError);
    expect(() =>
      defineDestinationDescriptor(
        remoteInput({ defaultSettings: { endpoint: "x", insecure: false } }),
      ),
    ).toThrowError(DestinationDescriptorError);
    const dateSchema = z
      .strictObject({
        endpoint: z.string(),
        insecure: z.boolean(),
        project: z.string(),
      })
      .transform(() => new Date()) as never;
    expect(() =>
      defineDestinationDescriptor(remoteInput({ settingsSchema: dateSchema })),
    ).toThrowError(DestinationDescriptorError);
    const asyncSchema = remoteSchema.refine(
      async () => await Promise.resolve(true),
    ) as never;
    expect(() =>
      defineDestinationDescriptor(remoteInput({ settingsSchema: asyncSchema })),
    ).toThrowError(DestinationDescriptorError);

    expect(() =>
      defineDestinationDescriptor(
        remoteInput({ settingsSchema: z.string() as never }),
      ),
    ).toThrowError(DestinationDescriptorError);

    const credentialOverwrite = remoteSchema.overwrite(
      (value) => ({ ...value, apiKey: "x" }) as RemoteSettings,
    );
    const expansionOverwrite = remoteSchema.overwrite(
      (value) => ({ ...value, extra: true }) as RemoteSettings,
    );
    const strippingOverwrite = remoteSchema.overwrite((value) => {
      const result = { ...value } as Partial<RemoteSettings>;
      delete result.project;
      return result as RemoteSettings;
    });
    const optionalOverwrite = z
      .strictObject({ ...remoteSchema.shape, optional: z.string().optional() })
      .overwrite((value) => ({ ...value, optional: "created" }));
    for (const schema of [
      credentialOverwrite,
      expansionOverwrite,
      strippingOverwrite,
      optionalOverwrite,
    ]) {
      materializeRootSchema(schema);
      expect(() =>
        defineDestinationDescriptor(remoteInput({ settingsSchema: schema })),
      ).toThrowError(DestinationDescriptorError);
    }

    const strippingSchema = z.object(remoteSchema.shape);
    materializeSchema(strippingSchema);
    const strippingDescriptor = defineDestinationDescriptor(
      remoteInput({ settingsSchema: strippingSchema }),
    );
    expect(() =>
      parseDestinationSettings(strippingDescriptor, { unknown: true }),
    ).toThrowError(DestinationDescriptorError);

    const passthrough = z.object(remoteSchema.shape).passthrough();
    materializeSchema(passthrough);
    expect(() =>
      defineDestinationDescriptor(remoteInput({ settingsSchema: passthrough })),
    ).toThrowError(DestinationDescriptorError);
    const nestedPassthrough = z.strictObject({
      ...remoteSchema.shape,
      nested: z.object({ safe: z.string() }).passthrough().optional(),
    });
    materializeSchema(nestedPassthrough);
    expect(() =>
      defineDestinationDescriptor(
        remoteInput({ settingsSchema: nestedPassthrough }),
      ),
    ).toThrowError(DestinationDescriptorError);

    const credentialProducingSchema = remoteSchema.transform((value) => ({
      ...value,
      apiKey: "not-a-secret",
    })) as never;
    expect(() =>
      defineDestinationDescriptor(
        remoteInput({ settingsSchema: credentialProducingSchema }),
      ),
    ).toThrowError(DestinationDescriptorError);

    const expandingSchema = remoteSchema.transform((value) => ({
      ...value,
      extra: true,
    })) as never;
    expect(() =>
      defineDestinationDescriptor(
        remoteInput({ settingsSchema: expandingSchema }),
      ),
    ).toThrowError(DestinationDescriptorError);
  });
});

describe("DestinationDescriptor schema bounds", () => {
  it("rejects oversized parser and machine-schema graphs", () => {
    const hugeShape = Object.fromEntries(
      Array.from({ length: 1_030 }, (_, index) => [
        `field${index}`,
        z.string().optional(),
      ]),
    );
    const hugeShapeSchema = z.strictObject(hugeShape);
    materializeRootSchema(hugeShapeSchema);
    expect(() =>
      defineDestinationDescriptor(
        remoteInput({ settingsSchema: hugeShapeSchema as never }),
      ),
    ).toThrowError(DestinationDescriptorError);
    const hugeEnum = Array.from(
      { length: 1_030 },
      (_, index) => `value-${index}`,
    ) as [string, ...string[]];
    const hugeEnumSchema = z.strictObject({ value: z.enum(hugeEnum) });
    materializeRootSchema(hugeEnumSchema);
    expect(() =>
      defineDestinationDescriptor(
        remoteInput({
          settingsSchema: hugeEnumSchema as never,
        }),
      ),
    ).toThrowError(DestinationDescriptorError);
  });
});

describe("DestinationDescriptor schema output safety", () => {
  it("rejects nested and type-changing schema output", () => {
    const nestedSchema = z.strictObject({
      ...remoteSchema.shape,
      values: z.array(z.string()).optional(),
    });
    materializeSchema(nestedSchema);
    const nestedDescriptor = defineDestinationDescriptor(
      remoteInput({ settingsSchema: nestedSchema }),
    );
    expect(
      parseDestinationSettings(nestedDescriptor, { values: ["a", "b"] }),
    ).toMatchObject({ values: ["a", "b"] });

    const inputMutations = [
      nestedSchema.overwrite((value) =>
        value.values === undefined ? value : { ...value, values: ["changed"] },
      ),
      nestedSchema.overwrite(
        (value) =>
          (value.values === undefined
            ? value
            : { ...value, values: "changed" }) as never,
      ),
      nestedSchema.overwrite((value) =>
        value.values === undefined
          ? value
          : { ...value, values: ["changed", value.values[1]!] },
      ),
    ];
    for (const settingsSchema of inputMutations) {
      expect(() =>
        defineDestinationDescriptor(remoteInput({ settingsSchema })),
      ).toThrowError(DestinationDescriptorError);
    }

    const defaultMutations = [
      nestedSchema.overwrite(
        (value) => ({ ...value, project: ["changed"] }) as never,
      ),
      nestedSchema.overwrite((value) => ({ ...value, project: "changed" })),
    ];
    for (const settingsSchema of defaultMutations) {
      expect(() =>
        defineDestinationDescriptor(remoteInput({ settingsSchema })),
      ).toThrowError(DestinationDescriptorError);
    }
  });
});

describe("DestinationDescriptor schema authority", () => {
  it("retains compiled parser authority after caller schema mutation", () => {
    const methodSchema = z.strictObject(remoteSchema.shape);
    materializeSchema(methodSchema);
    const methodDescriptor = defineDestinationDescriptor(
      remoteInput({ settingsSchema: methodSchema }),
    );
    Object.defineProperty(methodSchema, "safeParse", {
      value: (value: unknown) => ({ success: true, data: value }),
    });
    Object.defineProperty(methodSchema._zod, "run", {
      value: (value: unknown) => value,
    });
    expect(() =>
      parseDestinationSettings(methodDescriptor, {
        insecure: "not-a-boolean",
      }),
    ).toThrowError(DestinationDescriptorError);

    const shapeSchema = z.strictObject(remoteSchema.shape);
    materializeSchema(shapeSchema);
    const shapeDescriptor = defineDestinationDescriptor(
      remoteInput({ settingsSchema: shapeSchema }),
    );
    Object.defineProperty(shapeSchema.def, "catchall", {
      value: z.unknown(),
    });
    expect(
      parseDestinationSettings(shapeDescriptor, { project: "selected" }),
    ).toMatchObject({ project: "selected" });

    const identitySchema = z.strictObject(remoteSchema.shape);
    materializeSchema(identitySchema);
    const identityDescriptor = defineDestinationDescriptor(
      remoteInput({ settingsSchema: identitySchema }),
    );
    Object.defineProperty(identitySchema.def, "shape", {
      value: { ...identitySchema.shape, insecure: z.string() },
    });
    expect(
      parseDestinationSettings(identityDescriptor, { project: "selected" }),
    ).toMatchObject({ project: "selected" });
  });

  it("rejects mutable callback-backed schema semantics", () => {
    const weakened = false;
    const refinement = z.strictObject({
      ...remoteSchema.shape,
      project: z.string().refine((value) => weakened || value === "default"),
    });
    materializeRootSchema(refinement);
    expect(() =>
      defineDestinationDescriptor(remoteInput({ settingsSchema: refinement })),
    ).toThrowError(DestinationDescriptorError);

    for (const settingsSchema of [
      z.strictObject({ ...remoteSchema.shape, value: z.coerce.string() }),
      z.strictObject({
        ...remoteSchema.shape,
        value: z.preprocess((value) => value, z.string()),
      }),
      z.strictObject({
        ...remoteSchema.shape,
        value: z.string().default("value"),
      }),
      z
        .strictObject({ ...remoteSchema.shape, value: z.string() })
        .check(z.property("value", z.string().min(3))),
      z.strictObject({
        ...remoteSchema.shape,
        value: z.string().regex(/abc/iu),
      }),
      z.strictObject({
        ...remoteSchema.shape,
        value: z.string().regex(/^abc$/m),
      }),
      z.strictObject({ ...remoteSchema.shape, value: z.string().emoji() }),
      z.strictObject({
        ...remoteSchema.shape,
        value: z.string().includes("b", { position: 2 }),
      }),
      z.strictObject({
        ...remoteSchema.shape,
        value: z.number().min(3, { when: () => false } as never),
      }),
      z.strictObject({
        ...remoteSchema.shape,
        value: z.string().regex(/^x$/).meta({ pattern: ".*" }),
      }),
      z.strictObject({
        ...remoteSchema.shape,
        value: z.string().check(z.meta({ pattern: ".*" })),
      }),
    ]) {
      materializeRootSchema(settingsSchema);
      expect(() =>
        defineDestinationDescriptor(remoteInput({ settingsSchema })),
      ).toThrowError(DestinationDescriptorError);
    }
  });
});

describe("DestinationDescriptor declarative checks", () => {
  it("preserves machine-represented checks in the detached validator", () => {
    const checkedSchema = z.strictObject({
      name: z.string().regex(/^[a-z]+$/),
      count: z.number().int().min(1).max(5).multipleOf(1),
      tags: z.array(z.string()),
    });
    materializeSchema(checkedSchema);
    const descriptor = defineDestinationDescriptor(
      remoteInput({
        settingsSchema: checkedSchema as never,
        defaultSettings: { name: "safe", count: 2, tags: ["one"] },
      }),
    );
    expect(parseDestinationSettings(descriptor, {})).toMatchObject({
      name: "safe",
      count: 2,
      tags: ["one"],
    });
    for (const settings of [
      { name: "TOOLONG" },
      { count: 0 },
      { count: 2.5 },
      { count: 6 },
    ]) {
      expect(() => parseDestinationSettings(descriptor, settings)).toThrowError(
        DestinationDescriptorError,
      );
    }
  });

  it("rejects length checks with callback-backed execution gates", () => {
    for (const value of [
      z.string().min(1),
      z.string().max(2),
      z.string().length(1),
      z.array(z.string()).min(1),
      z.array(z.string()).max(2),
    ]) {
      const settingsSchema = z.strictObject({ value });
      materializeRootSchema(settingsSchema);
      expect(() =>
        defineDestinationDescriptor(
          remoteInput({
            settingsSchema: settingsSchema as never,
            defaultSettings: { value: [] },
          }),
        ),
      ).toThrowError(DestinationDescriptorError);
    }
  });
});

describe("DestinationDescriptor corrupted authority", () => {
  it("rejects corrupted Zod parser authority before detaching", () => {
    const missingDefinition = z.strictObject(remoteSchema.shape);
    Reflect.deleteProperty(missingDefinition._zod, "def");
    expect(() =>
      defineDestinationDescriptor(
        remoteInput({ settingsSchema: missingDefinition }),
      ),
    ).toThrowError(DestinationDescriptorError);

    const nullDefinition = z.strictObject(remoteSchema.shape);
    Object.defineProperty(nullDefinition._zod, "def", { value: null });
    expect(() =>
      defineDestinationDescriptor(
        remoteInput({ settingsSchema: nullDefinition }),
      ),
    ).toThrowError(DestinationDescriptorError);

    const invalidShape = z.strictObject(remoteSchema.shape);
    Object.defineProperty(invalidShape._zod.def, "shape", {
      get: () => null,
    });
    expect(() =>
      defineDestinationDescriptor(
        remoteInput({ settingsSchema: invalidShape }),
      ),
    ).toThrowError(DestinationDescriptorError);

    const customEmitter = z.strictObject({ value: z.string().regex(/^x$/) });
    Object.defineProperty(customEmitter._zod, "toJSONSchema", {
      value: () => ({
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      }),
    });
    expect(() =>
      defineDestinationDescriptor(
        remoteInput({
          settingsSchema: customEmitter as never,
          defaultSettings: { value: "x" },
        }),
      ),
    ).toThrowError(DestinationDescriptorError);

    const inheritedEmitter = z.strictObject({ value: z.string().regex(/^x$/) });
    Object.setPrototypeOf(inheritedEmitter._zod, {
      toJSONSchema: () => ({ type: "object" }),
    });
    expect(() =>
      defineDestinationDescriptor(
        remoteInput({
          settingsSchema: inheritedEmitter as never,
          defaultSettings: { value: "x" },
        }),
      ),
    ).toThrowError(DestinationDescriptorError);

    const tamperedLeaf = z.string().regex(/^x$/);
    tamperedLeaf._zod.bag.patterns = new Set([/.*/]);
    expect(() =>
      defineDestinationDescriptor(authorityInput(tamperedLeaf)),
    ).toThrowError(DestinationDescriptorError);

    const scalarBagLeaf = z.string().regex(/^x$/);
    scalarBagLeaf._zod.bag.patterns = "invalid" as never;
    expect(() =>
      defineDestinationDescriptor(authorityInput(scalarBagLeaf)),
    ).toThrowError(DestinationDescriptorError);

    const accessorBagLeaf = z.string().regex(/^x$/);
    Object.defineProperty(accessorBagLeaf._zod.bag, "patterns", {
      get: () => new Set([/^x$/]),
    });
    expect(() =>
      defineDestinationDescriptor(authorityInput(accessorBagLeaf)),
    ).toThrowError(DestinationDescriptorError);

    for (const patterns of [new Set<RegExp>(), new Set([/^x$/i])]) {
      const mismatchedBagLeaf = z.string().regex(/^x$/);
      mismatchedBagLeaf._zod.bag.patterns = patterns;
      expect(() =>
        defineDestinationDescriptor(authorityInput(mismatchedBagLeaf)),
      ).toThrowError(DestinationDescriptorError);
    }

    const expandedBagLeaf = z.string().regex(/^x$/);
    Object.assign(expandedBagLeaf._zod.bag, { extra: true });
    expect(() =>
      defineDestinationDescriptor(authorityInput(expandedBagLeaf)),
    ).toThrowError(DestinationDescriptorError);

    const inheritedBagLeaf = z.string();
    Object.setPrototypeOf(inheritedBagLeaf._zod.bag, {
      patterns: new Set([/^x$/]),
    });
    expect(() =>
      defineDestinationDescriptor(authorityInput(inheritedBagLeaf)),
    ).toThrowError(DestinationDescriptorError);
  });
});

describe("DestinationDescriptor hostile collection authority", () => {
  it("rejects hostile bag iterators and constructors", () => {
    const mismatchedNumber = z.number().min(1);
    mismatchedNumber._zod.bag.minimum = 2;
    expect(() =>
      defineDestinationDescriptor(
        remoteInput({
          settingsSchema: z.strictObject({ value: mismatchedNumber }) as never,
          defaultSettings: { value: 2 },
        }),
      ),
    ).toThrowError(DestinationDescriptorError);

    const shadowedPattern = /^x$/;
    Object.defineProperty(shadowedPattern, "source", {
      get: () => ".*",
    });
    expect(() =>
      defineDestinationDescriptor(
        authorityInput(z.string().regex(shadowedPattern)),
      ),
    ).toThrowError(DestinationDescriptorError);

    const inheritedPattern = /^x$/;
    Object.setPrototypeOf(inheritedPattern, {
      get source() {
        return ".*";
      },
      get flags() {
        return "";
      },
    });
    expect(() =>
      defineDestinationDescriptor(
        authorityInput(z.string().regex(inheritedPattern)),
      ),
    ).toThrowError(DestinationDescriptorError);

    const missingConstructorLeaf = z.string();
    Reflect.deleteProperty(missingConstructorLeaf._zod, "constr");
    expect(() =>
      defineDestinationDescriptor(authorityInput(missingConstructorLeaf)),
    ).toThrowError(DestinationDescriptorError);

    const iteratorBagLeaf = z.string().regex(/^x$/);
    let iteratorCalls = 0;
    Object.defineProperty(iteratorBagLeaf._zod.bag.patterns, Symbol.iterator, {
      value: function* () {
        iteratorCalls += 1;
        yield iteratorCalls === 1 ? /^x$/ : /.*/;
      },
    });
    expect(() =>
      defineDestinationDescriptor(authorityInput(iteratorBagLeaf)),
    ).toThrowError(DestinationDescriptorError);

    const oversizedBagLeaf = z.string().regex(/^x$/);
    oversizedBagLeaf._zod.bag.patterns = new Set(
      Array.from({ length: 257 }, (_, index) => new RegExp(`^x${index}$`)),
    );
    expect(() =>
      defineDestinationDescriptor(authorityInput(oversizedBagLeaf)),
    ).toThrowError(DestinationDescriptorError);

    const constructorBagLeaf = z.string().regex(/^x$/);
    constructorBagLeaf._zod.bag.patterns = new Set([/.*/]);
    const corruptedBag = constructorBagLeaf._zod.bag;
    constructorBagLeaf._zod.constr = function CorruptedConstructor() {
      return { _zod: { bag: corruptedBag } };
    } as never;
    expect(() =>
      defineDestinationDescriptor(authorityInput(constructorBagLeaf)),
    ).toThrowError(DestinationDescriptorError);
  });
});

describe("DestinationDescriptor definition authority", () => {
  it("rejects definition accessors without invoking them", () => {
    const schema = z.strictObject({ value: z.string() });
    materializeRootSchema(schema);
    const originalType = schema._zod.def.type;
    let calls = 0;
    Object.defineProperty(schema._zod.def, "type", {
      configurable: true,
      enumerable: true,
      get: () => {
        calls += 1;
        return originalType;
      },
    });
    expect(() =>
      defineDestinationDescriptor(
        remoteInput({
          settingsSchema: schema as never,
          defaultSettings: { value: "x" },
        }),
      ),
    ).toThrowError(DestinationDescriptorError);
    expect(calls).toBe(0);
  });
});

describe("DestinationDescriptor shape authority", () => {
  it("rejects noncanonical shape callbacks before conversion", () => {
    const leaf = z.string().regex(/^x$/);
    const shape = { value: leaf };
    const schema = z.strictObject(shape);
    let shapeCalls = 0;
    Object.defineProperty(schema._zod.def, "shape", {
      get: () => {
        shapeCalls += 1;
        if (shapeCalls > 1) leaf._zod.bag.patterns = new Set([/.*/]);
        return shape;
      },
    });
    expect(() =>
      defineDestinationDescriptor(
        remoteInput({
          settingsSchema: schema as never,
          defaultSettings: { value: "x" },
        }),
      ),
    ).toThrowError(DestinationDescriptorError);
    expect(shapeCalls).toBe(0);

    const sharedLeaf = z.string().regex(/^x$/);
    const sharedSchema = z.strictObject({
      first: sharedLeaf,
      second: sharedLeaf,
    });
    materializeSchema(sharedSchema);
    const sharedDescriptor = defineDestinationDescriptor(
      remoteInput({
        settingsSchema: sharedSchema as never,
        defaultSettings: { first: "x", second: "x" },
      }),
    );
    expect(parseDestinationSettings(sharedDescriptor, {})).toEqual({
      first: "x",
      second: "x",
    });

    const victim = z.string().regex(/^x$/);
    const sibling = z.strictObject({ safe: z.string() });
    const siblingShape = sibling.shape;
    Object.defineProperty(sibling._zod.def, "shape", {
      get: () => {
        const weakened = z.string().regex(/.*/);
        victim._zod.def.checks = weakened._zod.def.checks!;
        victim._zod.bag = weakened._zod.bag;
        return siblingShape;
      },
    });
    expect(() =>
      defineDestinationDescriptor(
        remoteInput({
          settingsSchema: z.strictObject({ victim, sibling }) as never,
          defaultSettings: { victim: "not-x", sibling: { safe: "yes" } },
        }),
      ),
    ).toThrowError(DestinationDescriptorError);
  });

  it("rejects accessor and non-schema shape members", () => {
    for (const shape of [
      Object.defineProperty({}, "value", { get: () => z.string() }),
      { value: 42 },
    ]) {
      const schema = z.strictObject({ value: z.string() });
      Object.defineProperty(schema._zod.def, "shape", {
        get: () => shape,
      });
      expect(() =>
        defineDestinationDescriptor(
          remoteInput({
            settingsSchema: schema as never,
            defaultSettings: { value: "x" },
          }),
        ),
      ).toThrowError(DestinationDescriptorError);
    }

    const materialized = z.strictObject({ value: z.string() });
    void materialized.shape;
    expect(
      defineDestinationDescriptor(
        remoteInput({
          settingsSchema: materialized as never,
          defaultSettings: { value: "x" },
        }),
      ),
    ).toBeDefined();

    for (const shape of [null, { value: 42 }]) {
      const invalid = z.strictObject({ value: z.string() });
      void invalid.shape;
      Object.defineProperty(invalid._zod.def, "shape", { value: shape });
      expect(() =>
        defineDestinationDescriptor(
          remoteInput({
            settingsSchema: invalid as never,
            defaultSettings: { value: "x" },
          }),
        ),
      ).toThrowError(DestinationDescriptorError);
    }
  });
});

describe("DestinationDescriptor reporter preparation", () => {
  it("validates origin before binding credentials and calls one sync factory", () => {
    const factory = vi.fn(
      (_context: ReporterFactoryContext<RemoteSettings>): Reporter =>
        reporter(),
    );
    const descriptor = defineDestinationDescriptor(
      remoteInput({ createReporter: factory }),
    );
    const instance = prepareReporter(descriptor, {
      connectionId,
      settings: { project: "selected" },
      credentials: { "secret-key": "CANARY_SECRET" },
      transport: transport(),
    });
    expect(instance).toBeDefined();
    expect(factory).toHaveBeenCalledOnce();
    const context = factory.mock.calls[0]?.[0] as
      ReporterFactoryContext<RemoteSettings> | undefined;
    expect(context?.endpoint?.origin).toBe("https://example.com");
    expect(context?.transport?.endpoint).toBeDefined();
    expect(context?.connectionId).toBe(connectionId);
    expect(Object.isFrozen(context)).toBe(true);
  });

  it("supports local reporters without endpoint or credentials", () => {
    const schema = z.strictObject({ path: z.string() });
    materializeSchema(schema);
    type LocalSettings = z.infer<typeof schema>;
    const factory = vi.fn(
      (_context: ReporterFactoryContext<LocalSettings>): Reporter => reporter(),
    );
    const descriptor = defineDestinationDescriptor({
      descriptorVersion: 1,
      destinationType: "@agentscope/destination-local-sqlite",
      commandName: "local-sqlite",
      settingsVersion: 1,
      settingsSchema: schema,
      defaultSettings: { path: "traces.sqlite" },
      credentialSlots: [],
      documentationPath:
        "/docs/blueprints/destinations/local-sqlite-destination",
      deliveryIdentitySupport: "native-idempotency",
      transport: { kind: "local" },
      createReporter: factory,
    });
    prepareReporter(descriptor, {
      connectionId,
      settings: {},
      credentials: {},
      transport: null,
    });
    expect(factory.mock.calls[0]?.[0]).toMatchObject({
      endpoint: null,
      transport: null,
    });
  });
});

describe("DestinationDescriptor reporter rejection", () => {
  it("rejects origin mismatch, bad credentials, bad input, and async factories", () => {
    const descriptor = defineDestinationDescriptor(remoteInput());
    const otherTransport = bindDestinationTransport(
      validateDestinationEndpoint("https://other.example/", {
        allowInsecureLoopback: false,
      }),
      () =>
        Promise.resolve({ status: 200, headers: {}, body: new Uint8Array() }),
    );
    const sameOriginOtherPathTransport = bindDestinationTransport(
      validateDestinationEndpoint("https://example.com/other-path", {
        allowInsecureLoopback: false,
      }),
      () =>
        Promise.resolve({ status: 200, headers: {}, body: new Uint8Array() }),
    );
    const base = {
      connectionId,
      settings: {},
      credentials: { "secret-key": "secret" },
      transport: transport(),
    };
    for (const value of [
      null,
      { ...base, extra: true },
      { ...base, connectionId: "connection-name" },
    ]) {
      expect(() =>
        resolveDestinationConnection(descriptor, value as never),
      ).toThrowError(DestinationDescriptorError);
    }
    const prepared = resolveDestinationConnection(descriptor, {
      connectionId: base.connectionId,
      settings: base.settings,
    });
    const exactTransport = bindDestinationTransport(prepared.endpoint!, () =>
      Promise.resolve({ status: 200, headers: {}, body: new Uint8Array() }),
    );
    for (const value of [
      null,
      { credentials: base.credentials, transport: {} },
      { credentials: base.credentials, transport: otherTransport },
      {
        credentials: base.credentials,
        transport: sameOriginOtherPathTransport,
      },
      { credentials: {}, transport: exactTransport },
      { credentials: base.credentials, transport: exactTransport, extra: true },
    ]) {
      expect(() =>
        prepareDestinationReporter(prepared, value as never),
      ).toThrowError(DestinationDescriptorError);
    }
    expect(() =>
      prepareDestinationReporter({} as never, {
        credentials: base.credentials,
        transport: exactTransport,
      }),
    ).toThrowError(DestinationDescriptorError);
    const badEndpoint = defineDestinationDescriptor(
      remoteInput({
        transport: {
          kind: "remote",
          resolveEndpoint: () => ({
            url: "http://example.com",
            allowInsecureLoopback: true,
          }),
        },
      }),
    );
    expect(() => resolveDestinationConnection(badEndpoint, base)).toThrowError(
      DestinationDescriptorError,
    );
    const asyncFactory = defineDestinationDescriptor(
      remoteInput({
        createReporter: (() => Promise.resolve(reporter())) as never,
      }),
    );
    expect(() => prepareReporter(asyncFactory, base)).toThrowError(
      DestinationDescriptorError,
    );
    expect(() => parseDestinationSettings({} as never, {})).toThrowError(
      DestinationDescriptorError,
    );

    const badCandidates: unknown[] = [
      null,
      { url: "https://example.com", allowInsecureLoopback: false, extra: true },
      { url: "https://example.com", allowInsecureLoopback: "no" },
    ];
    for (const candidate of badCandidates) {
      const malformed = defineDestinationDescriptor(
        remoteInput({
          transport: {
            kind: "remote",
            resolveEndpoint: () => candidate as never,
          },
        }),
      );
      expect(() => prepareReporter(malformed, base)).toThrowError(
        DestinationDescriptorError,
      );
    }

    const local = defineDestinationDescriptor({
      ...remoteInput(),
      transport: { kind: "local" },
      credentialSlots: [],
    });
    expect(() =>
      prepareReporter(local, { ...base, credentials: {} }),
    ).toThrowError(DestinationDescriptorError);
  });
});

describe("destination registry", () => {
  it("sorts and resolves exact descriptor identities", () => {
    const remote = defineDestinationDescriptor(remoteInput());
    const local = defineDestinationDescriptor({
      ...remoteInput(),
      destinationType: "@agentscope/destination-local-sqlite",
      commandName: "local-sqlite",
    });
    const registry = compileDestinationRegistry([remote, local]);
    expect(registry.descriptors.map((value) => value.commandName)).toEqual([
      "langfuse",
      "local-sqlite",
    ]);
    expect(getDestinationDescriptor(registry, remote.destinationType)).toBe(
      remote,
    );
    expect(
      getDestinationDescriptor(registry, "@agentscope/destination-missing"),
    ).toBeUndefined();
    expect(getDestinationDescriptor(registry, "bad")).toBeUndefined();
    expect(
      compileDestinationRegistry([local, remote]).descriptors.map(
        (value) => value.commandName,
      ),
    ).toEqual(["langfuse", "local-sqlite"]);
    expect(() =>
      getDestinationDescriptor({} as never, remote.destinationType),
    ).toThrowError(DestinationDescriptorError);
  });

  it("rejects duplicate, forged, and oversized registries", () => {
    const descriptor = defineDestinationDescriptor(remoteInput());
    const sameCommand = defineDestinationDescriptor({
      ...remoteInput(),
      destinationType: "@agentscope/destination-other",
    });
    const customIterator: unknown[] = [];
    Object.defineProperty(customIterator, Symbol.iterator, {
      value: function* () {
        yield descriptor;
      },
    });
    const sparse = new Array<unknown>(1);
    for (const value of [
      [descriptor, descriptor],
      [descriptor, sameCommand],
      [{}],
      Array.from({ length: 33 }, () => descriptor),
      null,
      customIterator,
      sparse,
    ]) {
      expect(() => compileDestinationRegistry(value as never)).toThrowError(
        DestinationDescriptorError,
      );
    }
  });
});
