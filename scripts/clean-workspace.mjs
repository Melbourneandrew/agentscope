import { existsSync, realpathSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expectedWorkspacePackages } from "./workspace-packages.mjs";

const workspaceRoot = realpathSync(
  resolve(fileURLToPath(new URL("..", import.meta.url))),
);
const currentDirectory = realpathSync(process.cwd());
const allowedDirectories = new Set(
  expectedWorkspacePackages
    .keys()
    .map((path) => realpathSync(resolve(workspaceRoot, path))),
);

if (!allowedDirectories.has(currentDirectory)) {
  throw new Error(
    `Refusing to clean non-workspace directory: ${currentDirectory}`,
  );
}

const buildOutputs = [".next", ".turbo", "dist", "out", "tsconfig.tsbuildinfo"];
const arguments_ = process.argv.slice(2);
if (
  arguments_.length > 1 ||
  (arguments_.length === 1 && arguments_[0] !== "--build-outputs")
)
  throw new Error("Usage: clean-workspace.mjs [--build-outputs]");
const outputs =
  arguments_[0] === "--build-outputs"
    ? buildOutputs
    : [...buildOutputs, "coverage"];

for (const output of outputs) {
  const target = resolve(currentDirectory, output);
  if (existsSync(target)) rmSync(target, { recursive: true, force: true });
}
