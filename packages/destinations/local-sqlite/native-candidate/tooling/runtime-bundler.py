import json
from pathlib import Path

MODULES = (
    "lib/binding.js",
    "lib/database.js",
    "lib/index.js",
    "lib/methods/aggregate.js",
    "lib/methods/backup.js",
    "lib/methods/explain.js",
    "lib/methods/function.js",
    "lib/methods/inspect.js",
    "lib/methods/pragma.js",
    "lib/methods/serialize.js",
    "lib/methods/table.js",
    "lib/methods/transaction.js",
    "lib/methods/wrappers.js",
    "lib/sqlite-error.js",
    "lib/util.js",
)


def bundle_runtime(root: Path) -> bytes:
    sources = {
        relative: (root / relative).read_text(encoding="utf-8")
        for relative in MODULES
    }
    serialized = json.dumps(sources, ensure_ascii=False, separators=(",", ":"))
    return (
        '"use strict";\n'
        'const nativeRequire = require;\n'
        'const posix = nativeRequire("node:path").posix;\n'
        f"const sources = Object.freeze({serialized});\n"
        'const cache = new Map();\n'
        'const external = new Set(["fs", "path", "util", "node:fs", "node:path", "node:util"]);\n'
        'const load = (identifier) => {\n'
        '  if (cache.has(identifier)) return cache.get(identifier).exports;\n'
        '  const source = sources[identifier];\n'
        '  if (typeof source !== "string") throw new Error("destination.local-sqlite.native-runtime.invalid");\n'
        '  const ownedModule = { exports: {} }; cache.set(identifier, ownedModule);\n'
        '  const directory = posix.dirname(identifier);\n'
        '  const ownedRequire = (specifier) => {\n'
        '    if (external.has(specifier)) return nativeRequire(specifier);\n'
        '    if (typeof specifier !== "string" || !specifier.startsWith(".")) throw new Error("destination.local-sqlite.native-runtime.invalid");\n'
        '    let target = posix.normalize(posix.join(directory, specifier));\n'
        '    if (!target.endsWith(".js")) target += ".js";\n'
        '    if (target.startsWith("../") || !Object.hasOwn(sources, target)) throw new Error("destination.local-sqlite.native-runtime.invalid");\n'
        '    return load(target);\n'
        '  };\n'
        '  Function("exports", "require", "module", "__filename", "__dirname", source)(ownedModule.exports, ownedRequire, ownedModule, "/owned-runtime/" + identifier, "/owned-runtime/" + directory);\n'
        '  return ownedModule.exports;\n'
        '};\n'
        'module.exports = load("lib/index.js");\n'
    ).encode("utf-8")
