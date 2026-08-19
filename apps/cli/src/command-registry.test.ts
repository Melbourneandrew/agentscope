import { describe, expect, it } from "vitest";

import { compileCommandRegistry } from "./command-registry.js";

const root = {
  dataSchema: null,
  diagnostics: [],
  documentationPage: "cli/index.mdx",
  id: "root",
  kind: "root",
  outputModes: ["human"],
  path: [],
  summary: "Root.",
  visibility: "public",
};
const group = {
  dataSchema: null,
  diagnostics: [],
  documentationPage: "cli/group/index.mdx",
  id: "group",
  kind: "group",
  outputModes: ["human"],
  path: ["group"],
  summary: "Group.",
  visibility: "public",
};
const command = {
  dataSchema: "agentscope.cli.group-command.v1",
  diagnostics: ["group.failure"],
  documentationPage: "cli/group/command.mdx",
  id: "group.command",
  kind: "command",
  outputModes: ["human", "json"],
  path: ["group", "command"],
  summary: "Command.",
  visibility: "public",
};

describe("command registry compiler", () => {
  it("returns a deeply frozen parent-before-child registry", () => {
    const registry = compileCommandRegistry([command, root, group]);

    expect(registry.map((entry) => entry.id)).toEqual([
      "root",
      "group",
      "group.command",
    ]);
    expect(Object.isFrozen(registry)).toBe(true);
    expect(Object.isFrozen(registry[2]?.diagnostics)).toBe(true);
    expect(Object.isFrozen(registry[2]?.outputModes)).toBe(true);
    expect(Object.isFrozen(registry[2]?.path)).toBe(true);
  });

  it.each([
    ["missing root", [group, command]],
    ["duplicate id", [root, group, { ...command, id: "group" }]],
    ["duplicate path", [root, group, { ...command, path: ["group"] }]],
    [
      "duplicate page",
      [root, group, { ...command, documentationPage: "cli/group/index.mdx" }],
    ],
    ["missing parent", [root, command]],
    ["misnamed root", [{ ...root, id: "other" }]],
    ["nonroot empty path", [root, { ...group, path: [] }]],
    ["root data schema", [{ ...root, dataSchema: "agentscope.cli.root.v1" }]],
    ["command without schema", [root, group, { ...command, dataSchema: null }]],
    ["group machine mode", [root, { ...group, outputModes: ["json"] }]],
    ["unknown key", [{ ...root, extra: true }]],
  ])("rejects %s", (_name, input) => {
    expect(() => compileCommandRegistry(input)).toThrow();
  });
});
