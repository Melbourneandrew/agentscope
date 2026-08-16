import { execFileSync } from "node:child_process";

const composeArgs = ["compose", "-f", "tests/integration/docker-compose.yml"];
const volumes = execFileSync(
  "docker",
  [...composeArgs, "config", "--volumes"],
  {
    encoding: "utf8",
  },
).trim();

console.log("Removing only Agentscope integration Compose volumes:");
console.log(volumes || "(none)");
execFileSync(
  "docker",
  [...composeArgs, "down", "--volumes", "--remove-orphans"],
  {
    stdio: "inherit",
  },
);
