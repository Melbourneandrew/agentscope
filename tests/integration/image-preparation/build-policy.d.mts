export type BuildNetwork = "default" | "none";
export declare const selectBuildNetwork: (value: unknown) => BuildNetwork;
export declare const builderNetworkFor: (
  selection: BuildNetwork,
) => "bridge" | "none";
export declare const buildArgumentsFor: (
  options: Readonly<{
    buildArguments: Readonly<Record<string, string>>;
    buildNetwork: BuildNetwork;
    builder: string;
    dockerfile: string;
    labels: Readonly<Record<string, string>>;
    platform: Readonly<{ os: string; architecture: string; variant?: string }>;
    tag: string;
  }>,
) => string[];
