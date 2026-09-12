import {
  compileDestinationRegistry,
  getDestinationDescriptor,
  type DestinationRegistry,
} from "@agentscope/destinations-core/configuration";
import { langfuseDestinationDescriptor } from "@agentscope/destination-langfuse";
import { localSqliteDestinationDescriptor } from "@agentscope/destination-local-sqlite";

export const PRODUCT_DESTINATION_REGISTRY: DestinationRegistry =
  compileDestinationRegistry([
    langfuseDestinationDescriptor,
    localSqliteDestinationDescriptor,
  ]);

export const requireExactProductDestinationRegistry = (
  registry: DestinationRegistry,
): DestinationRegistry => {
  try {
    if (
      getDestinationDescriptor(
        registry,
        langfuseDestinationDescriptor.destinationType,
      ) === langfuseDestinationDescriptor &&
      getDestinationDescriptor(
        registry,
        localSqliteDestinationDescriptor.destinationType,
      ) === localSqliteDestinationDescriptor &&
      registry.descriptors.length === 2 &&
      registry.descriptors[0] === langfuseDestinationDescriptor &&
      registry.descriptors[1] === localSqliteDestinationDescriptor
    )
      return registry;
  } catch {
    // The fixed product inventory error remains authoritative.
  }
  throw new Error("cli.product-destination-registry.invalid");
};

export const requireExactProductDestinationRegistryForTesting = (
  registry: DestinationRegistry,
): DestinationRegistry => requireExactProductDestinationRegistry(registry);
