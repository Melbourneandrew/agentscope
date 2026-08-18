import { execFileSync } from "node:child_process";

const label = "com.agentscope.integration=true";
const list = (kind) =>
  execFileSync(
    "docker",
    [
      kind,
      "ls",
      ...(kind === "container" ? ["--all"] : []),
      "--quiet",
      "--filter",
      `label=${label}`,
    ],
    { encoding: "utf8" },
  )
    .trim()
    .split("\n")
    .filter(Boolean);
const remove = (arguments_, ids) => {
  if (ids.length === 0) return;
  console.log(`Removing Agentscope integration resources: ${ids.join(", ")}`);
  execFileSync("docker", [...arguments_, ...ids], { stdio: "inherit" });
};
remove(["rm", "--force"], list("container"));
remove(["network", "rm"], list("network"));
const images = execFileSync(
  "docker",
  ["image", "ls", "--quiet", "--filter", `label=${label}`],
  { encoding: "utf8" },
)
  .trim()
  .split("\n")
  .filter(Boolean);
remove(["image", "rm", "--force"], [...new Set(images)]);
console.log("Agentscope integration cleanup complete.");
