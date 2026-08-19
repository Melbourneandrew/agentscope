#!/usr/bin/env node

import { runCli } from "../program.js";

declare const __AGENTSCOPE_CLI_VERSION__: string;

process.exitCode = await runCli(process.argv.slice(2), {
  version: __AGENTSCOPE_CLI_VERSION__,
});
