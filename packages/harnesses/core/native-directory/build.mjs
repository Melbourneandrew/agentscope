/** Copy prebuilt authenticated assets only. This never invokes a compiler. */
import { cp, readFile, writeFile } from "node:fs/promises";
import { verifyDirectoryArtifact } from "./verify-artifact.mjs";

const asset = await verifyDirectoryArtifact();
await cp(asset.root, new URL("../dist/directory-runtime/", import.meta.url), {
  recursive: true,
  errorOnExist: true,
  force: false,
});
const modulePath = new URL(
  "../dist/installation-directory-preimages.js",
  import.meta.url,
);
const compiled = await readFile(modulePath, "utf8");
const declaration = `const __AGENTSCOPE_DIRECTORY_MANIFEST_SHA256__ = ${JSON.stringify(asset.digest)};\n`;
if (compiled.includes("const __AGENTSCOPE_DIRECTORY_MANIFEST_SHA256__ ="))
  throw new Error("Harness directory manifest was already bound.");
await writeFile(modulePath, declaration + compiled, { flag: "w" });
const copied = await verifyDirectoryArtifact(true);
if (asset.digest !== copied.digest)
  throw new Error("Harness directory artifact changed during copy.");
