/** Bounded observations, not authenticated dependencies or prepared authority. */
export function adoptMockServerSupplierCache(
  path: string,
  expected?: import("node:fs").Stats,
  observer?: (
    category:
      "parent" | "type" | "owner" | "device" | "mode" | "identity" | "io",
  ) => void,
): import("node:fs").Stats;
export function inventoryMockServerSupplier(
  root: string,
  observer?: (
    category: "inventory-read" | "inventory-guard" | "inventory-internal",
  ) => void,
): Buffer;
