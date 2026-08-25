/* v8 ignore file -- the two immutable emitted layouts are exercised causally by
   the package-dist Linux verifier and the clean-installed CLI artifact gates. */
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type LocalSqliteProductionArtifactLayout = Readonly<{
  loaderPath: string;
  reporterWorkerPath: string;
  retrieverWorkerPath: string;
  watchdogPath: string;
}>;

export const resolveLocalSqliteProductionArtifactLayout =
  (): LocalSqliteProductionArtifactLayout => {
    const modulePath = fileURLToPath(import.meta.url);
    const moduleDirectory = dirname(modulePath);
    const parentDirectory = dirname(moduleDirectory);
    if (
      basename(moduleDirectory) === "production" &&
      basename(parentDirectory) === "dist" &&
      basename(modulePath) === "production-artifact-layout.js"
    ) {
      return Object.freeze({
        loaderPath: resolve(
          moduleDirectory,
          "../native-candidate/loader/owned-loader.cjs",
        ),
        reporterWorkerPath: resolve(moduleDirectory, "reporter-child.js"),
        retrieverWorkerPath: resolve(moduleDirectory, "retriever-child.js"),
        watchdogPath: resolve(moduleDirectory, "reporter-watchdog.js"),
      });
    }
    if (
      (basename(moduleDirectory) === "bin" &&
        basename(parentDirectory) === "dist" &&
        basename(modulePath) === "agentscope.js") ||
      (basename(moduleDirectory) === "local-sqlite-runtime" &&
        basename(parentDirectory) === "internal" &&
        basename(dirname(parentDirectory)) === "dist" &&
        ["reporter-child.js", "retriever-child.js"].includes(
          basename(modulePath),
        ))
    ) {
      const distDirectory =
        basename(moduleDirectory) === "bin"
          ? parentDirectory
          : dirname(parentDirectory);
      const runtimeDirectory = resolve(
        distDirectory,
        "internal/local-sqlite-runtime",
      );
      return Object.freeze({
        loaderPath: resolve(
          distDirectory,
          "internal/local-sqlite/loader/owned-loader.cjs",
        ),
        reporterWorkerPath: resolve(runtimeDirectory, "reporter-child.js"),
        retrieverWorkerPath: resolve(runtimeDirectory, "retriever-child.js"),
        watchdogPath: resolve(runtimeDirectory, "reporter-watchdog.js"),
      });
    }
    throw new Error("destination.local-sqlite.native-unavailable");
  };
