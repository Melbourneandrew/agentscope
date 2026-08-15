import type { NativeAgentTrace, NativeTracePart } from "./types.js";

export type SkillDetection =
  "attribution" | "tool-call" | "injection" | "file-read" | "hook-file-read";
export type SkillUsage = { name: string; detection: SkillDetection };

const PRIORITY: Record<SkillDetection, number> = {
  attribution: 0,
  "tool-call": 1,
  injection: 2,
  "file-read": 3,
  "hook-file-read": 4,
};

const PLUGIN_PATH_RE =
  /plugins\/cache\/[^/]+\/([^/]+)\/[^/]+\/skills\/([A-Za-z0-9._-]+)/;
const SKILLS_PATH_RE = /skills\/([A-Za-z0-9._-]+)(?:\/SKILL\.md)?\s*$/;
const SKILL_MD_IN_TEXT_RE = /[\w./~-]*\/skills\/([A-Za-z0-9._-]+)\/SKILL\.md/g;
const PLUGIN_IN_TEXT_RE =
  /plugins\/cache\/[^/\s]+\/([^/\s]+)\/[^/\s]+\/skills\/([A-Za-z0-9._-]+)\/SKILL\.md/g;

export function normalizeSkillPath(path: string): string {
  const plugin = path.match(PLUGIN_PATH_RE);
  if (plugin) return `${plugin[1]}:${plugin[2]}`;
  const repo = path.match(SKILLS_PATH_RE);
  if (repo?.[1]) return repo[1];
  return path;
}

function namesFromText(text: string): string[] {
  const names = new Map<string, string>(); // bare name -> final name
  for (const m of text.matchAll(SKILL_MD_IN_TEXT_RE)) names.set(m[1], m[1]);
  for (const m of text.matchAll(PLUGIN_IN_TEXT_RE))
    names.set(m[2], `${m[1]}:${m[2]}`); // plugin match upgrades the bare entry
  return [...names.values()];
}

export function detectSkillUsage(trace: NativeAgentTrace): SkillUsage[] {
  const found = new Map<string, SkillDetection>();
  const add = (name: string | undefined, detection: SkillDetection) => {
    if (!name) return;
    const existing = found.get(name);
    if (existing === undefined || PRIORITY[detection] < PRIORITY[existing]) {
      found.set(name, detection);
    }
  };

  for (const message of trace.messages) {
    add(message.providerIds?.claude_attribution_skill, "attribution");
    for (const part of message.parts) {
      add(...fromPart(part));
    }
  }
  return [...found.entries()].map(([name, detection]) => ({ name, detection }));

  function fromPart(
    part: NativeTracePart,
  ): [string | undefined, SkillDetection] {
    switch (part.type) {
      case "tool_call": {
        if (part.call.name === "Skill") {
          const skill = (part.call.input as { skill?: unknown } | undefined)
            ?.skill;
          return [typeof skill === "string" ? skill : undefined, "tool-call"];
        }
        for (const name of namesFromText(JSON.stringify(part.call.input ?? "")))
          add(name, "file-read");
        return [undefined, "file-read"];
      }
      case "attachment": {
        if (part.name === "skill_content") {
          const path = (part.value as { path?: unknown } | undefined)?.path;
          return [
            typeof path === "string" ? normalizeSkillPath(path) : undefined,
            "injection",
          ];
        }
        return [undefined, "injection"];
      }
      case "shell_command": {
        for (const name of namesFromText(part.command.command))
          add(name, "file-read");
        return [undefined, "file-read"];
      }
      default:
        return [undefined, "file-read"];
    }
  }
}
