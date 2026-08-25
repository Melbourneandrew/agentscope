import type {
  LocalResourceHomeAuthority,
  LocalResourceLifecycleCapability,
  LocalResourceLifecycleHandler,
} from "@agentscope/destinations-core";

import { createLocalSqliteLifecycleHandler as createBoundLifecycleHandler } from "../lifecycle/configuration.js";
import { localSqliteDestinationDescriptor } from "./descriptor.js";
import {
  bindLocalSqliteProductionHome,
  getLocalSqliteProductionRuntime,
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
  /* v8 ignore start -- this composition calls the admitted native singleton and
     is causally executed by the built Linux artifact verifier, not macOS source. */
  getLocalSqliteProductionRuntime();
  return createBoundLifecycleHandler(capability);
  /* v8 ignore stop */
};

const composition: LocalSqliteProductionComposition = Object.freeze({
  destinationDescriptor: localSqliteDestinationDescriptor,
  createLifecycleHandler: createLocalSqliteLifecycleHandler,
});

export const initializeLocalSqliteProductionComposition = (
  homeAuthority: LocalResourceHomeAuthority,
): LocalSqliteProductionComposition => {
  bindLocalSqliteProductionHome(homeAuthority);
  return composition;
};
