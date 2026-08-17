import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { requireExactRegularFileTree } from "./codec-tree.mjs";

const root = resolve(import.meta.dirname, "..");
const profile = JSON.parse(
  readFileSync(join(root, "src/standards/codec-profile.json"), "utf8"),
);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const fail = () => {
  throw new Error("protocol.codec.generated.invalid");
};

requireExactRegularFileTree(
  join(root, "proto"),
  profile.inputs.map(({ path }) => path),
);
requireExactRegularFileTree(
  join(root, "src/generated/otlp"),
  profile.outputs.map(({ path }) => path),
);

for (const entry of profile.inputs) {
  const bytes = readFileSync(join(root, "proto", entry.path));
  if (hash(bytes) !== entry.sha256) fail();
}
for (const entry of profile.outputs) {
  const bytes = readFileSync(join(root, "src/generated/otlp", entry.path));
  if (hash(bytes) !== entry.sha256) fail();
}

const temporary = mkdtempSync(join(tmpdir(), "agentscope-otlp-codecs-"));
try {
  const template = join(temporary, "buf.gen.yaml");
  const generated = join(temporary, "generated");
  const plugin = resolve(root, "node_modules/.bin/protoc-gen-es");
  writeFileSync(
    template,
    [
      "version: v2",
      "clean: true",
      "plugins:",
      `  - local: ${JSON.stringify(plugin)}`,
      `    out: ${JSON.stringify(generated)}`,
      "    include_imports: true",
      "    opt:",
      ...profile.generator.options.map((option) => `      - ${option}`),
      "",
    ].join("\n"),
  );
  const result = spawnSync(
    resolve(root, "node_modules/.bin/buf"),
    ["generate", "proto", "--template", template],
    { cwd: root, encoding: "utf8" },
  );
  if (result.status !== 0) fail();
  requireExactRegularFileTree(
    generated,
    profile.outputs.map(({ path }) => path),
  );
  for (const entry of profile.outputs) {
    const committed = readFileSync(
      join(root, "src/generated/otlp", entry.path),
    );
    const regenerated = readFileSync(join(generated, entry.path));
    if (!committed.equals(regenerated)) fail();
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
