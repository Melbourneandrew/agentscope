/** Deterministic, identity-checked build-context traversal and tar creation. */
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { performance } from "node:perf_hooks";

import {
  defaultMaximumBuildContextBytes,
  fixedError,
  maximumHarnessBuildContextBytes,
} from "./boundary.mjs";

const writeTarText = (header, offset, length, value) => {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength > length)
    throw fixedError("integration.images.build.context-header");
  encoded.copy(header, offset);
};
const writeTarOctal = (header, offset, length, value) => {
  const encoded = value.toString(8).padStart(length - 1, "0");
  if (encoded.length > length - 1)
    throw fixedError("integration.images.build.context-header");
  writeTarText(header, offset, length, `${encoded}\0`);
};
const tarPath = (relative) => {
  const bytes = Buffer.byteLength(relative, "utf8");
  if (bytes <= 100) return { name: relative, prefix: "" };
  for (let index = relative.lastIndexOf("/"); index > 0;) {
    const prefix = relative.slice(0, index);
    const name = relative.slice(index + 1);
    if (
      Buffer.byteLength(prefix, "utf8") <= 155 &&
      Buffer.byteLength(name, "utf8") <= 100
    )
      return { name, prefix };
    index = relative.lastIndexOf("/", index - 1);
  }
  throw fixedError("integration.images.build.context-path");
};
const tarHeader = (relative, status, directory) => {
  const header = Buffer.alloc(512);
  const split = tarPath(relative);
  writeTarText(header, 0, 100, split.name);
  writeTarOctal(
    header,
    100,
    8,
    directory ? 0o755 : (status.mode & 0o111) === 0 ? 0o644 : 0o755,
  );
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, directory ? 0 : status.size);
  writeTarOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  writeTarText(header, 156, 1, directory ? "5" : "0");
  writeTarText(header, 257, 6, "ustar\0");
  writeTarText(header, 263, 2, "00");
  writeTarText(header, 345, 155, split.prefix);
  const checksum = header.reduce((total, byte) => total + byte, 0);
  writeTarText(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  return header;
};
const sameFileIdentity = (left, right) =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.mode === right.mode &&
  left.size === right.size &&
  left.mtimeNs === right.mtimeNs &&
  left.ctimeNs === right.ctimeNs;
const buildContextPathClass = (path) => {
  if (path.includes("/harness-material/")) return "harness-material";
  if (path.includes("/prepared/candidates/")) return "candidate";
  if (path.includes("/testkit/")) return "testkit";
  if (path.includes("/runtime/")) return "runtime";
  return "controller";
};
const assertBuildContextActive = (deadline, signal) => {
  if (signal?.aborted) throw fixedError("integration.images.interrupted");
  if (performance.now() > deadline)
    throw fixedError("integration.images.timeout", true);
};
const readBuildContextFile = (path, expected, state) => {
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const current = fstatSync(descriptor, { bigint: true });
    const size = Number(current.size);
    const padding = (512 - (size % 512)) % 512;
    if (!current.isFile())
      throw fixedError("integration.images.build.context-file-type");
    if (!sameFileIdentity(expected, current))
      throw fixedError("integration.images.build.context-file-identity");
    if (current.size > BigInt(state.maximumBytes()))
      throw fixedError(
        `integration.images.build.context-file-size-${buildContextPathClass(path)}-${state.maximumBytes() === defaultMaximumBuildContextBytes ? "default" : "harness"}`,
      );
    if (state.total() + 512 + size + padding + 1024 > state.maximumBytes())
      throw fixedError("integration.images.build.context-aggregate-size");
    const body = readFileSync(descriptor);
    state.assertActive();
    if (body.byteLength !== size)
      throw fixedError("integration.images.build.context-file-length");
    if (!sameFileIdentity(current, fstatSync(descriptor, { bigint: true })))
      throw fixedError("integration.images.build.context-file-race");
    return body;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
};
const visitBuildContextDirectory = (
  directoryDescriptor,
  directoryPath,
  prefix,
  state,
) => {
  state.assertActive();
  const directoryIdentity = fstatSync(directoryDescriptor, { bigint: true });
  if (
    !directoryIdentity.isDirectory() ||
    !sameFileIdentity(
      directoryIdentity,
      lstatSync(directoryPath, { bigint: true }),
    )
  )
    throw fixedError("integration.images.build.context-directory");
  const entries = readdirSync(directoryPath, { withFileTypes: true }).sort(
    (left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
  for (const entry of entries) {
    state.observeEntry();
    const childPath = `${directoryPath}/${entry.name}`;
    const status = lstatSync(childPath, { bigint: true });
    if (status.isSymbolicLink())
      throw fixedError("integration.images.build.context-symlink");
    state.afterEntry();
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    const headerStatus = {
      mode: Number(status.mode),
      size: Number(status.size),
    };
    if (status.isDirectory()) {
      const descriptor = openSync(
        childPath,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const current = fstatSync(descriptor, { bigint: true });
        if (
          !current.isDirectory() ||
          !sameFileIdentity(status, current) ||
          !sameFileIdentity(
            directoryIdentity,
            lstatSync(directoryPath, { bigint: true }),
          )
        )
          throw fixedError("integration.images.build.context-directory");
        state.append(tarHeader(`${relative}/`, headerStatus, true));
        visitBuildContextDirectory(descriptor, childPath, relative, state);
        if (!sameFileIdentity(current, fstatSync(descriptor, { bigint: true })))
          throw fixedError("integration.images.build.context-directory");
      } finally {
        closeSync(descriptor);
      }
    } else if (status.isFile()) {
      const body = readBuildContextFile(childPath, status, state);
      state.append(tarHeader(relative, headerStatus, false));
      state.append(body);
      const padding = (512 - (body.byteLength % 512)) % 512;
      if (padding > 0) state.append(Buffer.alloc(padding));
    } else throw fixedError("integration.images.build.context-special");
    if (
      !sameFileIdentity(
        directoryIdentity,
        lstatSync(directoryPath, { bigint: true }),
      )
    )
      throw fixedError("integration.images.build.context-directory");
  }
};
const boundedBuildContext = (
  root,
  {
    afterEntryForTesting,
    deadline = Number.POSITIVE_INFINITY,
    maximumBytes = defaultMaximumBuildContextBytes,
    signal,
  } = {},
) => {
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    maximumBytes > maximumHarnessBuildContextBytes
  )
    throw fixedError("integration.images.build.context-policy");
  const assertActive = () => assertBuildContextActive(deadline, signal);
  assertActive();
  const rootStatus = lstatSync(root, { bigint: true });
  if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink())
    throw fixedError("integration.images.build.context-root");
  const chunks = [];
  let total = 0;
  let entries = 0;
  const append = (chunk) => {
    assertActive();
    total += chunk.byteLength;
    if (total > maximumBytes)
      throw fixedError("integration.images.build.context-size");
    chunks.push(chunk);
  };
  const state = {
    afterEntry: () => {
      afterEntryForTesting?.(entries);
      assertActive();
    },
    append,
    assertActive,
    observeEntry: () => {
      assertActive();
      entries += 1;
      if (entries > 8_192)
        throw fixedError("integration.images.build.context-entries");
    },
    maximumBytes: () => maximumBytes,
    total: () => total,
  };
  const rootDescriptor = openSync(
    root,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const openedRoot = fstatSync(rootDescriptor, { bigint: true });
    if (!openedRoot.isDirectory() || !sameFileIdentity(rootStatus, openedRoot))
      throw fixedError("integration.images.build.context-root");
    visitBuildContextDirectory(rootDescriptor, root, "", state);
    assertActive();
    if (
      !sameFileIdentity(openedRoot, fstatSync(rootDescriptor, { bigint: true }))
    )
      throw fixedError("integration.images.build.context-root");
    append(Buffer.alloc(1024));
  } finally {
    closeSync(rootDescriptor);
  }
  return Buffer.concat(chunks);
};
export const createBoundedBuildContext = (root, options) => {
  try {
    return boundedBuildContext(root, options);
  } catch (error) {
    if (
      error instanceof Error &&
      ["integration.images.interrupted", "integration.images.timeout"].includes(
        error.message,
      )
    )
      throw error;
    if (/^integration\.images\.build\.context-[a-z-]+$/u.test(error?.message))
      throw error;
    throw fixedError("integration.images.build.context-unknown");
  }
};
