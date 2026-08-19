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
