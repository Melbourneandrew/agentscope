import type {
  NativeTraceAdapter,
  NativeTraceDiscoveryItem,
  NativeTraceDiscoverOptions,
  NativeTraceProvider,
  NativeTraceKnownProvider,
  RawSourcePointer,
} from "./types.js";

export class NativeTraceAdapterRegistry {
  private readonly adapters = new Map<
    NativeTraceProvider,
    NativeTraceAdapter
  >();

  register(adapter: NativeTraceAdapter): this {
    if (this.adapters.has(adapter.provider)) {
      throw new Error(
        `Native trace adapter already registered: ${adapter.provider}`,
      );
    }
    this.adapters.set(adapter.provider, adapter);
    return this;
  }

  get(provider: NativeTraceProvider): NativeTraceAdapter | undefined {
    return this.adapters.get(provider);
  }

  require(provider: NativeTraceProvider): NativeTraceAdapter {
    const adapter = this.get(provider);
    if (!adapter) {
      throw new Error(`Native trace adapter is not registered: ${provider}`);
    }
    return adapter;
  }

  list(): NativeTraceAdapter[] {
    return [...this.adapters.values()];
  }

  async discover(
    options: NativeTraceDiscoverOptions & {
      provider?: NativeTraceProvider;
    } = {},
  ): Promise<NativeTraceDiscoveryItem[]> {
    const adapters = options.provider
      ? [this.require(options.provider)]
      : this.list();
    const results = await Promise.all(
      adapters.map((adapter) => adapter.discover(options)),
    );
    return results.flat();
  }

  adapterForSource(source: RawSourcePointer): NativeTraceAdapter | undefined {
    return this.list().find((adapter) => {
      if (adapter.canParseSource?.(source)) {
        return true;
      }
      return adapter.provider === source.provider;
    });
  }
}

export const RequiredNativeTraceProviders: readonly NativeTraceKnownProvider[] =
  ["cursor", "codex", "claude-code"] as const;

export function createNativeTraceAdapterRegistry(
  adapters: readonly NativeTraceAdapter[] = [],
): NativeTraceAdapterRegistry {
  const registry = new NativeTraceAdapterRegistry();
  for (const adapter of adapters) {
    registry.register(adapter);
  }
  return registry;
}
