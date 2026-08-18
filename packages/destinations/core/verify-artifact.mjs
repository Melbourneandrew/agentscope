import { z } from "zod";

import {
  createDestinationConnectionId,
  defineDestinationDescriptor,
  executeBoundDestinationRequest,
  parseDestinationSettings,
} from "./dist/index.js";
import {
  bindDestinationTransport,
  createReporterDeadline,
  prepareDestinationReporter,
  resolveDestinationConnection,
} from "./dist/core-orchestration.js";

const connectionId = createDestinationConnectionId(
  "destination-connection-v1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
);
const schema = z.strictObject({ endpoint: z.string() });
void schema.shape;
const materializeRoot = (candidate) => {
  void candidate.shape;
  return candidate;
};
const input = (overrides = {}) => ({
  descriptorVersion: 1,
  destinationType: "@agentscope/destination-artifact",
  commandName: "artifact",
  settingsVersion: 1,
  settingsSchema: schema,
  defaultSettings: { endpoint: "https://example.com" },
  credentialSlots: [],
  documentationPath: "/docs/destinations/artifact",
  deliveryIdentitySupport: "duplicates-possible",
  transport: {
    kind: "remote",
    resolveEndpoint: ({ endpoint }) => ({
      url: endpoint,
      allowInsecureLoopback: false,
    }),
  },
  createReporter: () => ({ report: () => Promise.resolve({}) }),
  ...overrides,
});

const expectFixedRejection = (action) => {
  try {
    action();
  } catch (error) {
    if (error?.code === "destination.descriptor.invalid") return;
  }
  throw new Error("Destination artifact callback misuse was not rejected.");
};

const unhandled = [];
const collectUnhandled = (reason) => unhandled.push(reason);
process.on("unhandledRejection", collectUnhandled);
try {
  const methodSchema = z.strictObject({ endpoint: z.string() });
  materializeRoot(methodSchema);
  const methodDescriptor = defineDestinationDescriptor(
    input({ settingsSchema: methodSchema }),
  );
  Object.defineProperty(methodSchema, "safeParse", {
    value: (value) => ({ success: true, data: value }),
  });
  Object.defineProperty(methodSchema._zod, "run", {
    value: (value) => value,
  });
  expectFixedRejection(() =>
    parseDestinationSettings(methodDescriptor, { endpoint: 42 }),
  );

  const shapeSchema = z.strictObject({ endpoint: z.string() });
  materializeRoot(shapeSchema);
  const shapeDescriptor = defineDestinationDescriptor(
    input({ settingsSchema: shapeSchema }),
  );
  Object.defineProperty(shapeSchema.def, "shape", {
    value: { endpoint: z.number() },
  });
  expectFixedRejection(() =>
    parseDestinationSettings(shapeDescriptor, {
      endpoint: 42,
    }),
  );

  const preparedExact = resolveDestinationConnection(methodDescriptor, {
    connectionId,
    settings: { endpoint: "https://example.com/tenant-a/" },
  });
  const preparedOtherPath = resolveDestinationConnection(methodDescriptor, {
    connectionId,
    settings: { endpoint: "https://example.com/tenant-b/" },
  });
  let transportCalls = 0;
  const otherPathTransport = bindDestinationTransport(
    preparedOtherPath.endpoint,
    async () => {
      transportCalls += 1;
      return { status: 200, headers: {}, body: new Uint8Array() };
    },
  );
  expectFixedRejection(() =>
    prepareDestinationReporter(preparedExact, {
      credentials: {},
      transport: otherPathTransport,
    }),
  );
  try {
    await executeBoundDestinationRequest(otherPathTransport, {
      method: "POST",
      pathAndQuery: "https://example.com/absolute",
      headers: {},
      signal: new AbortController().signal,
      deadline: createReporterDeadline(1_000),
    });
    throw new Error("Absolute destination request was accepted.");
  } catch (error) {
    if (error?.code !== "destination.transport.invalid") throw error;
  }
  if (transportCalls !== 0)
    throw new Error("Invalid destination request reached the executor.");

  let weakened = false;
  const refinementSchema = z.strictObject({
    endpoint: z
      .string()
      .refine((value) => weakened || value === "https://example.com"),
  });
  materializeRoot(refinementSchema);
  expectFixedRejection(() =>
    defineDestinationDescriptor(input({ settingsSchema: refinementSchema })),
  );
  weakened = true;

  const propertySchema = z
    .strictObject({ endpoint: z.string() })
    .check(z.property("endpoint", z.string().min(20)));
  materializeRoot(propertySchema);
  expectFixedRejection(() =>
    defineDestinationDescriptor(input({ settingsSchema: propertySchema })),
  );

  for (const pattern of [/abc/i, /^abc$/m, /abc/u]) {
    const flaggedRegexSchema = z.strictObject({
      endpoint: z.string().regex(pattern),
    });
    materializeRoot(flaggedRegexSchema);
    expectFixedRejection(() =>
      defineDestinationDescriptor(
        input({ settingsSchema: flaggedRegexSchema }),
      ),
    );
  }
  for (const nonRoundTrippableString of [
    z.string().emoji(),
    z.string().includes("b", { position: 2 }),
  ]) {
    expectFixedRejection(() =>
      defineDestinationDescriptor(
        input({
          settingsSchema: materializeRoot(
            z.strictObject({ endpoint: nonRoundTrippableString }),
          ),
        }),
      ),
    );
  }
  expectFixedRejection(() =>
    defineDestinationDescriptor(
      input({
        settingsSchema: materializeRoot(
          z.strictObject({
            endpoint: z.number().min(3, { when: () => false }),
          }),
        ),
      }),
    ),
  );
  for (const metadataSchema of [
    z.string().regex(/^x$/).meta({ pattern: ".*" }),
    z.string().check(z.meta({ pattern: ".*" })),
  ]) {
    expectFixedRejection(() =>
      defineDestinationDescriptor(
        input({
          settingsSchema: materializeRoot(
            z.strictObject({ endpoint: metadataSchema }),
          ),
        }),
      ),
    );
  }
  const customEmitterSchema = z.strictObject({
    endpoint: z.string().regex(/^x$/),
  });
  materializeRoot(customEmitterSchema);
  Object.defineProperty(customEmitterSchema._zod, "toJSONSchema", {
    value: () => ({
      type: "object",
      properties: { endpoint: { type: "string" } },
      required: ["endpoint"],
      additionalProperties: false,
    }),
  });
  expectFixedRejection(() =>
    defineDestinationDescriptor(input({ settingsSchema: customEmitterSchema })),
  );

  const inheritedEmitterSchema = z.strictObject({ endpoint: z.string() });
  materializeRoot(inheritedEmitterSchema);
  Object.setPrototypeOf(inheritedEmitterSchema._zod, {
    toJSONSchema: () => ({ type: "object" }),
  });
  expectFixedRejection(() =>
    defineDestinationDescriptor(
      input({ settingsSchema: inheritedEmitterSchema }),
    ),
  );
  const tamperedBagLeaf = z.string().regex(/^https:\/\/example\.com$/);
  tamperedBagLeaf._zod.bag.patterns = new Set([/.*/]);
  expectFixedRejection(() =>
    defineDestinationDescriptor(
      input({
        settingsSchema: materializeRoot(
          z.strictObject({ endpoint: tamperedBagLeaf }),
        ),
      }),
    ),
  );
  const inheritedBagLeaf = z.string();
  Object.setPrototypeOf(inheritedBagLeaf._zod.bag, {
    patterns: new Set([/^x$/]),
  });
  expectFixedRejection(() =>
    defineDestinationDescriptor(
      input({
        settingsSchema: materializeRoot(
          z.strictObject({ endpoint: inheritedBagLeaf }),
        ),
      }),
    ),
  );
  const shadowedPattern = /^https:\/\/example\.com$/;
  Object.defineProperty(shadowedPattern, "source", { get: () => ".*" });
  expectFixedRejection(() =>
    defineDestinationDescriptor(
      input({
        settingsSchema: materializeRoot(
          z.strictObject({
            endpoint: z.string().regex(shadowedPattern),
          }),
        ),
      }),
    ),
  );
  const inheritedPattern = /^https:\/\/example\.com$/;
  Object.setPrototypeOf(inheritedPattern, {
    get source() {
      return ".*";
    },
    get flags() {
      return "";
    },
  });
  expectFixedRejection(() =>
    defineDestinationDescriptor(
      input({
        settingsSchema: materializeRoot(
          z.strictObject({
            endpoint: z.string().regex(inheritedPattern),
          }),
        ),
      }),
    ),
  );
  const iteratorBagLeaf = z.string().regex(/^https:\/\/example\.com$/);
  let iteratorCalls = 0;
  Object.defineProperty(iteratorBagLeaf._zod.bag.patterns, Symbol.iterator, {
    value: function* () {
      iteratorCalls += 1;
      yield iteratorCalls === 1 ? /^https:\/\/example\.com$/ : /.*/;
    },
  });
  expectFixedRejection(() =>
    defineDestinationDescriptor(
      input({
        settingsSchema: materializeRoot(
          z.strictObject({ endpoint: iteratorBagLeaf }),
        ),
      }),
    ),
  );
  const constructorBagLeaf = z.string().regex(/^https:\/\/example\.com$/);
  constructorBagLeaf._zod.bag.patterns = new Set([/.*/]);
  const corruptedBag = constructorBagLeaf._zod.bag;
  constructorBagLeaf._zod.constr = function CorruptedConstructor() {
    return { _zod: { bag: corruptedBag } };
  };
  expectFixedRejection(() =>
    defineDestinationDescriptor(
      input({
        settingsSchema: materializeRoot(
          z.strictObject({ endpoint: constructorBagLeaf }),
        ),
      }),
    ),
  );
  const shapeLeaf = z.string().regex(/^https:\/\/example\.com$/);
  const shape = { endpoint: shapeLeaf };
  const statefulShapeSchema = z.strictObject(shape);
  let shapeCalls = 0;
  Object.defineProperty(statefulShapeSchema._zod.def, "shape", {
    get: () => {
      shapeCalls += 1;
      if (shapeCalls > 1) shapeLeaf._zod.bag.patterns = new Set([/.*/]);
      return shape;
    },
  });
  expectFixedRejection(() =>
    defineDestinationDescriptor(input({ settingsSchema: statefulShapeSchema })),
  );
  if (shapeCalls !== 0)
    throw new Error("Destination custom shape callback was invoked.");

  const definitionAccessorSchema = materializeRoot(
    z.strictObject({ endpoint: z.string() }),
  );
  const originalType = definitionAccessorSchema._zod.def.type;
  let definitionAccessorCalls = 0;
  Object.defineProperty(definitionAccessorSchema._zod.def, "type", {
    configurable: true,
    enumerable: true,
    get: () => {
      definitionAccessorCalls += 1;
      return originalType;
    },
  });
  expectFixedRejection(() =>
    defineDestinationDescriptor(
      input({ settingsSchema: definitionAccessorSchema }),
    ),
  );
  if (definitionAccessorCalls !== 0)
    throw new Error("Destination definition callback was invoked.");

  const hostileSchema = z.strictObject({ endpoint: z.string() });
  materializeRoot(hostileSchema);
  Object.defineProperty(hostileSchema, "safeParse", {
    value: () => Promise.reject(new Error("CANARY_SCHEMA_SECRET")),
  });
  const hostileDescriptor = defineDestinationDescriptor(
    input({ settingsSchema: hostileSchema }),
  );
  expectFixedRejection(() =>
    parseDestinationSettings(hostileDescriptor, { endpoint: 42 }),
  );

  const resolverDescriptor = defineDestinationDescriptor(
    input({
      transport: {
        kind: "remote",
        resolveEndpoint: () =>
          Promise.reject(new Error("CANARY_RESOLVER_SECRET")),
      },
    }),
  );
  expectFixedRejection(() =>
    resolveDestinationConnection(resolverDescriptor, {
      connectionId,
      settings: {},
    }),
  );

  const factoryDescriptor = defineDestinationDescriptor(
    input({
      createReporter: () => Promise.reject(new Error("CANARY_FACTORY_SECRET")),
    }),
  );
  const prepared = resolveDestinationConnection(factoryDescriptor, {
    connectionId,
    settings: {},
  });
  const transport = bindDestinationTransport(prepared.endpoint, async () => ({
    status: 200,
    headers: {},
    body: new Uint8Array(),
  }));
  expectFixedRejection(() =>
    prepareDestinationReporter(prepared, { credentials: {}, transport }),
  );

  await Promise.resolve();
  await Promise.resolve();
  if (unhandled.length !== 0)
    throw new Error("Destination artifact callback rejection leaked.");
} finally {
  process.off("unhandledRejection", collectUnhandled);
}

process.stdout.write("Verified destination callback containment in dist.\n");
