import { isProxy } from "node:util/types";

export type InventoryBudget = { remainingBytes: number };
const encoder = new TextEncoder();
const maximumInventoryArrayLength = 1_024;

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const exactRecordValues = (
  value: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> | undefined => {
  if (
    isProxy(value) ||
    !isRecord(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).some((key) => typeof key !== "string") ||
    Object.keys(descriptors).sort().join("\0") !==
      [...keys].sort().join("\0") ||
    Object.values(descriptors).some((descriptor) => !("value" in descriptor))
  )
    return undefined;
  return Object.freeze(
    Object.fromEntries(
      keys.map((key) => [key, descriptors[key]!.value as unknown]),
    ),
  );
};

export const exactArrayValues = (
  value: unknown,
): readonly unknown[] | undefined => {
  if (
    isProxy(value) ||
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  )
    return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = descriptors["length"] as
    PropertyDescriptor | undefined;
  const lengthValue = lengthDescriptor?.value as unknown;
  if (
    lengthDescriptor === undefined ||
    !("value" in lengthDescriptor) ||
    !Number.isSafeInteger(lengthValue) ||
    (lengthValue as number) < 0 ||
    (lengthValue as number) > maximumInventoryArrayLength
  )
    return undefined;
  const length = lengthValue as number;
  const expected = [
    ...Array.from({ length }, (_, index) => String(index)),
    "length",
  ].sort();
  if (
    Reflect.ownKeys(descriptors).some((key) => typeof key !== "string") ||
    Object.keys(descriptors).sort().join("\0") !== expected.join("\0") ||
    Object.entries(descriptors).some(
      ([key, descriptor]) => key !== "length" && !("value" in descriptor),
    )
  )
    return undefined;
  return Object.freeze(
    Array.from(
      { length },
      (_, index) => descriptors[String(index)]!.value as unknown,
    ),
  );
};

export const consumeInventoryString = (
  value: unknown,
  maximumBytes: number,
  budget: InventoryBudget,
): value is string => {
  if (typeof value !== "string" || value.length === 0) return false;
  if (value.length > maximumBytes) return false;
  const byteLength = encoder.encode(value).byteLength;
  if (byteLength > maximumBytes || byteLength > budget.remainingBytes)
    return false;
  budget.remainingBytes -= byteLength;
  return true;
};

export type PluginLoadSelections = Readonly<Record<string, string | null>>;
const nativeId = /^[A-Za-z0-9][-A-Za-z0-9._]*@[A-Za-z0-9][-A-Za-z0-9._]*$/u;

// This projection describes loaded selections; it never replaces raw settings.
export const parsePluginLoadSelections = (
  value: unknown,
  effective: ReadonlyMap<string, Readonly<{ enabled: boolean }>>,
  budget: InventoryBudget,
): PluginLoadSelections | undefined => {
  if (
    isProxy(value) ||
    !isRecord(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    effective.size > maximumInventoryArrayLength ||
    Reflect.ownKeys(descriptors).some((key) => typeof key !== "string") ||
    Object.keys(descriptors).length !== effective.size
  )
    return undefined;
  const loaded = new Set<string>();
  const entries: [string, string | null][] = [];
  for (const [originalId, descriptor] of Object.entries(descriptors)) {
    const state = effective.get(originalId);
    if (
      state === undefined ||
      !("value" in descriptor) ||
      !consumeInventoryString(originalId, 512, budget)
    )
      return undefined;
    const selected: unknown = descriptor.value;
    if (selected !== null && !consumeInventoryString(selected, 512, budget))
      return undefined;
    if (!state.enabled && selected !== originalId) return undefined;
    if (selected !== null) {
      if (
        selected !== originalId &&
        (!nativeId.test(originalId) ||
          !nativeId.test(selected) ||
          originalId.split("@")[1] !== selected.split("@")[1] ||
          effective.has(selected))
      )
        return undefined;
      if (loaded.has(selected)) return undefined;
      loaded.add(selected);
    }
    entries.push([originalId, selected]);
  }
  return Object.freeze(Object.fromEntries(entries));
};
