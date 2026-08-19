#!/usr/bin/env node

import { runCli } from "../program.js";
import { createProductionCliServices } from "../production-services.js";

declare const __AGENTSCOPE_CLI_VERSION__: string;

process.exitCode = await runCli(process.argv.slice(2), {
  services: createProductionCliServices(),
  version: __AGENTSCOPE_CLI_VERSION__,
});
