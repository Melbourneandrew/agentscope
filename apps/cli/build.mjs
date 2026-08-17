import { readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));
const manifest = JSON.parse(
  await readFile(new URL("package.json", import.meta.url), "utf8"),
);

await rm(new URL("dist", import.meta.url), { force: true, recursive: true });
await build({
  bundle: true,
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
