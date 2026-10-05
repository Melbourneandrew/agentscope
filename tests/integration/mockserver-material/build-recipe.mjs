/** Fixed conventional supplier commands; not execution or service authority. */

const source = "/supplier/source";
const home = "/supplier/home";
const repository = "/supplier/maven-repository";
const node = "/supplier/tools/node/bin/node";
const maven = "/supplier/tools/apache-maven-3.9.16/bin/mvn";

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
