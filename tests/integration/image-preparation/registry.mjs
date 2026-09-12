/** Credential-free OCI registry acquisition and exact manifest authentication. */
import { performance } from "node:perf_hooks";

import {
  boundedText,
  boundedRequest,
  digestBytes,
  digestPattern,
  fixedError,
  imagePattern,
  jsonRecord,
  maximumManifestBytes,
  maximumTokenBytes,
  normalizePlatform,
  requestWith,
  samePlatform,
} from "./boundary.mjs";

const indexMediaTypes = new Set([
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
]);
const manifestMediaTypes = new Set([
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
]);
const configMediaTypes = new Set([
  "application/vnd.oci.image.config.v1+json",
  "application/vnd.docker.container.image.v1+json",
]);
const manifestAccept = [...indexMediaTypes, ...manifestMediaTypes].join(", ");

const descriptor = (value) => {
  if (
    typeof value !== "object" ||
    value === null ||
    !digestPattern.test(value.digest ?? "") ||
    !Number.isSafeInteger(value.size) ||
    value.size < 1 ||
    !boundedText(value.mediaType, 128)
  )
    throw fixedError("integration.images.manifest");
  return value;
};
const parseManifest = (raw) => {
  const value = jsonRecord(raw, "integration.images.manifest");
  if (
    value.schemaVersion !== 2 ||
    !manifestMediaTypes.has(value.mediaType) ||
    !Array.isArray(value.layers)
  )
    throw fixedError("integration.images.manifest");
  const config = descriptor(value.config);
  if (!configMediaTypes.has(config.mediaType))
    throw fixedError("integration.images.manifest");
  return Object.freeze({ value, config });
};
export const decodeProof = (encoded) => {
  if (
    typeof encoded !== "string" ||
    encoded.length === 0 ||
    encoded.length > Math.ceil(maximumManifestBytes / 3) * 4 ||
    !/^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/u.test(
      encoded,
    )
  )
    throw fixedError("integration.images.evidence");
  const raw = Buffer.from(encoded, "base64");
  if (
    raw.byteLength < 1 ||
    raw.byteLength > maximumManifestBytes ||
    raw.toString("base64") !== encoded
  )
    throw fixedError("integration.images.evidence");
  return raw;
};
export const deriveManifestProof = ({
  configRaw,
  image,
  platform,
  rootRaw,
  selectedRaw,
}) => {
  if (!imagePattern.test(image))
    throw fixedError("integration.images.manifest");
  const normalizedPlatform = normalizePlatform(platform);
  const rootDigest = image.slice(image.lastIndexOf("@") + 1);
  if (digestBytes(rootRaw) !== rootDigest)
    throw fixedError("integration.images.manifest");
  const root = jsonRecord(rootRaw, "integration.images.manifest");
  let manifestDigest = rootDigest;
  let authoritativeRaw = rootRaw;
  if (Array.isArray(root.manifests)) {
    if (root.schemaVersion !== 2 || !indexMediaTypes.has(root.mediaType))
      throw fixedError("integration.images.manifest");
    const matches = root.manifests.filter((candidate) => {
      try {
        return (
          manifestMediaTypes.has(descriptor(candidate).mediaType) &&
          samePlatform(
            normalizePlatform(candidate.platform),
            normalizedPlatform,
          )
        );
      } catch {
        return false;
      }
    });
    if (matches.length !== 1) throw fixedError("integration.images.manifest");
    const selected = descriptor(matches[0]);
    if (
      selectedRaw.byteLength !== selected.size ||
      digestBytes(selectedRaw) !== selected.digest
    )
      throw fixedError("integration.images.manifest");
    manifestDigest = selected.digest;
    authoritativeRaw = selectedRaw;
  } else if (!rootRaw.equals(selectedRaw)) {
    throw fixedError("integration.images.manifest");
  }
  const manifest = parseManifest(authoritativeRaw);
  if (
    configRaw.byteLength !== manifest.config.size ||
    digestBytes(configRaw) !== manifest.config.digest
  )
    throw fixedError("integration.images.config");
  return Object.freeze({
    platform: normalizedPlatform,
    manifestDigest,
    configDigest: manifest.config.digest,
    configBlob: configRaw.toString("base64"),
    rootManifest: rootRaw.toString("base64"),
    selectedManifest: selectedRaw.toString("base64"),
  });
};

const parseImageReference = (image) => {
  const repository = image.slice(0, image.lastIndexOf("@"));
  const digest = image.slice(image.lastIndexOf("@") + 1);
  const parts = repository.split("/");
  const explicitRegistry =
    parts.length > 1 && /[.:]/u.test(parts[0]) ? parts.shift() : undefined;
  if (explicitRegistry !== undefined && explicitRegistry !== "docker.io")
    throw fixedError("integration.images.registry");
  let name = parts.join("/");
  if (!name.includes("/")) name = `library/${name}`;
  if (
    !/^[a-z\d]+(?:[._-][a-z\d]+)*(?:\/[a-z\d]+(?:[._-][a-z\d]+)*)+$/u.test(name)
  )
    throw fixedError("integration.images.registry");
  return Object.freeze({
    digest,
    name,
    origin: new URL("https://registry-1.docker.io"),
  });
};
export const registryTransport = (request) =>
  boundedRequest({ ...request, origin: request.origin });
export const probePinnedRegistryTlsForTesting = async (origin) => {
  if (
    !(origin instanceof URL) ||
    origin.protocol !== "https:" ||
    !["127.0.0.1", "::1"].includes(origin.hostname)
  )
    throw fixedError("integration.images.registry");
  return registryTransport({
    deadline: performance.now() + 1_000,
    headers: Object.freeze({ Accept: "application/json" }),
    method: "GET",
    origin,
    path: "/",
    maximumBytes: 1_024,
  });
};
const allowedBlobRedirect = (rawLocation) => {
  if (typeof rawLocation !== "string" || rawLocation.length > 4_096)
    throw fixedError("integration.images.registry");
  let location;
  try {
    location = new URL(rawLocation);
  } catch {
    throw fixedError("integration.images.registry");
  }
  const allowedHost =
    location.hostname === "production.cloudflare.docker.com" ||
    location.hostname === "production.cloudfront.docker.com" ||
    location.hostname.endsWith(".r2.cloudflarestorage.com");
  if (
    location.protocol !== "https:" ||
    (location.port !== "" && location.port !== "443") ||
    location.username !== "" ||
    location.password !== "" ||
    !allowedHost
  )
    throw fixedError("integration.images.registry");
  return location;
};
const bearerChallenge = (header, name) => {
  const match =
    /^Bearer realm="([^"]+)",service="([^"]+)",scope="([^"]+)"$/u.exec(
      header ?? "",
    );
  const expectedScope = `repository:${name}:pull`;
  if (
    match === null ||
    match[1] !== "https://auth.docker.io/token" ||
    match[2] !== "registry.docker.io" ||
    match[3] !== expectedScope
  )
    throw fixedError("integration.images.registry");
  return Object.freeze({
    origin: new URL("https://auth.docker.io"),
    path: `/token?service=registry.docker.io&scope=${encodeURIComponent(expectedScope)}`,
  });
};

const fetchRegistryManifest = async (
  transport,
  policy,
  signal,
  reference,
  tokenCache,
) => {
  const parsed = parseImageReference(reference);
  const path = `/v2/${parsed.name}/manifests/${parsed.digest}`;
  const perform = (token) =>
    requestWith(transport, {
      deadline: policy.workDeadline,
      headers: Object.freeze({
        Accept: manifestAccept,
        ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
      }),
      method: "GET",
      origin: parsed.origin,
      path,
      signal,
      maximumBytes: maximumManifestBytes,
    });
  let token = tokenCache.get(parsed.name);
  let response = await perform(token);
  if (response.statusCode === 401 && token === undefined) {
    const challenge = bearerChallenge(
      response.headers["www-authenticate"],
      parsed.name,
    );
    const tokenResponse = await requestWith(transport, {
      deadline: policy.workDeadline,
      headers: Object.freeze({ Accept: "application/json" }),
      method: "GET",
      origin: challenge.origin,
      path: challenge.path,
      signal,
      maximumBytes: maximumTokenBytes,
    });
    if (tokenResponse.statusCode !== 200)
      throw fixedError("integration.images.registry");
    const tokenValue = jsonRecord(
      tokenResponse.body,
      "integration.images.registry",
    );
    token = tokenValue.token ?? tokenValue.access_token;
    if (!boundedText(token, 8_192))
      throw fixedError("integration.images.registry");
    tokenCache.set(parsed.name, token);
    response = await perform(token);
  }
  if (response.statusCode !== 200)
    throw fixedError("integration.images.registry");
  const contentType = response.headers["content-type"]?.split(";", 1)[0];
  if (![...indexMediaTypes, ...manifestMediaTypes].includes(contentType))
    throw fixedError("integration.images.manifest");
  if (
    jsonRecord(response.body, "integration.images.manifest").mediaType !==
    contentType
  )
    throw fixedError("integration.images.manifest");
  const advertised = response.headers["docker-content-digest"];
  if (advertised !== undefined && advertised !== digestBytes(response.body))
    throw fixedError("integration.images.manifest");
  return response.body;
};

const fetchRegistryBlob = async ({
  digest,
  image,
  policy,
  signal,
  tokenCache,
  transport,
}) => {
  const parsed = parseImageReference(image);
  const token = tokenCache.get(parsed.name);
  if (token === undefined) throw fixedError("integration.images.registry");
  let response = await requestWith(transport, {
    deadline: policy.workDeadline,
    headers: Object.freeze({
      Accept: "application/octet-stream",
      Authorization: `Bearer ${token}`,
    }),
    method: "GET",
    origin: parsed.origin,
    path: `/v2/${parsed.name}/blobs/${digest}`,
    signal,
    maximumBytes: maximumManifestBytes,
  });
  if (response.statusCode === 302 || response.statusCode === 307) {
    const location = allowedBlobRedirect(response.headers.location);
    response = await requestWith(transport, {
      deadline: policy.workDeadline,
      headers: Object.freeze({ Accept: "application/octet-stream" }),
      method: "GET",
      origin: location,
      path: `${location.pathname}${location.search}`,
      signal,
      maximumBytes: maximumManifestBytes,
    });
  }
  if (
    response.statusCode !== 200 ||
    response.headers["content-type"]?.split(";", 1)[0] !==
      "application/octet-stream" ||
    digestBytes(response.body) !== digest ||
    (response.headers["docker-content-digest"] !== undefined &&
      response.headers["docker-content-digest"] !== digest)
  )
    throw fixedError("integration.images.config");
  return response.body;
};

export const acquireManifestProof = async ({
  image,
  platform,
  policy,
  signal,
  tokenCache,
  transport,
}) => {
  const rootRaw = await fetchRegistryManifest(
    transport,
    policy,
    signal,
    image,
    tokenCache,
  );
  const root = jsonRecord(rootRaw, "integration.images.manifest");
  let selectedRaw = rootRaw;
  if (Array.isArray(root.manifests)) {
    const matches = root.manifests.filter((candidate) => {
      try {
        return (
          manifestMediaTypes.has(descriptor(candidate).mediaType) &&
          samePlatform(normalizePlatform(candidate.platform), platform)
        );
      } catch {
        return false;
      }
    });
    if (matches.length !== 1) throw fixedError("integration.images.manifest");
    const selected = descriptor(matches[0]);
    const repository = image.slice(0, image.lastIndexOf("@"));
    selectedRaw = await fetchRegistryManifest(
      transport,
      policy,
      signal,
      `${repository}@${selected.digest}`,
      tokenCache,
    );
  }
  const selectedManifest = parseManifest(selectedRaw);
  const configRaw = await fetchRegistryBlob({
    digest: selectedManifest.config.digest,
    image,
    policy,
    signal,
    tokenCache,
    transport,
  });
  return deriveManifestProof({
    configRaw,
    image,
    platform,
    rootRaw,
    selectedRaw,
  });
};
