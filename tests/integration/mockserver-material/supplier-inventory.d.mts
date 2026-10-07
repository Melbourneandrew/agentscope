/** Bounded observations, not authenticated dependencies or prepared authority. */
export function inventoryMockServerSupplier(
  root: string,
  observer?: (category: "inventory-read" | "inventory-guard") => void,
): Buffer;
