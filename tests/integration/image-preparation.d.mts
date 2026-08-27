export interface DockerSocketIdentity {
  path: string;
  device: string;
  inode: string;
  mode: string;
  owner: string;
}

export interface ImagePreparationRequest {
  deadline: number;
  headers: Readonly<Record<string, string>>;
  method: "GET" | "POST";
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
  dockerSocketForTesting?: string;
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

export declare const revalidatePreparedImageAdmission: (
  evidence: PreparedDockerImageSet,
  image: string,
  options?: PreparePinnedDockerImagesOptions,
) => Promise<boolean>;

export declare const publishPreparedImageEvidence: (
  target: string,
  manifestIdentity: string,
  prepared: PreparedDockerImageSet,
) => void;

export declare const retirePreparedImageEvidence: (target: string) => void;

export declare const IMAGE_PREPARATION_LIMITS: Readonly<{
  maximumPreparationMilliseconds: number;
  maximumTeardownMilliseconds: number;
  maximumResponseBytes: number;
  maximumManifestBytes: number;
  maximumEvidenceBytes: number;
}>;
