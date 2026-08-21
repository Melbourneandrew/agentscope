import { copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const migrations = Object.freeze(["0001-initialize.sql"]);
const sourceRoot = new URL("../src/migrations/", import.meta.url);
const destinationRoot = new URL("../dist/migrations/", import.meta.url);

await mkdir(fileURLToPath(destinationRoot), { recursive: true, mode: 0o700 });
for (const name of migrations)
  await copyFile(new URL(name, sourceRoot), new URL(name, destinationRoot));
