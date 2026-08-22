import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

from runtime_bundler import bundle_runtime


def fail() -> None:
    raise RuntimeError("destination.local-sqlite.native-build.invalid")


def sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def canonical(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def inventory(root: Path) -> list[dict[str, object]]:
    values: list[dict[str, object]] = []

    def visit(directory: Path) -> None:
        for absolute in sorted(directory.iterdir(), key=lambda value: value.name):
            if absolute.is_symlink():
                fail()
            if absolute.is_dir():
                visit(absolute)
            elif absolute.is_file():
                content = absolute.read_bytes()
                values.append(
                    {
                        "path": absolute.relative_to(root).as_posix(),
                        "bytes": len(content),
                        "sha256": sha256(content),
                    }
                )
            else:
                fail()
            if len(values) > 128:
                fail()

    visit(root)
    return values


def tree_nodes(root: Path) -> list[str]:
    values: list[str] = []
    for current, directories, files in os.walk(root, followlinks=False):
        directories.sort()
        files.sort()
        for name in directories:
            absolute = Path(current) / name
            if absolute.is_symlink():
                fail()
            values.append(f"{absolute.relative_to(root).as_posix()}/")
        for name in files:
            absolute = Path(current) / name
            if absolute.is_symlink() or not absolute.is_file():
                fail()
            values.append(absolute.relative_to(root).as_posix())
        if len(values) > 512:
            fail()
    return sorted(values)


def expected_tree_nodes(files: list[str]) -> list[str]:
    values = set(files)
    for file in files:
        parent = Path(file).parent
        while parent != Path("."):
            values.add(f"{parent.as_posix()}/")
            parent = parent.parent
    return sorted(values)


authority = Path("/authority")
material_lock = json.loads((authority / "release-materials.json").read_text())
if (
    material_lock.get("schemaVersion") != 3
    or len(material_lock.get("materials", [])) != 2
    or material_lock.get("buildGraph", {}).get("identity")
    != "agentscope-owned-cc-ar-cxx-link-v1"
    or material_lock.get("toolchainClosure", {}).get("image")
    != "node@sha256:3266bc9e8bee1acc8a77386eefaf574987d2729b8c5ec35b0dbd6ddbc40b0ce2"
):
    fail()

for material, root in zip(
    material_lock["materials"],
    (Path("/materials/better-sqlite3"), Path("/materials/node-addon-api")),
    strict=True,
):
    if inventory(root) != material["entries"]:
        fail()

source = Path("/work/source")
generated = Path("/work/generated")
output_root = Path("/work/output")
for directory in (source, generated, output_root, Path("/work/home"), Path("/work/tmp")):
    directory.mkdir(mode=0o700)
Path("/work/home/.cache/rosetta").mkdir(mode=0o700, parents=True)
shutil.copytree("/materials/better-sqlite3", source, dirs_exist_ok=True)
shutil.copytree("/materials/node-addon-api", source / "node-addon-api")
for name in ("sqlite3.c", "sqlite3.h", "sqlite3ext.h"):
    shutil.copyfile(source / "deps/sqlite3" / name, generated / name)

closed_environment = {
    "HOME": "/work/home",
    "LANG": "C",
    "LC_ALL": "C",
    "PATH": "/usr/bin:/bin",
    "SOURCE_DATE_EPOCH": "0",
    "TMPDIR": "/work/tmp",
}
expected_programs = ["/usr/bin/cc", "/usr/bin/ar", "/usr/bin/g++", "/usr/bin/g++"]
command_ledger: list[str] = []


def run(program: str, arguments: list[str]) -> None:
    if len(command_ledger) >= len(expected_programs) or program != expected_programs[len(command_ledger)]:
        fail()
    command_ledger.append(program)
    subprocess.run(
        [program, *arguments],
        cwd=output_root,
        env=closed_environment,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=True,
        timeout=120,
    )


hostile_mode = sys.argv[1] if len(sys.argv) == 2 else None
if len(sys.argv) > 2 or hostile_mode not in (None, "unexpected-descendant", "extra-allowed-executable", "unexpected-output"):
    fail()
if hostile_mode == "extra-allowed-executable":
    subprocess.run(
        ["/usr/bin/cc", "--version"],
        cwd=output_root,
        env=closed_environment,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=True,
        timeout=5,
    )
if hostile_mode == "unexpected-descendant":
    subprocess.run(
        ["cc"],
        executable="/bin/true",
        cwd=output_root,
        env=closed_environment,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=True,
        timeout=5,
    )

node_defines = [
    "-DNODE_GYP_MODULE_NAME=better_sqlite3", "-DUSING_UV_SHARED=1",
    "-DUSING_V8_SHARED=1", "-DV8_DEPRECATION_WARNINGS=1",
    "-D_GLIBCXX_USE_CXX11_ABI=1", "-D_FILE_OFFSET_BITS=64",
    "-D_LARGEFILE_SOURCE", "-D__STDC_FORMAT_MACROS", "-DOPENSSL_NO_PINSHARED",
    "-DOPENSSL_THREADS",
]
includes = [
    "-I/usr/local/include/node", "-I/usr/local/src",
    "-I/usr/local/deps/openssl/config", "-I/usr/local/deps/openssl/openssl/include",
    "-I/usr/local/deps/uv/include", "-I/usr/local/deps/zlib", "-I/usr/local/deps/v8/include",
]
common = ["-fPIC", "-pthread", "-Wall", "-Wextra", "-Wno-unused-parameter", "-m64", "-O3", "-fno-omit-frame-pointer"]
sqlite_object = output_root / "sqlite3.o"
run("/usr/bin/cc", [
    "-o", str(sqlite_object), str(generated / "sqlite3.c"), *node_defines,
    "-DHAVE_INT16_T=1", "-DHAVE_INT32_T=1", "-DHAVE_INT8_T=1", "-DHAVE_STDINT_H=1",
    "-DHAVE_UINT16_T=1", "-DHAVE_UINT32_T=1", "-DHAVE_UINT8_T=1", "-DHAVE_USLEEP=1",
    "-DSQLITE_DEFAULT_CACHE_SIZE=-16000", "-DSQLITE_DEFAULT_FOREIGN_KEYS=1",
    "-DSQLITE_DEFAULT_MEMSTATUS=0", "-DSQLITE_DEFAULT_WAL_SYNCHRONOUS=1", "-DSQLITE_DQS=0",
    "-DSQLITE_ENABLE_COLUMN_METADATA", "-DSQLITE_ENABLE_DBSTAT_VTAB", "-DSQLITE_ENABLE_DESERIALIZE",
    "-DSQLITE_ENABLE_FTS3", "-DSQLITE_ENABLE_FTS3_PARENTHESIS", "-DSQLITE_ENABLE_FTS4",
    "-DSQLITE_ENABLE_FTS5", "-DSQLITE_ENABLE_GEOPOLY", "-DSQLITE_ENABLE_JSON1",
    "-DSQLITE_ENABLE_MATH_FUNCTIONS", "-DSQLITE_ENABLE_PERCENTILE", "-DSQLITE_ENABLE_RTREE",
    "-DSQLITE_ENABLE_STAT4", "-DSQLITE_ENABLE_UPDATE_DELETE_LIMIT", "-DSQLITE_LIKE_DOESNT_MATCH_BLOBS",
    "-DSQLITE_OMIT_DEPRECATED", "-DSQLITE_OMIT_PROGRESS_CALLBACK", "-DSQLITE_OMIT_SHARED_CACHE",
    "-DSQLITE_OMIT_TCL_VARIABLE", "-DSQLITE_SOUNDEX", "-DSQLITE_THREADSAFE=2",
    "-DSQLITE_TRACE_SIZE_LIMIT=32", "-DSQLITE_USE_URI=0", "-DNDEBUG", *includes,
    f"-I{generated}", *common, "-std=c99", "-w", "-c",
])
sqlite_archive = output_root / "sqlite3.a"
run("/usr/bin/ar", ["crs", str(sqlite_archive), str(sqlite_object)])
addon_object = output_root / "better_sqlite3.o"
run("/usr/bin/g++", [
    "-o", str(addon_object), str(source / "src/better_sqlite3.cpp"), *node_defines,
    "-DNAPI_VERSION=10", "-DNAPI_DISABLE_CPP_EXCEPTIONS", "-DNODE_API_SWALLOW_UNTHROWABLE_EXCEPTIONS",
    "-DBUILDING_NODE_EXTENSION", "-DNDEBUG", *includes, f"-I{source / 'node-addon-api'}", f"-I{generated}",
    *common, "-fno-rtti", "-fno-exceptions", "-fno-strict-aliasing", "-std=c++20",
    "-fvisibility=hidden", "-fvisibility-inlines-hidden", "-flto", "-c",
])
output_path = output_root / "better_sqlite3.node"
run("/usr/bin/g++", [
    "-o", str(output_path), "-shared", "-pthread", "-rdynamic", "-flto", "-Wl,-Bsymbolic",
    "-Wl,--exclude-libs,ALL", "-m64", "-Wl,-soname=better_sqlite3.node", "-Wl,--start-group",
    str(addon_object), str(sqlite_archive), "-Wl,--end-group", "-ldl",
])
if hostile_mode == "unexpected-output":
    (source / "escaped.canary").write_text("unexpected", encoding="utf-8")
    (source / "escaped.canary").chmod(0o400)

output_inventory = inventory(output_root)
generated_inventory = inventory(generated)
source_inventory = sorted(inventory(source), key=lambda entry: entry["path"])
expected_source_inventory = sorted(
    [*material_lock["materials"][0]["entries"], *[
        {**entry, "path": f"node-addon-api/{entry['path']}"}
        for entry in material_lock["materials"][1]["entries"]
    ]], key=lambda entry: entry["path"],
)
generated_paths = ["sqlite3.c", "sqlite3.h", "sqlite3ext.h"]
output_paths = ["better_sqlite3.node", "better_sqlite3.o", "sqlite3.a", "sqlite3.o"]
expected_work_files = [
    *[f"source/{entry['path']}" for entry in expected_source_inventory],
    *[f"generated/{path}" for path in generated_paths],
    *[f"output/{path}" for path in output_paths],
]
if [entry["path"] for entry in output_inventory] != output_paths:
    fail()
if [entry["path"] for entry in generated_inventory] != generated_paths:
    fail()
if source_inventory != expected_source_inventory:
    fail()
expected_nodes = sorted([
    "home/", "home/.cache/", "home/.cache/rosetta/", "tmp/", *expected_tree_nodes(expected_work_files)
])
if tree_nodes(Path("/work")) != expected_nodes:
    fail()
if inventory(Path("/work/home")) or inventory(Path("/work/tmp")):
    fail()
if sum(int(entry["bytes"]) for entry in output_inventory) > 32 * 1024 * 1024:
    fail()
if command_ledger != expected_programs:
    fail()
output = output_path.read_bytes()
if len(output) != 2_213_824 or sha256(output) != "f441cb347cd61f73faa62f14cbfeb3c3fb62524bfbb97f3208f79360a95ddc37":
    fail()
runtime = bundle_runtime(source)
result = {
    "schemaVersion": 2,
    "buildGraph": material_lock["buildGraph"]["identity"],
    "commands": ["cc", "ar", "cxx", "link"],
    "commandLedger": command_ledger,
    "outputInventory": output_inventory,
    "generatedInventory": generated_inventory,
    "sourceInventorySha256": sha256(canonical(source_inventory).encode()),
    "workTreeNodes": tree_nodes(Path("/work")),
    "outputBytes": len(output),
    "outputSha256": sha256(output),
    "outputBase64": base64.b64encode(output).decode(),
    "runtimeBytes": len(runtime),
    "runtimeSha256": sha256(runtime),
    "runtimeBase64": base64.b64encode(runtime).decode(),
    "node": "22.18.0",
    "nodeAbi": 127,
}
sys.stdout.write(f"{canonical(result)}\n")
