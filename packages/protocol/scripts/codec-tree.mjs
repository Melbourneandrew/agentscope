import { readdirSync } from "node:fs";
import { join } from "node:path";

const invalid = () => {
  throw new Error("protocol.codec.generated.invalid");
};

export const listRegularFiles = (directory, prefix = "") => {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...listRegularFiles(join(directory, entry.name), relative));
    } else if (entry.isFile()) {
      files.push(relative);
    } else {
      invalid();
    }
  }
  return files.sort();
};

export const requireExactRegularFileTree = (directory, expected) => {
  if (
    JSON.stringify(listRegularFiles(directory)) !==
    JSON.stringify([...expected].sort())
  )
    invalid();
};
