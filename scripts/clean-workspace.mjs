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

for (const output of [
  ".next",
  ".turbo",
  "coverage",
  "dist",
  "out",
  "tsconfig.tsbuildinfo",
]) {
  const target = resolve(currentDirectory, output);
  if (existsSync(target)) rmSync(target, { recursive: true, force: true });
}
