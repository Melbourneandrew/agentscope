import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { createProgram } from "../src/program.ts";
import { commandRegistry, commandPath } from "../src/command-registry.ts";

// AC-CLI-001.3

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const repositoryRoot = resolve(packageRoot, "../..");
const defaultDocsRoot = resolve(repositoryRoot, "apps/docs/content/docs");
const requiredSections = [
  "Syntax",
  "Output and exits",
  "Automation",
  "Diagnostics",
  "Examples",
];

function fixedError() {
  return new Error("cli.documentation.invalid");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function commandSnapshot(command) {
  return {
    arguments: command.registeredArguments.map((argument) => ({
      defaultValue: argument.defaultValue ?? null,
      name: argument.name(),
      required: argument.required,
      variadic: argument.variadic,
    })),
    description: command.description(),
    name: command.name(),
    options: command.options.map((option) => ({
      defaultValue: option.defaultValue ?? null,
      flags: option.flags,
      mandatory: option.mandatory,
      optional: option.optional,
      required: option.required,
    })),
    subcommands: command.commands.map(commandSnapshot),
  };
}

function registrySnapshot(registry) {
  return registry.map((registration) => ({
    dataSchema: registration.dataSchema,
    diagnostics: [...registration.diagnostics],
    documentationPage: registration.documentationPage,
    id: registration.id,
    kind: registration.kind,
    outputModes: [...registration.outputModes],
    path: [...registration.path],
    summary: registration.summary,
    visibility: registration.visibility,
  }));
}

export function commandContractFingerprint(registry, program) {
  const contract = stableJson({
    program: commandSnapshot(program),
    registry: registrySnapshot(registry),
    schema: "agentscope.cli.command-contract.v1",
  });
  return `sha256:${createHash("sha256").update(contract).digest("hex")}`;
}

function parseFrontmatter(source) {
  const match = /^---\n([\s\S]*?)\n---\n/u.exec(source);
  if (match === null) throw fixedError();
  const result = {};
  for (const line of match[1].split("\n")) {
    const field = /^([A-Za-z][A-Za-z0-9]*): (.+)$/u.exec(line);
    if (field === null || Object.hasOwn(result, field[1])) throw fixedError();
    result[field[1]] = field[2];
  }
  if (
    !Object.hasOwn(result, "title") ||
    !Object.hasOwn(result, "description") ||
    !Object.hasOwn(result, "command") ||
    !Object.hasOwn(result, "commandContract") ||
    Object.keys(result).some(
      (key) =>
        !["command", "commandContract", "description", "title"].includes(key),
    )
  ) {
    throw fixedError();
  }
  return result;
}

function assertPage(source, registration, fingerprint) {
  const frontmatter = parseFrontmatter(source);
  if (
    frontmatter.command !== commandPath(registration) ||
    frontmatter.commandContract !== fingerprint
  ) {
    throw fixedError();
  }
  for (const section of requiredSections) {
    if (!source.includes(`\n## ${section}\n`)) throw fixedError();
  }
  for (const diagnostic of registration.diagnostics) {
    if (!source.includes(`\`${diagnostic}\``)) throw fixedError();
  }
  for (const mode of registration.outputModes) {
    if (!source.includes(`\`${mode}\``)) throw fixedError();
  }
}

function walkFiles(root, suffix) {
  if (!existsSync(root)) throw fixedError();
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) throw fixedError();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name.endsWith(suffix)) files.push(path);
      else if (!entry.isFile()) throw fixedError();
    }
  }
  return files.sort();
}

function normalizedRelative(root, path) {
  return relative(root, path).split(sep).join("/");
}

function expectedNavigation(registrations) {
  const directories = new Map();
  for (const registration of registrations) {
    const page = registration.documentationPage;
    const directory = dirname(page);
    const name = page.slice(directory.length + 1, -".mdx".length);
    const entries = directories.get(directory) ?? [];
    if (!entries.includes(name)) entries.push(name);
    directories.set(directory, entries);
    let child = directory;
    while (child.includes("/")) {
      const parent = dirname(child);
      const childName = child.slice(parent.length + 1);
      const parentEntries = directories.get(parent) ?? [];
      if (!parentEntries.includes(childName)) parentEntries.push(childName);
      directories.set(parent, parentEntries);
      child = parent;
    }
  }
  return directories;
}

function assertNavigation(docsRoot, registrations) {
  const navigation = expectedNavigation(registrations);
  const expectedMeta = new Set();
  for (const [directory, pages] of navigation) {
    const metaPath = join(docsRoot, directory, "meta.json");
    expectedMeta.add(normalizedRelative(join(docsRoot, "cli"), metaPath));
    const parsed = JSON.parse(readFileSync(metaPath, "utf8"));
    if (
      Object.getPrototypeOf(parsed) !== Object.prototype ||
      Object.keys(parsed).length !== 1 ||
      !Array.isArray(parsed.pages) ||
      JSON.stringify(parsed.pages) !== JSON.stringify(pages)
    ) {
      throw fixedError();
    }
  }
  const actualMeta = new Set(
    walkFiles(join(docsRoot, "cli"), "meta.json").map((path) =>
      normalizedRelative(join(docsRoot, "cli"), path),
    ),
  );
  if (stableJson([...actualMeta]) !== stableJson([...expectedMeta].sort())) {
    throw fixedError();
  }
  const rootMeta = JSON.parse(
    readFileSync(join(docsRoot, "meta.json"), "utf8"),
  );
  if (!Array.isArray(rootMeta.pages) || !rootMeta.pages.includes("cli")) {
    throw fixedError();
  }
}

export function verifyCommandDocumentation({ docsRoot, program, registry }) {
  const publicCommands = registry.filter(
    (registration) => registration.visibility === "public",
  );
  const fingerprint = commandContractFingerprint(registry, program);
  const expectedPages = new Set(
    publicCommands.map((registration) => registration.documentationPage),
  );
  const actualPages = new Set(
    walkFiles(join(docsRoot, "cli"), ".mdx").map((path) =>
      normalizedRelative(docsRoot, path),
    ),
  );
  if (stableJson([...actualPages]) !== stableJson([...expectedPages].sort())) {
    throw fixedError();
  }
  for (const registration of publicCommands) {
    const page = join(docsRoot, registration.documentationPage);
    if (!statSync(page).isFile()) throw fixedError();
    assertPage(readFileSync(page, "utf8"), registration, fingerprint);
  }
  assertNavigation(docsRoot, publicCommands);
  return fingerprint;
}

export function createProductionProgramForDocumentation() {
  return createProgram({
    output: { writeErr: () => undefined, writeOut: () => undefined },
    state: { exitCode: 0 },
    version: "0.0.0",
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const program = createProductionProgramForDocumentation();
  if (process.argv.includes("--print-fingerprint")) {
    process.stdout.write(
      `${commandContractFingerprint(commandRegistry, program)}\n`,
    );
  } else {
    const fingerprint = verifyCommandDocumentation({
      docsRoot: defaultDocsRoot,
      program,
      registry: commandRegistry,
    });
    process.stdout.write(
      `Verified CLI command documentation (${fingerprint})\n`,
    );
  }
}
