/** Fixed conventional supplier commands; not execution or service authority. */
import { types } from "node:util";

const source = "/supplier/source";
const home = "/supplier/home";
const repository = "/supplier/maven-repository";
const node = "/supplier/tools/node/bin/node";
const maven = "/supplier/tools/apache-maven-3.9.16/bin/mvn";

// Exact authenticated POM coordinates, shared by pending and failure observers.
export const supplierMavenGoals = Object.freeze([
  "org.apache.maven.plugins:maven-compiler-plugin:3.15.0:compile",
  "org.apache.maven.plugins:maven-compiler-plugin:3.15.0:testCompile",
  "org.codehaus.mojo:templating-maven-plugin:3.1.0:filter-sources",
  "org.apache.maven.plugins:maven-enforcer-plugin:3.6.3:enforce",
  "org.apache.maven.plugins:maven-checkstyle-plugin:3.6.0:check",
  "org.codehaus.mojo:flatten-maven-plugin:1.8.0:flatten",
  "io.github.git-commit-id:git-commit-id-maven-plugin:9.0.1:revision",
  "com.github.eirslett:frontend-maven-plugin:2.0.0:install-node-and-npm",
  "com.github.eirslett:frontend-maven-plugin:2.0.0:npm",
  "org.apache.maven.plugins:maven-resources-plugin:3.5.0:copy-resources",
  "org.codehaus.mojo:exec-maven-plugin:3.6.3:exec",
  "org.apache.maven.plugins:maven-assembly-plugin:3.8.0:single",
]);

/** A last recognized INFO goal entry, never completion or a failure record. */
export const createSupplierGoalObservation = () => {
  let bytes = 0;
  let last;
  const lines = ["", ""];
  return (channel, chunk) => {
    if (
      (channel !== 0 && channel !== 1) ||
      types.isProxy(chunk) ||
      (typeof chunk !== "string" && !Buffer.isBuffer(chunk))
    )
      return;
    bytes +=
      typeof chunk === "string"
        ? Buffer.byteLength(chunk, "utf8")
        : chunk.length;
    if (bytes > 8 * 1024 * 1024) return;
    let entered;
    for (const character of chunk.toString("utf8")) {
      if (character !== "\n") {
        if (lines[channel].length <= 16_384) lines[channel] += character;
        continue;
      }
      const match =
        /^\[INFO\] --- ([A-Za-z0-9_.:-]+) \([A-Za-z0-9_. -]{1,128}\) @ [A-Za-z0-9_.-]{1,128} ---\r?$/u.exec(
          lines[channel],
        );
      lines[channel] = "";
      if (!match) continue;
      const goal = supplierMavenGoals.findIndex(
        (coordinate) =>
          coordinate
            .split(":")
            .slice(1)
            .join(":")
            .replace(/^maven-|-maven-plugin(?=:)|-plugin(?=:)/gu, "") ===
          match[1],
      );
      if (goal < 0 || goal === last) continue;
      last = goal;
      entered = `supplier-package-goal-${String.fromCharCode(97 + goal)}`;
    }
    return entered;
  };
};

// Both settings files are explicit so Maven cannot inherit a user/global mirror,
// server credential or proxy. This mirror also closes repositories in transitive
// POMs. It is conventional Maven configuration, not a dependency resolver.
export const supplierMavenSettings = `<?xml version="1.0" encoding="UTF-8"?>
<settings xmlns="http://maven.apache.org/SETTINGS/1.2.0">
  <localRepository>${repository}</localRepository>
  <interactiveMode>false</interactiveMode>
  <mirrors>
    <mirror>
      <id>agentscope-public-central</id>
      <mirrorOf>*</mirrorOf>
      <url>https://repo.maven.apache.org/maven2/</url>
    </mirror>
  </mirrors>
</settings>
`;
export const supplierGlobalMavenSettings = `<?xml version="1.0" encoding="UTF-8"?>
<settings xmlns="http://maven.apache.org/SETTINGS/1.2.0"/>
`;

const commonArguments = Object.freeze([
  "--batch-mode",
  "--no-transfer-progress",
  "--strict-checksums",
  "--settings",
  "/supplier/settings.xml",
  "--global-settings",
  "/supplier/global-settings.xml",
  `-Dmaven.repo.local=${repository}`,
  "--projects",
  "mockserver-netty",
  "--also-make",
  "-DskipTests",
  "package",
]);
const environment = Object.freeze({
  HOME: home,
  JAVA_HOME: "/supplier/tools/jdk-17.0.20.1+1",
  LANG: "C.UTF-8",
  MAVEN_USER_HOME: "/supplier/maven-home",
  NPM_CONFIG_AUDIT: "false",
  NPM_CONFIG_CACHE: "/supplier/npm-cache",
  NPM_CONFIG_FUND: "false",
  NPM_CONFIG_GLOBALCONFIG: "/supplier/global.npmrc",
  NPM_CONFIG_REGISTRY: "https://registry.npmjs.org/",
  NPM_CONFIG_UPDATE_NOTIFIER: "false",
  NPM_CONFIG_USERCONFIG: "/supplier/user.npmrc",
  PATH: "/supplier/tools/jdk-17.0.20.1+1/bin:/supplier/tools/node/bin:/usr/bin:/bin",
});

export const mockServerSupplierLayout = Object.freeze({
  source,
  reactor: `${source}/mockserver`,
  frontend: `${source}/mockserver-ui`,
  // The upstream frontend plugin installs here. Stage the authenticated Node
  // distribution in this layout before either lifecycle, not a PATH substitute.
  frontendNode: `${source}/mockserver/mockserver-netty/target/frontend/node/node`,
  frontendNpm: `${source}/mockserver/mockserver-netty/target/frontend/node/node_modules/npm/bin/npm-cli.js`,
  callback: `${source}/mockserver/mockserver-netty/src/main/java/org/mockserver/netty/websocketregistry/CallbackWebSocketServerHandler.java`,
  executable: maven,
  bootstrapNode: node,
  artifact: `${source}/mockserver/mockserver-netty/target/mockserver-netty-7.6.0-jar-with-dependencies.jar`,
});

export const mockServerSupplierBuildPlan = (phase) => {
  if (phase !== "dependency-research" && phase !== "offline-build")
    throw new Error("integration.mockserver-material.build-recipe");
  const offline = phase === "offline-build";
  return Object.freeze({
    evidenceScope: offline ? "offline-build-plan" : "dependency-research-plan",
    // This controls the supplier RUN only, not BuildKit's acquisition of its
    // exact pinned base. Neither this plan nor a cache inventory proves closure.
    runNetwork: offline ? "none" : "default",
    executable: maven,
    arguments: Object.freeze([
      ...(offline ? ["--offline"] : []),
      ...commonArguments,
    ]),
    cwd: mockServerSupplierLayout.reactor,
    environment: Object.freeze({
      ...environment,
      NPM_CONFIG_OFFLINE: offline ? "true" : "false",
    }),
  });
};
