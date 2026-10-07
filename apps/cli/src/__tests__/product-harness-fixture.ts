import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAgentscopeHomeResolver } from "@agentscope/core/configuration-management";

import { createHarnessCliServices } from "../harness-services.js";
import { createProductHarnessInstallationInput } from "../product-harness-installation.js";
import {
  type CodexDiscoveryPolicy,
  createProductHarnesses,
  productHarnessParentDirectoryForTesting,
} from "../product-harnesses.js";

const wrapperBytes = Buffer.from(
  "#!/usr/bin/env node\n// synthetic wrapper fixture\n",
);
const wrapperManifestBytes = Buffer.from(
  '{"name":"@openai/codex","version":"0.149.1"}\n',
);
const platformManifestBytes = Buffer.from(
  '{"name":"@openai/codex","version":"0.149.1-test-platform"}\n',
);
const nativeBytes = Buffer.from("synthetic native Codex fixture\n");
const fileIdentity = (bytes: Uint8Array) =>
  Object.freeze({
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
export const testDiscoveryPolicy: CodexDiscoveryPolicy = Object.freeze({
  platforms: Object.freeze({
    "darwin-arm64": Object.freeze({
      dependency: "@openai/codex-test-platform",
      executable: fileIdentity(nativeBytes),
      manifest: fileIdentity(platformManifestBytes),
      packageVersion: "0.149.1-test-platform",
      triple: "test-triple",
    }),
  }),
  version: "0.149.1",
  wrapper: fileIdentity(wrapperBytes),
  wrapperManifest: fileIdentity(wrapperManifestBytes),
});

const roots: string[] = [];

export const cleanupProductHarnessFixtures = async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
};

export const fixture = async (pathEntries = 1, releaseIdentity = "0.1.0") => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "agentscope-product-harness-")),
  );
  roots.push(root);
  const vendorHome = join(root, "vendor-home");
  const agentscopeRoot = join(root, "agentscope-home");
  const home = createAgentscopeHomeResolver({
    environment: { AGENTSCOPE_HOME: agentscopeRoot },
    environmentOverrideAuthority: "test",
    platform: process.platform,
  })();
  await mkdir(home.launcherDirectory, { mode: 0o700, recursive: true });
  await mkdir(home.mutationDirectory, { mode: 0o700, recursive: true });
  await mkdir(productHarnessParentDirectoryForTesting(vendorHome), {
    mode: 0o700,
    recursive: true,
  });
  const directories: string[] = [];
  const codexManifests: string[] = [];
  const codexNativeExecutables: string[] = [];
  const codexPlatformManifests: string[] = [];
  for (let index = 0; index < pathEntries; index += 1) {
    const directory = join(root, `bin-${index}`);
    const scopeRoot = join(
      root,
      `packages-${index}`,
      "node_modules",
      "@openai",
    );
    const packageRoot = join(scopeRoot, "codex");
    const packageBin = join(packageRoot, "bin");
    const platformPackage = join(scopeRoot, "codex-test-platform");
    const platformBin = join(platformPackage, "vendor", "test-triple", "bin");
    await mkdir(directory, { mode: 0o700 });
    await mkdir(packageBin, { mode: 0o700, recursive: true });
    await mkdir(platformBin, { mode: 0o700, recursive: true });
    const executable = join(packageBin, "codex.js");
    await writeFile(executable, wrapperBytes);
    await chmod(executable, 0o755);
    const manifest = join(packageRoot, "package.json");
    await writeFile(manifest, wrapperManifestBytes);
    await chmod(manifest, 0o644);
    const platformManifest = join(platformPackage, "package.json");
    await writeFile(platformManifest, platformManifestBytes, { mode: 0o644 });
    const nativeExecutable = join(platformBin, "codex");
    await writeFile(nativeExecutable, nativeBytes, { mode: 0o755 });
    await symlink(executable, join(directory, "codex"));
    directories.push(directory);
    codexManifests.push(manifest);
    codexNativeExecutables.push(nativeExecutable);
    codexPlatformManifests.push(platformManifest);
  }
  const machineEntryPath = join(root, "agentscope-hook-machine.js");
  await writeFile(machineEntryPath, "export {};\n", { mode: 0o600 });
  const input = createProductHarnesses({
    architecture: "arm64",
    codexDiscoveryPolicy: testDiscoveryPolicy,
    environment: { PATH: directories.join(":") },
    home,
    homeDirectory: vendorHome,
    installationFactory: createProductHarnessInstallationInput,
    machineEntryPath,
    nodeExecutable: process.execPath,
    platform: "darwin",
    readHookDeadlineMilliseconds: () => Promise.resolve(2_000),
    releaseIdentity,
  });
  return {
    agentscopeRoot,
    codexExecutables: directories.map((directory) => join(directory, "codex")),
    codexManifests,
    codexNativeExecutables,
    codexPlatformManifests,
    home,
    input,
    machineEntryPath,
    services: createHarnessCliServices(input),
    vendorHome,
  };
};
