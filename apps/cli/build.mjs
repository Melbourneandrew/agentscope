import { readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));
const manifest = JSON.parse(
  await readFile(new URL("package.json", import.meta.url), "utf8"),
);

await rm(new URL("dist", import.meta.url), { force: true, recursive: true });
const coordinatorBuild = await build({
  bundle: true,
  entryPoints: [
    new URL(
      "../../packages/core/src/invocation/operational-coordinator-child.ts",
      import.meta.url,
    ).pathname,
  ],
  format: "esm",
  platform: "node",
  target: "node22",
  write: false,
});
if (coordinatorBuild.outputFiles.length !== 1) {
  throw new Error("Operational coordinator did not build as one program");
}
const coordinatorProgram = coordinatorBuild.outputFiles[0].text;
const hookVerifierBuild = await build({
  bundle: true,
  entryPoints: [
    new URL("src/hook-verifier-child.ts", import.meta.url).pathname,
  ],
  format: "esm",
  platform: "node",
  target: "node22",
  write: false,
});
if (hookVerifierBuild.outputFiles.length !== 1) {
  throw new Error("Hook verifier did not build as one program");
}
const hookVerifierProgram = hookVerifierBuild.outputFiles[0].text;
await build({
  bundle: true,
  entryPoints: [new URL("src/hook-launcher.ts", import.meta.url).pathname],
  format: "esm",
  outfile: `${packageRoot}dist/internal/agentscope-hook-launcher.js`,
  platform: "node",
  sourcemap: false,
  target: "node22",
});
await build({
  bundle: true,
  define: {
    __AGENTSCOPE_CLI_VERSION__: JSON.stringify(manifest.version),
    __AGENTSCOPE_HOOK_HARNESS_TYPES__: JSON.stringify([]),
    __AGENTSCOPE_HOOK_VERIFIER_PROGRAM__: JSON.stringify(hookVerifierProgram),
  },
  format: "esm",
  outfile: `${packageRoot}dist/internal/agentscope-hook-machine.js`,
  platform: "node",
  sourcemap: false,
  stdin: {
    contents: 'export { runOwnedHookBootstrap } from "./src/hook-machine.ts";',
    loader: "ts",
    resolveDir: packageRoot,
    sourcefile: "agentscope-hook-machine-entry.ts",
  },
  target: "node22",
});
await build({
  bundle: true,
  define: {
    __AGENTSCOPE_CLI_VERSION__: JSON.stringify(manifest.version),
    __AGENTSCOPE_OPERATIONAL_COORDINATOR_PROGRAM__:
      JSON.stringify(coordinatorProgram),
  },
  entryPoints: [new URL("src/bin/agentscope.ts", import.meta.url).pathname],
  format: "esm",
  minify: false,
  outfile: `${packageRoot}dist/bin/agentscope.js`,
  platform: "node",
  sourcemap: false,
  target: "node22",
});

const bundle = await readFile(
  new URL("dist/bin/agentscope.js", import.meta.url),
  "utf8",
);
if (!bundle.includes(JSON.stringify(manifest.version))) {
  throw new Error("Bundled CLI version does not match package.json");
}
if (
  bundle.includes("cli.hook.invalid") ||
  bundle.includes("agentscope-hook-v1-")
) {
  throw new Error(
    "Process-private hook code leaked into the public CLI bundle",
  );
}
