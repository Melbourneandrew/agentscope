'use strict';

const { createHash } = require('node:crypto');
const {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  readdirSync,
} = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const expected = Object.freeze([
  Object.freeze({
    path: 'native/node127-linux-x64-glibc/agentscope_sqlite.node',
    bytes: 2213824,
    sha256: 'f441cb347cd61f73faa62f14cbfeb3c3fb62524bfbb97f3208f79360a95ddc37',
  }),
  Object.freeze({
    path: 'notices/better-sqlite3-MIT.txt',
    bytes: 1078,
    sha256: '09856b52897c91ab67e7456ef43067019f31dfd3b87fda72e655736b1ebdee55',
  }),
  Object.freeze({
    path: 'notices/node-addon-api-MIT.txt',
    bytes: 1150,
    sha256: '89024017b88a9f2b763f79b941a4f2db3b4428edfcacdc0b23866b2da633ad0c',
  }),
  Object.freeze({
    path: 'notices/sqlite-public-domain.txt',
    bytes: 231,
    sha256: '1d0f05cf16e1c2bbf53b9a00b49480fc802acec5248443c8eaef2e515333da95',
  }),
  Object.freeze({
    path: 'records/provenance.json',
    bytes: 3145,
    sha256: 'eaf233d92058f04d151f3cec1cbc6a424bda561222031d602ff9b97f820ac8a5',
  }),
  Object.freeze({
    path: 'records/release-materials.json',
    bytes: 18738,
    sha256: '90051ac04ae224b85629858af62b6aa80638c8adfb30e07b70e4f9be5b40e397',
  }),
  Object.freeze({
    path: 'records/sbom.spdx.json',
    bytes: 3537,
    sha256: '01a210d8666ffd2c742be1d98adfba697bda5e2cf79caee947d9b8fd85da13cb',
  }),
  Object.freeze({
    path: 'runtime/better-sqlite3.cjs',
    bytes: 29878,
    sha256: 'e5b029abcc18d9bc3981616bc9f0e9247be23390584f75cabe13515bccb50849',
  }),
]);

const fail = () => {
  const error = new Error('destination.local-sqlite.native-unavailable');
  error.code = 'destination.local-sqlite.native-unavailable';
  throw error;
};

const readOwned = (relativePath, maximumBytes, retain = false) => {
  const absolute = path.resolve(root, relativePath);
  if (!absolute.startsWith(`${root}${path.sep}`)) fail();
  let descriptor;
  try {
    descriptor = openSync(
      absolute,
      constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
    );
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > maximumBytes)
      fail();
    const bytes = Buffer.allocUnsafe(metadata.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, null);
      if (count < 1) fail();
      offset += count;
    }
    const overflow = Buffer.allocUnsafe(1);
    if (readSync(descriptor, overflow, 0, 1, null) !== 0) fail();
    if (fstatSync(descriptor).size !== metadata.size) fail();
    const snapshot = Object.freeze({
      bytes,
      descriptor,
      relativePath,
      device: metadata.dev,
      inode: metadata.ino,
      size: metadata.size,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
    if (!retain) {
      closeSync(descriptor);
      descriptor = undefined;
    } else descriptor = undefined;
    return snapshot;
  } catch {
    return fail();
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
};

const regularFiles = (directory = root, prefix = '', depth = 0) => {
  if (depth > 4) fail();
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) fail();
    const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory())
      files.push(...regularFiles(absolute, relative, depth + 1));
    else if (entry.isFile()) files.push(relative);
    else fail();
    if (files.length > 32 || relative.length > 256) fail();
  }
  return files.sort();
};

const compareVersion = (left, right) => {
  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);
  for (let index = 0; index < 4; index += 1) {
    const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (difference !== 0) return difference;
  }
  return 0;
};

const validateRuntime = () => {
  const report = process.report?.getReport();
  const glibc = report?.header?.glibcVersionRuntime;
  if (
    process.versions.modules !== '127' ||
    Number(process.versions.node.split('.')[0]) !== 22 ||
    process.platform !== 'linux' ||
    process.arch !== 'x64' ||
    typeof glibc !== 'string' ||
    compareVersion(glibc, '2.34') < 0 ||
    compareVersion(os.release(), '5.15') < 0
  )
    fail();
};

const verifySnapshot = (snapshot) => {
  const metadata = fstatSync(snapshot.descriptor);
  if (
    !metadata.isFile() ||
    metadata.dev !== snapshot.device ||
    metadata.ino !== snapshot.inode ||
    metadata.size !== snapshot.size
  )
    fail();
  const bytes = Buffer.allocUnsafe(snapshot.size);
  let offset = 0;
  while (offset < bytes.length) {
    const count = readSync(
      snapshot.descriptor,
      bytes,
      offset,
      bytes.length - offset,
      offset,
    );
    if (count < 1) fail();
    offset += count;
  }
  if (createHash('sha256').update(bytes).digest('hex') !== snapshot.sha256)
    fail();
  let current;
  try {
    current = openSync(
      path.resolve(root, snapshot.relativePath),
      constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
    );
    const currentMetadata = fstatSync(current);
    if (
      currentMetadata.dev !== snapshot.device ||
      currentMetadata.ino !== snapshot.inode ||
      currentMetadata.size !== snapshot.size
    )
      fail();
  } finally {
    if (current !== undefined) closeSync(current);
  }
};

const verifyClosure = (authority) => {
  const snapshots = [];
  try {
  const authorityDescriptors =
    authority !== null && typeof authority === 'object'
      ? Object.getOwnPropertyDescriptors(authority)
      : undefined;
  const authorityKeys =
    authorityDescriptors === undefined ? [] : Reflect.ownKeys(authorityDescriptors);
  const authoritySnapshot = {};
  for (const key of ['manifestDigest', 'nativeTupleId', 'platformTupleId']) {
    const descriptor = authorityDescriptors?.[key];
    if (descriptor === undefined || !('value' in descriptor)) fail();
    authoritySnapshot[key] = descriptor.value;
  }
  if (
    authorityDescriptors === undefined ||
    Object.getPrototypeOf(authority) !== Object.prototype ||
    authorityKeys.join(',') !== 'manifestDigest,nativeTupleId,platformTupleId'
  )
    fail();
  const files = regularFiles();
  const expectedFiles = [
    'loader/owned-loader.cjs',
    'records/support-manifest.json',
    ...expected.map(({ path: relativePath }) => relativePath),
  ].sort();
  if (JSON.stringify(files) !== JSON.stringify(expectedFiles)) fail();
  const manifestSnapshot = readOwned(
    'records/support-manifest.json',
    64 * 1024,
    true,
  );
  snapshots.push(manifestSnapshot);
  const manifest = JSON.parse(manifestSnapshot.bytes.toString('utf8'));
  if (
    authoritySnapshot.manifestDigest !== `sha256:${manifestSnapshot.sha256}` ||
    authoritySnapshot.nativeTupleId !== 'node127-linux-x64-glibc' ||
    authoritySnapshot.platformTupleId !== 'linux-x64-node22-ci-ext4-proposed' ||
    manifest.schemaVersion !== 1 ||
    manifest.capability !== 'local-sqlite' ||
    manifest.disposition !== 'proposed-unpublished-execution-eligible' ||
    manifest.loaderContract !== 'owned-absolute-no-discovery-v1' ||
    manifest.nativeBinaries?.length !== 1 ||
    manifest.supportedPlatforms?.length !== 1 ||
    manifest.artifactFiles?.length !== expected.length + 1 ||
    JSON.stringify(manifest.nativeBinaries[0]) !== JSON.stringify({
      tupleId: 'node127-linux-x64-glibc',
      nodeAbi: 127,
      admittedNodeMajors: [22],
      platform: 'linux',
      minimumOsVersion: '5.15',
      architecture: 'x64',
      libcFamily: 'glibc',
      minimumLibcVersion: '2.34',
      relativePath: 'native/node127-linux-x64-glibc/agentscope_sqlite.node',
      bytes: 2213824,
      digest: 'sha256:f441cb347cd61f73faa62f14cbfeb3c3fb62524bfbb97f3208f79360a95ddc37',
    }) ||
    JSON.stringify(manifest.supportedPlatforms[0]) !== JSON.stringify({
      platformId: 'linux-x64-node22-ci-ext4-proposed',
      nativeTupleId: 'node127-linux-x64-glibc',
      nodeMajor: 22,
      credentialBackend: 'ci-environment',
      filesystemProfile: 'local-ext4',
    })
  )
    fail();
  const declared = new Map(
    manifest.artifactFiles.map((artifact) => [artifact.relativePath, artifact]),
  );
  if (declared.size !== expected.length + 1) fail();
  const loaderSnapshot = readOwned('loader/owned-loader.cjs', 16 * 1024, true);
  snapshots.push(loaderSnapshot);
  const declaredLoader = declared.get('loader/owned-loader.cjs');
  if (
    declaredLoader?.kind !== 'loader' ||
    declaredLoader.bytes !== loaderSnapshot.bytes.length ||
    declaredLoader.digest !== `sha256:${loaderSnapshot.sha256}`
  )
    fail();
  let runtime;
  let binary;
  for (const artifact of expected) {
    const declaredArtifact = declared.get(artifact.path);
    if (
      declaredArtifact?.bytes !== artifact.bytes ||
      declaredArtifact.digest !== `sha256:${artifact.sha256}`
    )
      fail();
    const snapshot = readOwned(artifact.path, artifact.bytes, true);
    snapshots.push(snapshot);
    if (
      snapshot.bytes.length !== artifact.bytes ||
      snapshot.sha256 !== artifact.sha256
    )
      fail();
    if (artifact.path === 'runtime/better-sqlite3.cjs') runtime = snapshot;
    if (artifact.path.endsWith('/agentscope_sqlite.node')) binary = snapshot;
  }
  if (runtime === undefined || binary === undefined) fail();
  return Object.freeze({
    all: Object.freeze(snapshots),
    runtime,
    binary,
  });
  } catch {
    for (const snapshot of snapshots) closeSync(snapshot.descriptor);
    return fail();
  }
};

module.exports = Object.freeze({
  load(authority) {
    validateRuntime();
    const snapshots = verifyClosure(authority);
    try {
    const runtimePath = path.resolve(root, 'runtime/better-sqlite3.cjs');
    const runtimeModule = new Module(runtimePath, module);
    runtimeModule.filename = runtimePath;
    runtimeModule.paths = [];
    runtimeModule._compile(snapshots.runtime.bytes.toString('utf8'), runtimePath);
    const Database = runtimeModule.exports;
    const binaryPath = `/proc/self/fd/${snapshots.binary.descriptor}`;
    for (const snapshot of snapshots.all) verifySnapshot(snapshot);
    const nativeModule = new Module(binaryPath, module);
    nativeModule.filename = binaryPath;
    process.dlopen(nativeModule, binaryPath);
    const nativeBinding = nativeModule.exports;
    for (const snapshot of snapshots.all) verifySnapshot(snapshot);
    if (JSON.stringify(regularFiles()) !== JSON.stringify([
      'loader/owned-loader.cjs',
      'native/node127-linux-x64-glibc/agentscope_sqlite.node',
      'notices/better-sqlite3-MIT.txt',
      'notices/node-addon-api-MIT.txt',
      'notices/sqlite-public-domain.txt',
      'records/provenance.json',
      'records/release-materials.json',
      'records/sbom.spdx.json',
      'records/support-manifest.json',
      'runtime/better-sqlite3.cjs',
    ])) fail();
    return Object.freeze({
      nativeTupleId: 'node127-linux-x64-glibc',
      open(filename, options = {}) {
        for (const snapshot of snapshots.all) verifySnapshot(snapshot);
        return new Database(filename, {
          ...options,
          nativeBinding,
        });
      },
    });
    } catch {
      for (const snapshot of snapshots.all) closeSync(snapshot.descriptor);
      return fail();
    }
  },
});
