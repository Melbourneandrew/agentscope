import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  existsSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";

const cacheRootInstruction =
  'RUN --network=none ["/usr/local/bin/node", "--input-type=module", "-e", "import { mkdirSync } from \'node:fs\'; for (const path of [\'/supplier/maven-repository\', \'/supplier/npm-cache\']) mkdirSync(path, { mode: 0o700 });"]';
const controlRootInstruction =
  'RUN --network=none ["/usr/local/bin/node", "--input-type=module", "-e", "import { mkdirSync } from \'node:fs\'; for (const path of [\'/opt/control\', \'/config\']) mkdirSync(path, { mode: 0o700 });"]';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const recipe = (service: boolean) => {
  const source = readFileSync(
    new URL("../mockserver-material/prepare-supplier.mjs", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("const dockerfile =");
  const end = source.indexOf("const fail =", start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const result = runInNewContext(
    `${source.slice(start, end)}; ({dockerfile, serviceDockerfile})`,
    { Buffer },
  ) as { dockerfile: Buffer; serviceDockerfile: Buffer };
  return (service ? result.serviceDockerfile : result.dockerfile).toString(
    "utf8",
  );
};
const construction = (service: boolean) => {
  const source = recipe(service);
  const instruction = source
    .split("\n")
    .find((line) => line.includes("mkdirSync"));
  expect(instruction).toBe(
    service ? controlRootInstruction : cacheRootInstruction,
  );
  if (service)
    for (const copy of [
      "COPY --chmod=0600 control-private.pem control-jwks.json /opt/control/",
      "COPY --chmod=0444 expectations.json /config/expectations.json",
    ])
      expect(source.indexOf(instruction!)).toBeLessThan(source.indexOf(copy));
  const argv = JSON.parse(
    instruction!.slice("RUN --network=none ".length),
  ) as string[];
  expect(argv.slice(0, 3)).toEqual([
    "/usr/local/bin/node",
    "--input-type=module",
    "-e",
  ]);
  return argv[3]!.replace("import { mkdirSync } from 'node:fs'; ", "");
};
const pathsFor = (service: boolean) =>
  service
    ? ["/opt/control", "/config"]
    : ["/supplier/maven-repository", "/supplier/npm-cache"];
describe("fresh offline private destination construction", () => {
  it.each([false, true])(
    "executes the fixed emitted mkdir program and refuses existing roots for service=%s",
    (service) => {
      const program = construction(service);
      const paths = pathsFor(service);
      const names = paths.map((path) => path.split("/").at(-1)!);
      for (const existing of [false, true]) {
        const root = mkdtempSync(resolve(tmpdir(), "agentscope-cache-roots-"));
        roots.push(root);
        if (existing) mkdirSync(resolve(root, names[0]!), { mode: 0o755 });
        const calls: string[] = [];
        const execute = () => {
          runInNewContext(program, {
            mkdirSync: (path: string, options: { mode: number }) => {
              expect(options).toEqual({ mode: 0o700 });
              expect(path).toMatch(
                service
                  ? /^(\/opt\/control|\/config)$/u
                  : /^\/supplier\/(maven-repository|npm-cache)$/u,
              );
              calls.push(path);
              mkdirSync(resolve(root, path.split("/").at(-1)!), options);
            },
          });
        };
        if (existing) {
          expect(execute).toThrow();
          expect(calls).toEqual([paths[0]]);
          expect(statSync(resolve(root, names[0]!)).mode & 0o777).toBe(0o755);
          expect(existsSync(resolve(root, names[1]!))).toBe(false);
        } else {
          execute();
          expect(calls).toEqual(paths);
          for (const name of names)
            expect(statSync(resolve(root, name)).mode & 0o777).toBe(0o700);
        }
      }
    },
  );
});
describe("private destination collision refusal", () => {
  it.each([0, 1])(
    "refuses directory or symlink at service path index%s without repair",
    (index) => {
      for (const symlink of [false, true]) {
        const root = mkdtempSync(
          resolve(tmpdir(), "agentscope-control-roots-"),
        );
        roots.push(root);
        const paths = pathsFor(true);
        const name = paths[index]!.split("/").at(-1)!;
        const target = resolve(root, "target");
        mkdirSync(target, { mode: 0o755 });
        if (symlink) symlinkSync(target, resolve(root, name));
        else mkdirSync(resolve(root, name), { mode: 0o755 });
        const calls: string[] = [];
        expect(() => {
          runInNewContext(construction(true), {
            mkdirSync: (path: string, options: { mode: number }) => {
              expect(options).toEqual({ mode: 0o700 });
              calls.push(path);
              mkdirSync(resolve(root, path.split("/").at(-1)!), options);
            },
          });
        }).toThrow();
        expect(calls).toEqual(paths.slice(0, index + 1));
        expect(statSync(resolve(root, name)).mode & 0o777).toBe(0o755);
        expect(statSync(target).mode & 0o777).toBe(0o755);
      }
    },
  );
});
