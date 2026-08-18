import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  createMockServerInitialization,
  MODEL_PROTOCOL_ROUTES,
} from "@agentscope/testkit";

const integrationRoot = import.meta.dirname;
const artifactsRoot = resolve(integrationRoot, "../../artifacts/integration");
mkdirSync(artifactsRoot, { recursive: true });
const target = resolve(artifactsRoot, "current-model-routes.json");
const temporary = `${target}.${process.pid}.tmp`;
writeFileSync(
  temporary,
  `${JSON.stringify(
    {
      routeFixtureVersion: 1,
      routeIds: MODEL_PROTOCOL_ROUTES.map(({ routeId }) => routeId),
      routes: MODEL_PROTOCOL_ROUTES,
      mockServerInitialization: createMockServerInitialization(),
    },
    undefined,
    2,
  )}\n`,
);
renameSync(temporary, target);
console.log(JSON.stringify({ routeCount: MODEL_PROTOCOL_ROUTES.length }));
