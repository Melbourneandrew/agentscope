export interface DockerSocketIdentity {
  path: string;
  device: string;
  inode: string;
  mode: string;
  owner: string;
}

export interface ImagePreparationRequest {
  body?: Buffer;
  deadline: number;
  headers: Readonly<Record<string, string>>;
  method: "DELETE" | "GET" | "POST";
  origin?: URL;
  path: string;
  signal?: AbortSignal;
  maximumBytes: number;
}

export interface ImagePreparationResponse {
  statusCode: number;
  headers?: Readonly<Record<string, string | readonly string[]>>;
  body: string | Buffer;
}

export interface PreparePinnedDockerImagesOptions {
  maximumPreparationMilliseconds?: number;
  teardownMilliseconds?: number;
  dockerSocket?: string;
  dockerExecutable?: string;
  buildxExecutable?: string;
  dockerEnvironment?: Readonly<Record<string, string>>;
  dockerSocketForTesting?: string;
  dockerExecutableForTesting?: string;
  buildxExecutableForTesting?: string;
  buildkitImageForTesting?: string;
  buildxRunForTesting?: (
    arguments_: readonly string[],
    options: Readonly<{
      deadline: number;
      environment: Readonly<Record<string, string>>;
      input?: Buffer;
      signal?: AbortSignal;
      teardownMilliseconds: number;
    }>,
  ) => Promise<string>;
  socketIdentityForTesting?: Readonly<DockerSocketIdentity>;
  engineRequestForTesting?: (
    request: ImagePreparationRequest,
  ) => Promise<ImagePreparationResponse>;
  registryRequestForTesting?: (
    request: ImagePreparationRequest,
  ) => Promise<ImagePreparationResponse>;
  afterPrivateRootCreatedForTesting?: (root: string) => void;
  beforePrivateCleanupForTesting?: (root: string) => void;
  signal?: AbortSignal;
}

export interface PreparedDockerImage {
  image: string;
  platform: Readonly<{
    os: string;
    architecture: string;
    variant?: string;
  }>;
  manifestDigest: string;
  configDigest: string;
  rootManifest: string;
  selectedManifest: string;
  configBlob: string;
}

export interface PreparedDockerImageSet {
  dockerSocket: Readonly<DockerSocketIdentity>;
  dockerDaemon: Readonly<{
    endpoint: string;
    socketDevice: string;
    socketInode: string;
    id: string;
    serverVersion: string;
    apiVersion: string;
    product: string;
    operatingSystem: string;
    osType: string;
    architecture: string;
  }>;
  images: readonly PreparedDockerImage[];
  preparationPolicy: Readonly<{
    maximumPreparationMilliseconds: number;
    teardownMilliseconds: number;
    maximumResponseBytes: number;
    maximumManifestBytes: number;
    maximumEvidenceBytes: number;
  }>;
  terminalCleanup: Readonly<{
    daemon: "stable";
    handles: "settled";
    privateState: "absent";
  }>;
}

export declare const preparePinnedDockerImages: (
  images: readonly string[],
  options?: PreparePinnedDockerImagesOptions,
) => Promise<PreparedDockerImageSet>;

export declare const validatePreparedImageEvidence: (
  evidence: unknown,
  manifestIdentity: string,
) => Readonly<
  PreparedDockerImageSet & {
    imageEvidenceVersion: 2;
    manifestIdentity: string;
  }
>;

export declare const readPreparedImageEvidence: (
  path: string,
  manifestIdentity: string,
) => Readonly<
  PreparedDockerImageSet & {
    imageEvidenceVersion: 2;
    manifestIdentity: string;
  }
>;

export declare const revalidatePreparedImageAdmission: (
  evidence: PreparedDockerImageSet,
  image: string,
  options?: PreparePinnedDockerImagesOptions,
) => Promise<boolean>;

export interface PreparedDockerClient {
  readonly evidence: PreparedDockerImageSet;
}

export declare const createPreparedDockerClient: (
  evidence: PreparedDockerImageSet,
  options?: PreparePinnedDockerImagesOptions,
) => PreparedDockerClient;

export declare const prepareDockerInvocation: (
  client: PreparedDockerClient,
  arguments_: readonly string[],
  signal?: AbortSignal,
) => Promise<
  Readonly<{
    executable: string;
    arguments: readonly string[];
    environment: Readonly<Record<string, string>>;
  }>
>;

export declare const createBoundedBuildContext: (
  root: string,
  options?: Readonly<{
    afterEntryForTesting?: (entryCount: number) => void;
    deadline?: number;
    signal?: AbortSignal;
  }>,
) => Buffer;

export declare const runOwnedImageCommandForTesting: (
  executable: string,
  arguments_: readonly string[],
  options: Readonly<{
    closeBarrierForTesting?: (processGroup: number) => Promise<void>;
    deadline: number;
    environment?: Readonly<Record<string, string>>;
    input?: Buffer;
    signal?: AbortSignal;
    teardownMilliseconds?: number;
  }>,
) => Promise<string>;

export declare const buildPreparedDockerImage: (
  client: PreparedDockerClient,
  options: Readonly<{
    buildArguments: Readonly<Record<string, string>>;
    afterBuildContextEntryForTesting?: (entryCount: number) => void;
    context: string;
    dockerfile: string;
    labels: Readonly<Record<string, string>>;
    maximumMilliseconds: number;
    signal?: AbortSignal;
    tag: string;
  }>,
) => Promise<string>;

export declare const closePreparedDockerClient: (
  client: PreparedDockerClient,
) => void;

export declare const preparedDockerClientRequiresOuterHostRetirement: (
  client: PreparedDockerClient,
) => boolean;

export declare const preparedDockerClientDiagnostic: (
  client: PreparedDockerClient,
) =>
  | Readonly<{
      diagnosticVersion: 1;
      stage: "builder-reconciliation";
      operationKind: string;
      identityDigests: Readonly<Record<string, string>>;
      process: Readonly<{
        exited: boolean;
        signaled: boolean;
        timedOut: boolean;
        joined: boolean;
        outputBytes: number;
        outputTruncated: boolean;
        stderrClass: string;
      }>;
      responseBytes: number;
      responseTruncated: false;
      expectedResourceCount: number;
      observedResourceCount: number;
      expectedResourceDigest: string;
      observedResourceDigest: string;
      reconciliationReasons: Readonly<Record<string, string>>;
      outcome: "retired-failure";
    }>
  | undefined;

export declare const classifyBuildxStderrForTesting: (value: unknown) => string;

export declare const markPreparedDockerClientForOuterHostRetirement: (
  client: PreparedDockerClient,
) => void;

export declare const handlePreparedDockerCleanupFailure: (
  client: PreparedDockerClient,
  error: unknown,
) => void;

export declare const assertImagePreparationPlatformForTesting: (
  platform: string,
) => void;

export declare const authenticateDockerSocketAliasForTesting: (
  policyPath: string,
  requested: string,
) => Readonly<{
  path: string;
  device: string;
  inode: string;
  mode: string;
  owner: string;
}>;

export declare const imagePreparationFailureRequiresOuterHostRetirement: (
  error: unknown,
) => boolean;

export declare const BUILDKIT_IMAGE: string;

export declare const IMAGE_PREPARATION_EXECUTION_POLICY: Readonly<{
  platform: Readonly<{
    os: "linux";
    architecture: "amd64";
    variant: "";
  }>;
  socket: "/var/run/docker.sock";
  dockerExecutables: readonly ["/usr/bin/docker"];
  buildxExecutables: readonly [
    "/usr/lib/docker/cli-plugins/docker-buildx",
    "/usr/libexec/docker/cli-plugins/docker-buildx",
  ];
}>;

export declare const probePinnedRegistryTlsForTesting: (
  origin: URL,
) => Promise<ImagePreparationResponse>;

export declare const publishPreparedImageEvidence: (
  target: string,
  manifestIdentity: string,
  prepared: PreparedDockerImageSet,
  options?: Readonly<{ maximumEvidenceBytesForTesting?: number }>,
) => void;

export declare const retirePreparedImageEvidence: (target: string) => void;

export declare const IMAGE_PREPARATION_LIMITS: Readonly<{
  maximumPreparationMilliseconds: number;
  maximumTeardownMilliseconds: number;
  maximumResponseBytes: number;
  maximumManifestBytes: number;
  maximumEvidenceBytes: number;
}>;
