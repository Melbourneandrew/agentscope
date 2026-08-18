import { describe, expect, it } from "vitest";

import {
  createReporterCredentialAccessor,
  credentialAccessorMatchesOrigin,
  isReporterCredentialAccessor,
} from "./credentials.js";
import {
  createReporterDeadline,
  isReporterDeadline,
  ReporterDeadlineError,
  reporterDeadlineRemainingMilliseconds,
} from "./deadline.js";
import {
  DestinationEndpointError,
  isValidatedDestinationEndpoint,
  validateDestinationEndpoint,
} from "./endpoint.js";
import {
  createCredentialSlotId,
  createDestinationCommandName,
  createDestinationConnectionId,
  createDestinationTypeId,
  DestinationIdentityError,
} from "./identity.js";
import {
  cloneJsonObject,
  DestinationDataError,
  settingsContainCredentialKey,
} from "./plain-data.js";
import { readReporterCredential } from "./index.js";
import { REPORTER_TEST_BEHAVIORS } from "./testing.js";

const connectionId =
  "destination-connection-v1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

describe("destination identities and endpoints", () => {
  it("validates all stable identity classes", () => {
    expect(createDestinationTypeId("@agentscope/destination-langfuse")).toBe(
      "@agentscope/destination-langfuse",
    );
    expect(createDestinationCommandName("local-sqlite")).toBe("local-sqlite");
    expect(createDestinationConnectionId(connectionId)).toBe(connectionId);
    expect(createCredentialSlotId("secret-key")).toBe("secret-key");
    for (const value of [null, "Langfuse", "a/b", "", "@scope/other"]) {
      expect(() => createDestinationTypeId(value)).toThrowError(
        DestinationIdentityError,
      );
    }
    expect(() => createDestinationCommandName("Bad_Name")).toThrowError(
      DestinationIdentityError,
    );
    expect(() =>
      createDestinationConnectionId("named-connection"),
    ).toThrowError(DestinationIdentityError);
    expect(() => createCredentialSlotId("token.value")).toThrowError(
      DestinationIdentityError,
    );
    for (const value of [
      `@agentscope/destination-${"a".repeat(200)}`,
      "a".repeat(200),
    ]) {
      expect(() => createDestinationTypeId(value)).toThrowError(
        DestinationIdentityError,
      );
      expect(() => createDestinationCommandName(value)).toThrowError(
        DestinationIdentityError,
      );
      expect(() => createCredentialSlotId(value)).toThrowError(
        DestinationIdentityError,
      );
    }
  });

  it("normalizes secure and explicit literal-loopback endpoints", () => {
    const remote = validateDestinationEndpoint(
      "https://EXAMPLE.com:443/otlp/",
      {
        allowInsecureLoopback: false,
      },
    );
    expect(remote).toMatchObject({
      href: "https://example.com/otlp/",
      origin: "https://example.com",
    });
    expect(Object.isFrozen(remote)).toBe(true);
    expect(isValidatedDestinationEndpoint(remote)).toBe(true);
    for (const value of [
      "http://127.0.0.1:4318",
      "http://127.1:4318",
      "http://[::1]",
    ]) {
      expect(
        validateDestinationEndpoint(value, { allowInsecureLoopback: true }),
      ).toBeDefined();
    }
    expect(isValidatedDestinationEndpoint({ ...remote })).toBe(false);
    expect(
      validateDestinationEndpoint("https://example.com/😀", {
        allowInsecureLoopback: false,
      }).href,
    ).toContain("%F0%9F%98%80");
  });

  it("rejects endpoint confusion and insecure remote origins", () => {
    for (const value of [
      "http://example.com",
      "http://localhost",
      "http://0.0.0.0",
      "http://[::]",
      "https://user@example.com",
      "https://example.com/?token=x",
      "https://example.com/#fragment",
      "https://example.com:0",
      "file:///tmp/trace",
      `https://example.com/${"x".repeat(2_100)}`,
      "https://example.com/\ud800",
      "https://example.com/\udc00",
      "not a url",
    ]) {
      expect(() =>
        validateDestinationEndpoint(value, { allowInsecureLoopback: false }),
      ).toThrowError(DestinationEndpointError);
    }
    expect(() =>
      validateDestinationEndpoint("http://127.0.0.1", {
        allowInsecureLoopback: false,
      }),
    ).toThrowError(DestinationEndpointError);
    expect(() =>
      validateDestinationEndpoint("http://example.com", {
        allowInsecureLoopback: true,
      }),
    ).toThrowError(DestinationEndpointError);
    expect(() =>
      validateDestinationEndpoint("https://example.com", null as never),
    ).toThrowError(DestinationEndpointError);
  });
});

describe("bounded destination data", () => {
  it("reconstructs and freezes plain JSON settings", () => {
    const input = {
      z: [null, true, 3, "value", { nested: "ok" }],
      a: "first",
    };
    const cloned = cloneJsonObject(input);
    expect(cloned).toEqual(input);
    expect(cloned).not.toBe(input);
    expect(Object.keys(cloned)).toEqual(["a", "z"]);
    expect(Object.isFrozen(cloned)).toBe(true);
    expect(Object.isFrozen(cloned.z)).toBe(true);
  });

  it("rejects non-JSON, hostile, cyclic, and oversized settings", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const sparse = new Array<unknown>(2);
    sparse[1] = "present";
    const accessor = Object.defineProperty({}, "value", {
      get: () => "CANARY_SECRET",
    });
    class Custom {}
    const tooDeep: Record<string, unknown> = {};
    let cursor = tooDeep;
    for (let index = 0; index < 18; index += 1) {
      cursor.next = {};
      cursor = cursor.next as Record<string, unknown>;
    }
    const arrayWithExtra = ["ok"];
    Object.defineProperty(arrayWithExtra, "extra", { value: true });
    for (const value of [
      null,
      "root",
      { number: Number.NaN },
      { number: Number.POSITIVE_INFINITY },
      cyclic,
      { sparse },
      accessor,
      new Custom(),
      tooDeep,
      { list: Array.from({ length: 257 }, () => null) },
      { list: arrayWithExtra },
      Object.fromEntries(
        Array.from({ length: 65 }, (_, index) => [`k${index}`, true]),
      ),
      { text: "x".repeat(8_193) },
      Object.fromEntries(
        Array.from({ length: 5 }, (_, index) => [
          `k${index}`,
          "x".repeat(8_000),
        ]),
      ),
    ]) {
      expect(() => cloneJsonObject(value)).toThrowError(DestinationDataError);
    }
  });

  it("detects credential-shaped setting keys recursively", () => {
    expect(
      settingsContainCredentialKey({ nested: [{ openaiApiKey: "x" }] }),
    ).toBe(true);
    expect(settingsContainCredentialKey({ authToken: "x" })).toBe(true);
    expect(
      settingsContainCredentialKey({ endpoint: "https://example.com" }),
    ).toBe(false);
  });
});

describe("deadline and credential capabilities", () => {
  it("brands bounded monotonic deadlines", () => {
    const deadline = createReporterDeadline(100);
    expect(isReporterDeadline(deadline)).toBe(true);
    expect(isReporterDeadline({ ...deadline })).toBe(false);
    expect(reporterDeadlineRemainingMilliseconds(deadline)).toBeGreaterThan(0);
    expect(Object.isFrozen(deadline)).toBe(true);
    for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY, 60_001]) {
      expect(() => createReporterDeadline(value)).toThrowError(
        ReporterDeadlineError,
      );
    }
    expect(() =>
      reporterDeadlineRemainingMilliseconds({} as never),
    ).toThrowError(ReporterDeadlineError);
  });

  it("keeps resolved credentials opaque, exact, and origin-bound", () => {
    const required = createCredentialSlotId("secret-key");
    const optional = createCredentialSlotId("public-key");
    const slots = [
      Object.freeze({ id: required, required: true }),
      Object.freeze({ id: optional, required: false }),
    ];
    const accessor = createReporterCredentialAccessor(
      slots,
      { "secret-key": "CANARY_SECRET" },
      "https://example.com",
    );
    expect(isReporterCredentialAccessor(accessor)).toBe(true);
    expect(isReporterCredentialAccessor({})).toBe(false);
    expect(isReporterCredentialAccessor(null)).toBe(false);
    expect(JSON.stringify(accessor)).toBe("{}");
    expect(readReporterCredential(accessor, required)).toBe("CANARY_SECRET");
    expect(readReporterCredential(accessor, optional)).toBeUndefined();
    expect(
      credentialAccessorMatchesOrigin(accessor, "https://example.com"),
    ).toBe(true);
    expect(
      credentialAccessorMatchesOrigin(accessor, "https://other.example"),
    ).toBe(false);
    const unicode = createReporterCredentialAccessor(
      [Object.freeze({ id: required, required: true })],
      { "secret-key": "😀" },
      null,
    );
    expect(readReporterCredential(unicode, required)).toBe("😀");
  });

  it("rejects missing, unknown, malformed, and forged credentials", () => {
    const slot = createCredentialSlotId("secret-key");
    const slots = [Object.freeze({ id: slot, required: true })];
    for (const value of [
      null,
      [],
      {},
      { unknown: "x" },
      { "secret-key": "" },
      { "secret-key": "x\0y" },
      { "secret-key": "\ud800" },
      { "secret-key": "\udc00" },
      { "secret-key": "x".repeat(8_193) },
      Object.defineProperty({}, "secret-key", { get: () => "CANARY_SECRET" }),
    ]) {
      expect(() =>
        createReporterCredentialAccessor(slots, value, null),
      ).toThrowError("destination.credential.invalid");
    }
    const accessor = createReporterCredentialAccessor(
      [Object.freeze({ id: slot, required: false })],
      {},
      null,
    );
    expect(() =>
      readReporterCredential(accessor, createCredentialSlotId("other")),
    ).toThrowError("destination.credential.invalid");
    expect(() => readReporterCredential({} as never, slot)).toThrowError(
      "destination.credential.invalid",
    );
  });

  it("exports the closed testing behavior vocabulary only from testing", () => {
    expect(REPORTER_TEST_BEHAVIORS).toEqual([
      "accept",
      "definite-reject",
      "unavailable-before-send",
      "deadline-before-send",
      "commit-then-lose-acknowledgement",
      "hang",
    ]);
    expect(Object.isFrozen(REPORTER_TEST_BEHAVIORS)).toBe(true);
  });
});
