export type LocalResourceHomeAuthority = Readonly<{
  readonly localResourceHomeAuthority: "agentscope-destinations-core";
}>;

export type LocalResourceHome = Readonly<{
  root: string;
  platform: NodeJS.Platform;
}>;

const homes = new WeakMap<LocalResourceHomeAuthority, LocalResourceHome>();

export class LocalResourceHomeAuthorityError extends Error {
  readonly code = "destination.local-resource-home.invalid" as const;

  constructor() {
    super("destination.local-resource-home.invalid");
    this.name = "LocalResourceHomeAuthorityError";
  }
}

const platforms = new Set<NodeJS.Platform>([
  "aix",
  "android",
  "darwin",
  "freebsd",
  "haiku",
  "linux",
  "openbsd",
  "sunos",
  "win32",
  "cygwin",
  "netbsd",
]);

export const bindLocalResourceHomeAuthorityForCore = (
  home: LocalResourceHome,
): LocalResourceHomeAuthority => {
  let descriptors: PropertyDescriptorMap;
  let prototype: object | null;
  try {
    descriptors = Object.getOwnPropertyDescriptors(home);
    prototype = Reflect.getPrototypeOf(home);
  } catch {
    throw new LocalResourceHomeAuthorityError();
  }
  if (
    typeof home !== "object" ||
    home === null ||
    prototype !== Object.prototype ||
    Reflect.ownKeys(descriptors).length !== 2 ||
    Object.keys(descriptors).sort().join(",") !== "platform,root" ||
    Object.values(descriptors).some((descriptor) => !("value" in descriptor)) ||
    typeof descriptors.root?.value !== "string" ||
    descriptors.root.value.length < 1 ||
    descriptors.root.value.length > 4_096 ||
    descriptors.root.value.includes("\0") ||
    !isAbsolute(descriptors.root.value) ||
    typeof descriptors.platform?.value !== "string" ||
    !platforms.has(descriptors.platform.value as NodeJS.Platform)
  )
    throw new LocalResourceHomeAuthorityError();
  const authority = Object.freeze({
    localResourceHomeAuthority: "agentscope-destinations-core" as const,
  });
  homes.set(
    authority,
    Object.freeze({
      root: descriptors.root.value,
      platform: descriptors.platform.value as NodeJS.Platform,
    }),
  );
  return authority;
};

export const resolveLocalResourceHomeAuthority = (
  authority: LocalResourceHomeAuthority,
): LocalResourceHome => {
  const home = homes.get(authority);
  if (home === undefined) throw new LocalResourceHomeAuthorityError();
  return home;
};
import { isAbsolute } from "node:path";
