import type {
  LocalResourceHomeAuthority,
  LocalResourceLifecycleCapability,
  LocalResourceLifecycleHandler,
} from "@agentscope/destinations-core";

import {
  createLocalSqliteLifecycleHandler as createBoundLifecycleHandler,
  createLocalSqliteLifecycleHandlerWithInitializer,
} from "../lifecycle/configuration.js";
import { localSqliteDestinationDescriptor } from "./descriptor.js";
import {
  getLocalSqliteProductionRuntime,
  initializeLocalSqliteProductionRuntime,
} from "./runtime.js";

export type LocalSqliteProductionComposition = Readonly<{
  destinationDescriptor: typeof localSqliteDestinationDescriptor;
  createLifecycleHandler: (
    capability: LocalResourceLifecycleCapability,
  ) => LocalResourceLifecycleHandler;
}>;

/* v8 ignore next -- the package-owned native composition is causally executed by
   the built Linux artifact verifier, not the macOS source-coverage lane. */
export const createLocalSqliteLifecycleHandler = (
  capability: LocalResourceLifecycleCapability,
): LocalResourceLifecycleHandler => {
  /* v8 ignore start -- the standalone composition uses the already bound
     package home and is exercised by the built Linux artifact verifier. */
  getLocalSqliteProductionRuntime();
  return createBoundLifecycleHandler(capability);
  /* v8 ignore stop */
};

let productionComposition:
  | Readonly<{
      authority: LocalResourceHomeAuthority;
      value: LocalSqliteProductionComposition;
    }>
  | undefined;

export const initializeLocalSqliteProductionComposition = (
  homeAuthority: LocalResourceHomeAuthority,
): LocalSqliteProductionComposition => {
  if (productionComposition !== undefined) {
    if (productionComposition.authority !== homeAuthority)
      throw new Error("destination.local-sqlite.native-unavailable");
    return productionComposition.value;
  }
  const value: LocalSqliteProductionComposition = Object.freeze({
    destinationDescriptor: localSqliteDestinationDescriptor,
    /* v8 ignore start -- this ordinary package bootstrap is causally exercised
     * by the built exact-tuple verifier, where native loading is permitted. */
    createLifecycleHandler: (capability) =>
      createLocalSqliteLifecycleHandlerWithInitializer(capability, () => {
        initializeLocalSqliteProductionRuntime(homeAuthority);
      }),
    /* v8 ignore stop */
  });
  productionComposition = Object.freeze({ authority: homeAuthority, value });
  return value;
};
