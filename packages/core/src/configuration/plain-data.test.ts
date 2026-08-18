import { describe, expect, it } from "vitest";

import { cloneConfigurationDocument } from "./plain-data.js";

describe("bounded configuration JSON reconstruction", () => {
  it("clones and freezes every JSON value without preserving aliases", () => {
    const input = Object.assign(
      Object.create(null) as Record<string, unknown>,
      {
        values: [null, true, false, 3, "text", { nested: "value" }],
      },
    );
    const output = cloneConfigurationDocument(input);
    expect(output).toEqual(input);
    expect(output).not.toBe(input);
    expect(Object.isFrozen(output)).toBe(true);
    expect(Object.isFrozen(output.values)).toBe(true);
  });

  it("rejects non-object roots, non-JSON values, cycles, and accessors", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const accessor = Object.defineProperty({}, "value", {
      get: () => "CANARY_SECRET",
    });
    class Custom {}
    for (const input of [
      null,
      [],
      "text",
      { value: Number.NaN },
      { value: Number.POSITIVE_INFINITY },
      { value: undefined },
      { value: Symbol("value") },
      { value: () => undefined },
      cycle,
      accessor,
      new Custom(),
    ])
      expect(() => cloneConfigurationDocument(input)).toThrowError(TypeError);
  });

  it("rejects sparse, decorated, and oversized arrays", () => {
    const sparse = new Array<unknown>(2);
    sparse[1] = "present";
    const decorated = ["present"];
    Object.defineProperty(decorated, "extra", { value: true });
    const oversized = Array.from({ length: 513 }, () => null);
    for (const value of [sparse, decorated, oversized])
      expect(() => cloneConfigurationDocument({ value })).toThrowError(
        TypeError,
      );
  });

  it("enforces depth, node, key, string, and aggregate byte budgets", () => {
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let index = 0; index < 25; index += 1) {
      cursor.next = {};
      cursor = cursor.next as Record<string, unknown>;
    }
    const tooManyKeys = Object.fromEntries(
      Array.from({ length: 257 }, (_, index) => [`key-${index}`, null]),
    );
    const tooManyNodes = {
      values: Array.from({ length: 40 }, () =>
        Array.from({ length: 512 }, () => null),
      ),
    };
    const tooManyBytes = Object.fromEntries(
      Array.from({ length: 33 }, (_, index) => [
        `key-${index}`,
        "a".repeat(32_000),
      ]),
    );
    for (const input of [
      deep,
      tooManyKeys,
      tooManyNodes,
      tooManyBytes,
      { value: "a".repeat(32_769) },
    ])
      expect(() => cloneConfigurationDocument(input)).toThrowError(TypeError);
  });
});
