#!/usr/bin/env python3
"""Repository-scoped host validation lease.

The persistent file is only a rendezvous inode. Authority is the kernel lock,
inherited by the complete command tree, and is never acquired by deleting a
filesystem name.
"""

from __future__ import annotations

import argparse
import base64
try:
    import fcntl
except ImportError:  # pragma: no cover - the supported CI/host platforms are POSIX.
    fcntl = None
import hashlib
import hmac
import json
import os
import re
import selectors
import secrets
import signal
import stat
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from urllib.parse import unquote, urlsplit


VERSION = 1
LOCK_ENV = "AGENTSCOPE_VALIDATION_LEASE_FD"
TOKEN_ENV = "AGENTSCOPE_VALIDATION_LEASE_TOKEN"
REPOSITORY_ENV = "AGENTSCOPE_VALIDATION_LEASE_REPOSITORY"
TEST_ROOT_ENV = "AGENTSCOPE_VALIDATION_LEASE_TEST_ROOT"
TEST_MODE_ENV = "AGENTSCOPE_VALIDATION_LEASE_TESTING"
TEST_BETWEEN_STEPS_ENV = "AGENTSCOPE_VALIDATION_LEASE_TEST_BETWEEN_STEPS"
TEST_AFTER_SPAWN_ENV = "AGENTSCOPE_VALIDATION_LEASE_TEST_AFTER_SPAWN"
TEST_FAILURE_ENV = "AGENTSCOPE_VALIDATION_LEASE_TEST_FAILURE"
TEST_CHILD_PID_ENV = "AGENTSCOPE_VALIDATION_LEASE_TEST_CHILD_PID"
TEST_REPLAY_OPEN_ENV = "AGENTSCOPE_VALIDATION_LEASE_TEST_REPLAY_OPEN"
REPLAY_PATH_ENV = "AGENTSCOPE_CORE_REPLAY_PRELOAD_PATH"
REPLAY_DIGEST_ENV = "AGENTSCOPE_CORE_REPLAY_PRELOAD_SHA256"
REPLAY_BYTES_ENV = "AGENTSCOPE_CORE_REPLAY_PRELOAD_BYTES"
REPLAY_ENV_PREFIX = "AGENTSCOPE_CORE_REPLAY_"
REPLAY_INPUTS = frozenset({REPLAY_PATH_ENV, REPLAY_DIGEST_ENV, REPLAY_BYTES_ENV})
WAIT_SECONDS = 5.0
OWNER_BYTES = 4096
REPLAY_MAX_BYTES = 16 * 1024
HEX_32 = re.compile(r"^[a-f0-9]{32}$")
HEX_64 = re.compile(r"^[a-f0-9]{64}$")
KIND = re.compile(r"^[a-z][a-z-]{0,31}$")


def digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def normalized_origin(value: str, base: Path) -> str:
    candidate = value.strip()
    if candidate.startswith("git@") and ":" in candidate:
        host, path = candidate[4:].split(":", 1)
        candidate = f"ssh://git@{host}/{path}"
    try:
        parsed = urlsplit(candidate)
        parsed_port = parsed.port
    except ValueError:
        raise LeaseError("repository-origin-invalid") from None
    if parsed.scheme == "file":
        return str(Path(unquote(parsed.path)).resolve())
    if parsed.scheme and parsed.netloc:
        host = (parsed.hostname or "").lower()
        port = f":{parsed_port}" if parsed_port is not None else ""
        path = parsed.path.rstrip("/")
        if path.endswith(".git"):
            path = path[:-4]
        return f"remote://{host}{port}{path}"
    path = Path(candidate).expanduser()
    return str((base / path).resolve() if not path.is_absolute() else path.resolve())


def git(root: Path, *arguments: str, required: bool = True) -> str | None:
    try:
        result = subprocess.run(
            ["git", "-C", str(root), *arguments],
            check=required,
            capture_output=True,
            text=True,
            timeout=2,
        )
    except (OSError, subprocess.SubprocessError):
        if required:
            raise LeaseError("repository-unavailable") from None
        return None
    if result.returncode != 0:
        return None
    return result.stdout.strip()


class LeaseError(Exception):
    pass


def repository_context() -> dict[str, object]:
    root = Path(git(Path.cwd(), "rev-parse", "--show-toplevel") or "").resolve()
    common_text = git(root, "rev-parse", "--git-common-dir") or ""
    common = Path(common_text)
    if not common.is_absolute():
        common = (root / common).resolve()
    try:
        common_status = common.stat()
        root_status = root.stat()
    except OSError:
        raise LeaseError("repository-unavailable") from None
    remote = git(root, "config", "--get", "remote.origin.url", required=False)
    repository_source = (
        f"origin:{normalized_origin(remote, common.parent)}"
        if remote
        else f"physical:{common_status.st_dev}:{common_status.st_ino}"
    )
    return {
        "root": root,
        "hasOrigin": bool(remote),
        "repositoryId": digest(repository_source),
        "worktreeId": digest(
            f"{root}:{root_status.st_dev}:{root_status.st_ino}"
        ),
    }


def lease_directory(context: dict[str, object]) -> Path:
    test_root = os.environ.get(TEST_ROOT_ENV)
    if test_root is not None:
        if os.environ.get(TEST_MODE_ENV) != "1" or context["hasOrigin"]:
            raise LeaseError("testing-root-forbidden")
        base = Path(test_root).resolve()
    else:
        base = Path("/tmp") / f"agentscope-validation-leases-{os.getuid()}"
    ensure_private_directory(base)
    directory = base / str(context["repositoryId"])
    ensure_private_directory(directory)
    return directory


def ensure_private_directory(path: Path) -> None:
    try:
        path.mkdir(mode=0o700, parents=True, exist_ok=True)
    except OSError:
        raise LeaseError("lease-namespace-unavailable") from None
    try:
        status = path.lstat()
    except OSError:
        raise LeaseError("lease-namespace-unavailable") from None
    if (
        not stat.S_ISDIR(status.st_mode)
        or stat.S_ISLNK(status.st_mode)
        or status.st_uid != os.getuid()
        or stat.S_IMODE(status.st_mode) & 0o077
    ):
        raise LeaseError("lease-namespace-unsafe")


def open_lock(directory: Path, name: str, inheritable: bool) -> int:
    flags = os.O_RDWR | os.O_CREAT
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(directory / name, flags, 0o600)
    except OSError:
        raise LeaseError("lease-lock-unavailable") from None
    status = os.fstat(descriptor)
    if not stat.S_ISREG(status.st_mode) or status.st_uid != os.getuid():
        os.close(descriptor)
        raise LeaseError("lease-lock-unsafe")
    os.set_inheritable(descriptor, inheritable)
    return descriptor


def directory_record(status: os.stat_result) -> tuple[int, int, int, int]:
    return (status.st_dev, status.st_ino, status.st_uid, status.st_mode)


def open_absolute_nofollow(path: Path) -> tuple[int, int, str, list[tuple[int, int, int, int]]]:
    if not path.is_absolute() or path != Path(os.path.normpath(str(path))):
        raise LeaseError("replay-preload-invalid")
    components = path.parts
    directory_descriptor = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    ancestry = [directory_record(os.fstat(directory_descriptor))]
    try:
        for component in components[1:-1]:
            next_descriptor = os.open(
                component,
                os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_NOFOLLOW", 0),
                dir_fd=directory_descriptor,
            )
            os.close(directory_descriptor)
            directory_descriptor = next_descriptor
            ancestry.append(directory_record(os.fstat(directory_descriptor)))
        descriptor = os.open(
            components[-1],
            os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0),
            dir_fd=directory_descriptor,
        )
        return descriptor, directory_descriptor, components[-1], ancestry
    except OSError:
        os.close(directory_descriptor)
        raise LeaseError("replay-preload-invalid") from None


def replay_identity(status: os.stat_result) -> tuple[int, int]:
    return (status.st_dev, status.st_ino)


def replay_payload(descriptor: int) -> bytes:
    os.lseek(descriptor, 0, os.SEEK_SET)
    payload = bytearray()
    while len(payload) <= REPLAY_MAX_BYTES:
        chunk = os.read(descriptor, min(4096, REPLAY_MAX_BYTES + 1 - len(payload)))
        if not chunk:
            break
        payload.extend(chunk)
    os.lseek(descriptor, 0, os.SEEK_SET)
    return bytes(payload)


def validate_replay_path(path: Path) -> None:
    roots = {Path(tempfile.gettempdir()).resolve(), Path("/private/tmp")}
    try:
        within_temporary = any(
            os.path.commonpath([str(path), str(root)]) == str(root)
            for root in roots
        )
    except ValueError:
        within_temporary = False
    if not within_temporary:
        raise LeaseError("replay-preload-invalid")


def open_replay_preload() -> dict[str, object]:
    supplied = {name for name in os.environ if name.startswith(REPLAY_ENV_PREFIX)}
    if supplied != REPLAY_INPUTS:
        raise LeaseError("replay-input-invalid")
    source = Path(os.environ[REPLAY_PATH_ENV])
    validate_replay_path(source)
    expected_digest = os.environ[REPLAY_DIGEST_ENV]
    try:
        expected_bytes = int(os.environ[REPLAY_BYTES_ENV])
    except ValueError:
        raise LeaseError("replay-input-invalid") from None
    if HEX_64.fullmatch(expected_digest) is None or not 0 < expected_bytes <= REPLAY_MAX_BYTES:
        raise LeaseError("replay-input-invalid")
    descriptor, parent_descriptor, name, ancestry = open_absolute_nofollow(source)
    try:
        status = os.fstat(descriptor)
        parent_status = os.fstat(parent_descriptor)
        valid = all(
            [
                stat.S_ISREG(status.st_mode),
                status.st_uid == os.getuid(),
                stat.S_IMODE(status.st_mode) == 0o600,
                status.st_nlink == 1,
                status.st_size == expected_bytes,
                stat.S_ISDIR(parent_status.st_mode),
                parent_status.st_uid == os.getuid(),
                stat.S_IMODE(parent_status.st_mode) & 0o077 == 0,
            ]
        )
        if not valid:
            raise LeaseError("replay-preload-invalid")
        payload = replay_payload(descriptor)
        if len(payload) != expected_bytes or not hmac.compare_digest(hashlib.sha256(payload).hexdigest(), expected_digest):
            raise LeaseError("replay-preload-invalid")
        current = os.stat(name, dir_fd=parent_descriptor, follow_symlinks=False)
        if replay_identity(current) != replay_identity(status):
            raise LeaseError("replay-preload-invalid")
        return {
            "descriptor": descriptor,
            "parentDescriptor": parent_descriptor,
            "source": source,
            "sourceName": name,
            "identity": replay_identity(status),
            "parentIdentity": replay_identity(parent_status),
            "ancestry": ancestry,
            "expectedBytes": expected_bytes,
            "expectedDigest": expected_digest,
            "nodeOptions": "--import=data:text/javascript;base64," + base64.b64encode(payload).decode("ascii"),
        }
    except OSError:
        raise LeaseError("replay-preload-invalid") from None
    finally:
        if sys.exc_info()[0] is not None:
            os.close(descriptor)
            os.close(parent_descriptor)


def replay_descriptor_matches(
    descriptor: int,
    identity: object,
    expected_mode: int,
    expected_bytes: object,
    expected_digest: object,
) -> bool:
    try:
        status = os.fstat(descriptor)
        payload = replay_payload(descriptor)
        return all(
            [
                replay_identity(status) == identity,
                stat.S_ISREG(status.st_mode),
                status.st_uid == os.getuid(),
                stat.S_IMODE(status.st_mode) == expected_mode,
                status.st_nlink == 1,
                status.st_size == expected_bytes,
                isinstance(expected_digest, str),
                hmac.compare_digest(hashlib.sha256(payload).hexdigest(), expected_digest),
            ]
        )
    except OSError:
        return False


def replay_source_matches(replay: dict[str, object]) -> bool:
    descriptor: int | None = None
    parent_descriptor: int | None = None
    try:
        descriptor, parent_descriptor, current_name, ancestry = open_absolute_nofollow(replay["source"])
        current = os.fstat(descriptor)
        current_parent = os.fstat(parent_descriptor)
        retained_parent = os.fstat(replay["parentDescriptor"])
        return all(
            [
                current_name == replay["sourceName"],
                ancestry == replay["ancestry"],
                replay_identity(current) == replay["identity"],
                replay_identity(current_parent) == replay["parentIdentity"],
                replay_identity(retained_parent) == replay["parentIdentity"],
                current_parent.st_uid == os.getuid(),
                retained_parent.st_uid == os.getuid(),
                stat.S_IMODE(current_parent.st_mode) & 0o077 == 0,
                stat.S_IMODE(retained_parent.st_mode) & 0o077 == 0,
                replay_descriptor_matches(
                    replay["descriptor"],
                    replay["identity"],
                    0o600,
                    replay["expectedBytes"],
                    replay["expectedDigest"],
                ),
                replay_descriptor_matches(
                    descriptor,
                    replay["identity"],
                    0o600,
                    replay["expectedBytes"],
                    replay["expectedDigest"],
                ),
            ]
        )
    except (LeaseError, OSError):
        return False
    finally:
        if descriptor is not None:
            os.close(descriptor)
        if parent_descriptor is not None:
            os.close(parent_descriptor)


def cleanup_replay_preload(replay: dict[str, object]) -> None:
    clean = replay_source_matches(replay)
    for name in ["descriptor", "parentDescriptor"]:
        try:
            os.close(replay[name])
        except OSError:
            clean = False
    if not clean:
        raise LeaseError("replay-preload-cleanup-unresolved") from None


def process_start(pid: int) -> tuple[str, str | None]:
    if pid < 1:
        return ("absent", None)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return ("absent", None)
    except PermissionError:
        return ("uncertain", None)
    try:
        if sys.platform.startswith("linux"):
            value = Path(f"/proc/{pid}/stat").read_text(encoding="utf-8")
            fields = value[value.rfind(")") + 2 :].split()
            return ("live", digest(fields[19]))
        result = subprocess.run(
            ["ps", "-o", "lstart=", "-p", str(pid)],
            check=False,
            capture_output=True,
            text=True,
            timeout=2,
        )
        value = result.stdout.strip()
        return ("live", digest(value)) if result.returncode == 0 and value else ("absent", None)
    except (OSError, IndexError, subprocess.SubprocessError):
        return ("uncertain", None)


def exact_process(pid: object, expected: object) -> str:
    if not isinstance(pid, int) or not isinstance(expected, str):
        return "absent"
    state, current = process_start(pid)
    if state != "live":
        return state
    return "live" if hmac.compare_digest(current or "", expected) else "mismatch"


def read_owner(directory: Path) -> dict[str, object] | None:
    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(directory / "owner.json", flags)
    except FileNotFoundError:
        return None
    except OSError:
        raise LeaseError("owner-record-invalid") from None
    try:
        status = os.fstat(descriptor)
        if (
            not stat.S_ISREG(status.st_mode)
            or status.st_uid != os.getuid()
            or status.st_size < 2
            or status.st_size > OWNER_BYTES
        ):
            raise LeaseError("owner-record-invalid")
        payload = os.read(descriptor, OWNER_BYTES + 1)
    finally:
        os.close(descriptor)
    try:
        value = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise LeaseError("owner-record-invalid") from None
    if not isinstance(value, dict):
        raise LeaseError("owner-record-invalid")
    keys = {
        "version",
        "leaseId",
        "tokenHash",
        "repositoryId",
        "worktreeId",
        "rootKind",
        "ownerPid",
        "ownerStart",
        "groupPid",
        "groupStart",
        "acquiredUnixMilliseconds",
    }
    group_pair = (value.get("groupPid"), value.get("groupStart"))
    valid = all(
        [
            set(value) == keys,
            value.get("version") == VERSION,
            isinstance(value.get("leaseId"), str)
            and HEX_32.fullmatch(value["leaseId"]) is not None,
            all(
                isinstance(value.get(name), str)
                and HEX_64.fullmatch(value[name]) is not None
                for name in ["tokenHash", "repositoryId", "worktreeId", "ownerStart"]
            ),
            isinstance(value.get("rootKind"), str)
            and KIND.fullmatch(value["rootKind"]) is not None,
            isinstance(value.get("ownerPid"), int)
            and 0 < value["ownerPid"] < 2**31,
            group_pair == (None, None)
            or (
                isinstance(group_pair[0], int)
                and 0 < group_pair[0] < 2**31
                and isinstance(group_pair[1], str)
                and HEX_64.fullmatch(group_pair[1]) is not None
            ),
            isinstance(value.get("acquiredUnixMilliseconds"), int)
            and value["acquiredUnixMilliseconds"] > 0,
        ]
    )
    if not valid:
        raise LeaseError("owner-record-invalid")
    return value


def write_owner(directory: Path, owner: dict[str, object]) -> None:
    temporary = directory / f"owner.{owner['leaseId']}.tmp"
    payload = (json.dumps(owner, sort_keys=True, separators=(",", ":")) + "\n").encode()
    descriptor: int | None = None
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        remaining = memoryview(payload)
        while remaining:
            written = os.write(descriptor, remaining)
            if written < 1 or written > len(remaining):
                raise OSError("short owner write")
            remaining = remaining[written:]
        os.fsync(descriptor)
        os.close(descriptor)
        descriptor = None
        os.replace(temporary, directory / "owner.json")
    except OSError:
        if descriptor is not None:
            try:
                os.close(descriptor)
            except OSError:
                pass
        try:
            temporary.unlink()
        except OSError:
            pass
        raise LeaseError("owner-write-failed") from None


def clear_owned_record(directory: Path, lease_id: str) -> None:
    try:
        owner = read_owner(directory)
        if owner is not None and hmac.compare_digest(str(owner.get("leaseId")), lease_id):
            (directory / "owner.json").unlink()
    except (LeaseError, OSError):
        raise LeaseError("owner-cleanup-uncertain") from None


def stale_state(owner: dict[str, object] | None) -> str:
    if owner is None:
        return "absent"
    owner_state = exact_process(owner.get("ownerPid"), owner.get("ownerStart"))
    group_pid = owner.get("groupPid")
    group_start = owner.get("groupStart")
    group_status = (
        group_state(group_pid, group_start)
        if isinstance(group_pid, int) and isinstance(group_start, str)
        else "absent"
    )
    if owner_state in {"live", "uncertain"} or group_status in {"live", "orphaned", "uncertain"}:
        return "uncertain"
    return "stale"


def acquire(descriptor: int) -> bool:
    if fcntl is None:
        raise LeaseError("platform-lock-unavailable")
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return True
    except BlockingIOError:
        return False


def acquire_until(descriptor: int, deadline: float) -> bool:
    while True:
        if acquire(descriptor):
            return True
        if time.monotonic() >= deadline:
            return False
        time.sleep(0.01)


def owner_summary(directory: Path) -> str:
    try:
        owner = read_owner(directory)
    except LeaseError:
        return "owner=unavailable"
    if owner is None:
        return "owner=unavailable"
    kind = owner.get("rootKind")
    pid = owner.get("ownerPid")
    owner_id = str(owner.get("leaseId", ""))[:12]
    if kind not in COMMANDS or not isinstance(pid, int) or len(owner_id) != 12:
        return "owner=unavailable"
    return f"command={kind} owner={owner_id} pid={pid}"


def command_steps(kind: str, root: Path) -> list[tuple[Path, list[str], dict[str, str]]]:
    integration = root / "tests/integration"
    plain: dict[str, list[tuple[Path, list[str], dict[str, str]]]] = {
        "lint": [(root, ["pnpm", "verify:targets"], {}), (root, ["pnpm", "verify:quality"], {}), (root, ["eslint", "scripts", "*.mjs", "vitest.config.ts", "--max-warnings=0"], {}), (root, ["nx", "run-many", "-t", "lint", "--all"], {})],
        "typecheck": [(root, ["pnpm", "verify:targets"], {}), (root, ["nx", "run-many", "-t", "typecheck", "--all"], {})],
        "test-unit": [(root, ["pnpm", "verify:targets"], {}), (root, ["pnpm", "test:workspace-policy"], {}), (root, ["nx", "run-many", "-t", "test", "--all"], {})],
        "coverage": [(root, ["pnpm", "verify:targets"], {}), (root, ["nx", "run-many", "-t", "coverage", "--all"], {})],
        "build": [(root, ["pnpm", "verify:targets"], {}), (root, ["nx", "run-many", "-t", "build", "--all"], {})],
        "clean": [(root, ["pnpm", "verify:targets"], {}), (root, ["nx", "run-many", "-t", "clean", "--all"], {})],
        "core-artifact-replay": [
            (root, ["pnpm", "nx", "run", "@agentscope/core:build", "--skip-nx-cache"], {}),
            (root, ["pnpm", "nx", "run", "@agentscope/core:build", "--skip-nx-cache"], {}),
        ],
        "native-candidate": [(root, ["node", "packages/destinations/local-sqlite/native-candidate/verify-artifact.mjs"], {})],
        "integration-clean": [(root, ["node", "tests/integration/clean.mjs"], {})],
        "integration-runner": [(root, ["node", "tests/integration/runner.mjs"], {})],
        "precommit": [(root, ["lint-staged"], {}), (root, ["node", "scripts/typecheck-staged.mjs"], {})],
        "integration-candidate": [(integration, ["pnpm", "--filter", "agentscope-cli", "verify:artifact"], {}), (integration, ["node", "prepare-cli.mjs"], {})],
        "integration-images": [(integration, ["node", "prepare-images.mjs"], {})],
        "integration-model-routes": [(integration, ["pnpm", "--filter", "@agentscope/testkit", "build"], {}), (integration, ["node", "prepare-model-routes.mjs"], {})],
        "integration-scenarios": [(integration, ["node", "run-scenarios.mjs"], {})],
    }
    if kind == "test":
        return command_steps("test-unit", root)
    if kind == "validate":
        steps = [
            (root, ["pnpm", value], {})
            for value in [
                "verify:workspace",
                "verify:acceptance-evidence",
                "format:check",
            ]
        ]
        for nested_kind in ["lint", "typecheck", "test-unit", "coverage", "build"]:
            steps.extend(command_steps(nested_kind, root))
        steps.append((root, ["pnpm", "verify:cli-artifact"], {}))
        steps.extend(command_steps("native-candidate", root))
        return steps
    if kind == "prepush":
        return command_steps("validate", root)
    if kind == "integration":
        steps = [(root, ["pnpm", "--filter", "@agentscope/integration", "build"], {})]
        steps.extend(command_steps("integration-candidate", root))
        steps.append((root, ["pnpm", "--filter", "@agentscope/integration", "maintain:artifacts"], {}))
        steps.append((root, ["pnpm", "--filter", "@agentscope/integration", "select"], {"AGENTSCOPE_INTEGRATION_FULL": "1"}))
        steps.extend(command_steps("integration-images", root))
        steps.extend(command_steps("integration-model-routes", root))
        steps.extend(command_steps("integration-scenarios", root))
        steps.append((root, ["pnpm", "--filter", "@agentscope/integration", "maintain:artifacts"], {}))
        return steps
    return plain[kind]


# Root-wide Nx lanes and every host entry that creates, runs, or removes native
# or Docker aggregate state are leased. Focused package scripts intentionally
# remain outside this closed set.
COMMANDS = frozenset({"lint", "typecheck", "test", "test-unit", "coverage", "build", "clean", "core-artifact-replay", "native-candidate", "validate", "precommit", "prepush", "integration", "integration-clean", "integration-runner", "integration-candidate", "integration-images", "integration-model-routes", "integration-scenarios"})


def nested_owner(context: dict[str, object], directory: Path) -> tuple[int, str] | None:
    token = os.environ.get(TOKEN_ENV)
    descriptor_text = os.environ.get(LOCK_ENV)
    if token is None and descriptor_text is None:
        return None
    try:
        descriptor = int(descriptor_text or "")
        owner = read_owner(directory)
        lock_status = os.stat(directory / "lease.lock")
        inherited = os.fstat(descriptor)
        if fcntl is None:
            raise LeaseError("platform-lock-unavailable")
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except (ValueError, OSError, BlockingIOError, LeaseError):
        raise LeaseError("nested-authority-invalid") from None
    valid = owner is not None and all([
        owner.get("repositoryId") == context["repositoryId"],
        os.environ.get(REPOSITORY_ENV) == context["repositoryId"],
        owner.get("worktreeId") == context["worktreeId"],
        hmac.compare_digest(str(owner.get("tokenHash", "")), digest(token or "")),
        exact_process(owner.get("ownerPid"), owner.get("ownerStart")) == "live",
        exact_process(owner.get("groupPid"), owner.get("groupStart")) == "live",
        os.getpgrp() == owner.get("groupPid"),
        (lock_status.st_dev, lock_status.st_ino) == (inherited.st_dev, inherited.st_ino),
    ])
    if not valid:
        raise LeaseError("nested-authority-invalid")
    return descriptor, token or ""


def group_state(pid: int, start: str) -> str:
    try:
        os.killpg(pid, 0)
    except ProcessLookupError:
        return "absent"
    except PermissionError:
        return "uncertain"
    identity = exact_process(pid, start)
    if identity in {"live", "mismatch"}:
        return identity
    return "orphaned" if identity == "absent" else "uncertain"


def wait_for_group_absence(pid: int, start: str, deadline: float) -> bool:
    while time.monotonic() < deadline:
        if group_state(pid, start) == "absent":
            return True
        time.sleep(0.02)
    return False


def test_steps(test_command: list[str], root: Path) -> list[tuple[Path, list[str], dict[str, str]]]:
    return [(root, test_command, {})]


def test_barrier(context: dict[str, object], environment_name: str) -> None:
    path = os.environ.get(environment_name)
    if path is None:
        return
    if os.environ.get(TEST_MODE_ENV) != "1" or context["hasOrigin"]:
        raise LeaseError("testing-barrier-forbidden")
    ready = Path(f"{path}.ready")
    release = Path(f"{path}.release")
    ready.write_text("ready", encoding="utf-8")
    deadline = time.monotonic() + 2
    while not release.exists():
        if time.monotonic() >= deadline:
            raise LeaseError("testing-barrier-timeout")
        time.sleep(0.01)


def inject_test_failure(context: dict[str, object], phase: str) -> None:
    if os.environ.get(TEST_FAILURE_ENV) != phase:
        return
    if os.environ.get(TEST_MODE_ENV) != "1" or context["hasOrigin"]:
        raise LeaseError("testing-failure-forbidden")
    raise LeaseError("injected-step-failure")


def write_all(descriptor: int, payload: bytes, writer=os.write) -> None:
    remaining = memoryview(payload)
    while remaining:
        written = writer(descriptor, remaining)
        if not isinstance(written, int) or written < 1 or written > len(remaining):
            raise LeaseError("child-output-failed")
        remaining = remaining[written:]


def close_output(
    output: selectors.BaseSelector | None,
    child: subprocess.Popen[bytes],
) -> None:
    if output is not None:
        output.close()
    if child.stdout is not None:
        child.stdout.close()
    if child.stderr is not None:
        child.stderr.close()


def relay_output(
    output: selectors.BaseSelector,
    context: dict[str, object],
    timeout: float,
) -> None:
    for key, _events in output.select(timeout):
        try:
            payload = os.read(key.fileobj.fileno(), 64 * 1024)
        except BlockingIOError:
            continue
        if not payload:
            output.unregister(key.fileobj)
            continue
        inject_test_failure(context, "output-pump")
        try:
            write_all(key.data, payload)
        except BrokenPipeError:
            raise LeaseError("child-output-failed") from None


def drain_output(
    output: selectors.BaseSelector,
    context: dict[str, object],
    deadline: float,
) -> None:
    while output.get_map():
        relay_output(output, context, 0.02)
        if time.monotonic() >= deadline and output.get_map():
            raise LeaseError("child-output-cleanup-uncertain")


def contain_child(
    child: subprocess.Popen[bytes],
    group: tuple[int, str] | None,
) -> None:
    if group is None:
        if child.poll() is None:
            try:
                os.killpg(child.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                child.wait(timeout=WAIT_SECONDS)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                try:
                    child.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    raise LeaseError("child-cleanup-uncertain") from None
        try:
            os.killpg(child.pid, 0)
        except ProcessLookupError:
            return
        except PermissionError:
            raise LeaseError("child-cleanup-uncertain") from None
        raise LeaseError("child-cleanup-uncertain")
    state = group_state(*group)
    if state == "mismatch":
        raise LeaseError("child-cleanup-uncertain")
    if state == "uncertain":
        try:
            child.wait(timeout=0.5)
        except subprocess.TimeoutExpired:
            raise LeaseError("child-cleanup-uncertain") from None
        if not wait_for_group_absence(group[0], group[1], time.monotonic() + 0.5):
            raise LeaseError("child-cleanup-uncertain")
        return
    if state != "absent":
        if child.poll() is None:
            try:
                os.killpg(group[0], signal.SIGTERM)
            except ProcessLookupError:
                pass
            except PermissionError:
                try:
                    child.wait(timeout=0.5)
                except subprocess.TimeoutExpired:
                    raise LeaseError("child-cleanup-uncertain") from None
                if not wait_for_group_absence(group[0], group[1], time.monotonic() + 0.5):
                    raise LeaseError("child-cleanup-uncertain") from None
                return
        else:
            child.wait()
    if child.poll() is None:
        try:
            child.wait(timeout=WAIT_SECONDS)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(group[0], signal.SIGKILL)
            except ProcessLookupError:
                pass
            try:
                child.wait(timeout=2)
            except subprocess.TimeoutExpired:
                raise LeaseError("child-cleanup-uncertain") from None
    if wait_for_group_absence(group[0], group[1], time.monotonic() + 0.5):
        return
    state = group_state(*group)
    if state in {"mismatch", "uncertain"}:
        raise LeaseError("child-cleanup-uncertain")
    try:
        os.killpg(group[0], signal.SIGKILL)
    except ProcessLookupError:
        pass
    except PermissionError:
        if group_state(*group) != "absent":
            raise LeaseError("child-cleanup-uncertain") from None
    if not wait_for_group_absence(group[0], group[1], time.monotonic() + 2):
        raise LeaseError("child-cleanup-uncertain")


def execute_nested_steps(
    steps: list[tuple[Path, list[str], dict[str, str]]],
    descriptor: int,
    token: str,
    context: dict[str, object],
) -> int:
    environment = os.environ.copy()
    environment.update(
        {
            LOCK_ENV: str(descriptor),
            TOKEN_ENV: token,
            REPOSITORY_ENV: str(context["repositoryId"]),
        }
    )
    for cwd, arguments, additions in steps:
        step_environment = environment.copy()
        step_environment.update(additions)
        result = subprocess.run(
            arguments,
            cwd=cwd,
            env=step_environment,
            check=False,
            pass_fds=(descriptor,),
        )
        if result.returncode != 0:
            return result.returncode
    return 0


def execute_steps(kind: str, context: dict[str, object], descriptor: int, token: str, owner: dict[str, object], test_command: list[str] | None = None, replay: dict[str, object] | None = None) -> int:
    root = context["root"]
    steps = test_steps(test_command, root) if test_command is not None else command_steps(kind, root)
    environment = os.environ.copy()
    environment.update({LOCK_ENV: str(descriptor), TOKEN_ENV: token, REPOSITORY_ENV: str(context["repositoryId"])})
    interrupted = 0
    active_group: tuple[int, str] | None = None
    forwarded = 0

    def forward(signum: int, _frame: object) -> None:
        nonlocal interrupted
        interrupted = signum

    def forward_pending() -> None:
        nonlocal forwarded
        if interrupted == 0 or forwarded == interrupted or active_group is None:
            return
        state = group_state(*active_group)
        if state in {"live", "orphaned"}:
            try:
                os.killpg(active_group[0], interrupted)
            except ProcessLookupError:
                pass
        elif state in {"mismatch", "uncertain"}:
            raise LeaseError("signal-cleanup-uncertain")
        forwarded = interrupted

    previous = {item: signal.signal(item, forward) for item in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP)}
    try:
        for step_index, (cwd, arguments, additions) in enumerate(steps):
            if interrupted:
                return 128 + interrupted
            step_environment = environment.copy()
            step_environment.update(additions)
            for name in REPLAY_INPUTS:
                step_environment.pop(name, None)
            if kind == "core-artifact-replay":
                if replay is None or not replay_source_matches(replay):
                    raise LeaseError("replay-preload-substituted")
                step_environment.pop("NODE_OPTIONS", None)
                if step_index == 1:
                    step_environment["NODE_OPTIONS"] = str(replay["nodeOptions"])
            gate_read, gate_write = os.pipe()
            os.set_inheritable(gate_read, True)
            launcher = (
                "import os,sys; fd=int(sys.argv[1]); "
                "ready=os.read(fd,1); os.close(fd); "
                "raise_code=75 if ready != b'1' else None; "
                "sys.exit(raise_code) if raise_code is not None else os.execvpe(sys.argv[2],sys.argv[2:],os.environ)"
            )
            child: subprocess.Popen[bytes] | None = None
            output: selectors.BaseSelector | None = None
            group: tuple[int, str] | None = None
            step_error: Exception | None = None
            result = 74
            try:
                child = subprocess.Popen(
                    [sys.executable, "-c", launcher, str(gate_read), *arguments],
                    cwd=cwd,
                    env=step_environment,
                    start_new_session=True,
                    pass_fds=(descriptor, gate_read),
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                )
                child_pid_path = os.environ.get(TEST_CHILD_PID_ENV)
                if child_pid_path is not None:
                    if os.environ.get(TEST_MODE_ENV) != "1" or context["hasOrigin"]:
                        raise LeaseError("testing-child-pid-forbidden")
                    Path(child_pid_path).write_text(str(child.pid), encoding="utf-8")
                os.close(gate_read)
                gate_read = -1
                child_state, group_start = process_start(child.pid)
                if child_state != "live" or group_start is None:
                    raise LeaseError("child-identity-unavailable")
                group = (child.pid, group_start)
                active_group = group
                test_barrier(context, TEST_AFTER_SPAWN_ENV)
                inject_test_failure(context, "after-spawn")
                owner["groupPid"] = child.pid
                owner["groupStart"] = group_start
                inject_test_failure(context, "owner-write")
                write_owner(lease_directory(context), owner)
                if child.stdout is None or child.stderr is None:
                    raise LeaseError("child-output-unavailable")
                output = selectors.DefaultSelector()
                output.register(child.stdout, selectors.EVENT_READ, 1)
                output.register(child.stderr, selectors.EVENT_READ, 2)
                forward_pending()
                if interrupted == 0:
                    write_all(gate_write, b"1")
                    os.close(gate_write)
                    gate_write = -1

                if interrupted:
                    result = 128 + interrupted
                else:
                    while child.poll() is None and interrupted == 0:
                        relay_output(output, context, 0.02)
                    forward_pending()
                if interrupted:
                    result = 128 + interrupted
                else:
                    result = child.wait()
            except Exception as error:
                step_error = error
            finally:
                cleanup_error: Exception | None = None
                for gate in [gate_read, gate_write]:
                    if gate < 0:
                        continue
                    try:
                        os.close(gate)
                    except OSError as error:
                        if cleanup_error is None:
                            cleanup_error = error
                if child is not None:
                    try:
                        contain_child(child, group)
                    except Exception as error:
                        cleanup_error = error
                    if output is not None:
                        try:
                            drain_output(output, context, time.monotonic() + 0.5)
                        except Exception as error:
                            if cleanup_error is None:
                                cleanup_error = error
                    try:
                        close_output(output, child)
                    except Exception as error:
                        if cleanup_error is None:
                            cleanup_error = error
                if cleanup_error is not None:
                    step_error = cleanup_error
                active_group = None
            if step_error is not None:
                if isinstance(step_error, LeaseError):
                    raise step_error
                raise LeaseError("step-execution-failed") from None
            if interrupted:
                return 128 + interrupted
            if result != 0:
                return result
            if kind == "core-artifact-replay" and step_index == 0:
                inject_test_failure(context, "between-replay-steps")
            test_barrier(context, TEST_BETWEEN_STEPS_ENV)
        return 0
    finally:
        for item, handler in previous.items():
            signal.signal(item, handler)


def run(kind: str, test_command: list[str] | None) -> int:
    context = repository_context()
    if kind not in COMMANDS and test_command is None:
        raise LeaseError("command-kind-invalid")
    if test_command is not None and (os.environ.get(TEST_MODE_ENV) != "1" or context["hasOrigin"]):
        raise LeaseError("testing-command-forbidden")
    replay_inputs = {name for name in os.environ if name.startswith(REPLAY_ENV_PREFIX)}
    if kind != "core-artifact-replay" and replay_inputs:
        raise LeaseError("replay-input-forbidden")
    directory = lease_directory(context)
    nested = nested_owner(context, directory)
    if nested is not None:
        if kind == "core-artifact-replay":
            raise LeaseError("replay-nested-forbidden")
        steps = test_steps(test_command, context["root"]) if test_command is not None else command_steps(kind, context["root"])
        return execute_nested_steps(steps, nested[0], nested[1], context)
    controller = open_lock(directory, "controller.lock", False)
    descriptor: int | None = None
    replay: dict[str, object] | None = None
    lease_id = secrets.token_hex(16)
    try:
        if not acquire(controller):
            print(f"validation-lease: busy {owner_summary(directory)}", file=sys.stderr)
            return 73
        descriptor = open_lock(directory, "lease.lock", True)
        if not acquire(descriptor):
            print(f"validation-lease: busy {owner_summary(directory)}", file=sys.stderr)
            return 73
        previous = read_owner(directory)
        if stale_state(previous) == "uncertain":
            raise LeaseError("stale-owner-uncertain")
        if kind == "core-artifact-replay":
            replay = open_replay_preload()
            test_barrier(context, TEST_REPLAY_OPEN_ENV)
        token = secrets.token_hex(32)
        owner_state, owner_start = process_start(os.getpid())
        if owner_state != "live" or owner_start is None:
            raise LeaseError("owner-identity-unavailable")
        owner = {"version": VERSION, "leaseId": lease_id, "tokenHash": digest(token), "repositoryId": context["repositoryId"], "worktreeId": context["worktreeId"], "rootKind": kind, "ownerPid": os.getpid(), "ownerStart": owner_start, "groupPid": None, "groupStart": None, "acquiredUnixMilliseconds": int(time.time() * 1000)}
        write_owner(directory, owner)
        execution_error: Exception | None = None
        result = 74
        try:
            result = execute_steps(kind, context, descriptor, token, owner, test_command, replay)
        except Exception as error:
            execution_error = error
        if replay is not None:
            try:
                cleanup_replay_preload(replay)
            except Exception as error:
                execution_error = error
            replay = None
        os.close(descriptor)
        descriptor = None
        proof = open_lock(directory, "lease.lock", False)
        try:
            if not acquire_until(proof, time.monotonic() + 0.5):
                raise LeaseError("inherited-lock-cleanup-uncertain")
            preserve = isinstance(execution_error, LeaseError) and str(execution_error) in {
                "child-cleanup-uncertain",
                "signal-cleanup-uncertain",
            }
            if not preserve:
                clear_owned_record(directory, lease_id)
        finally:
            os.close(proof)
        if execution_error is not None:
            if isinstance(execution_error, LeaseError):
                raise execution_error
            raise LeaseError("step-execution-failed") from None
        return result
    finally:
        cleanup_error: Exception | None = None
        if replay is not None:
            try:
                cleanup_replay_preload(replay)
            except Exception as error:
                cleanup_error = error
        if descriptor is not None:
            os.close(descriptor)
        os.close(controller)
        if cleanup_error is not None:
            if isinstance(cleanup_error, LeaseError):
                raise cleanup_error
            raise LeaseError("replay-preload-cleanup-uncertain") from None


def inspect(reconcile: bool) -> int:
    context = repository_context()
    directory = lease_directory(context)
    controller = open_lock(directory, "controller.lock", False)
    descriptor: int | None = None
    try:
        if not acquire(controller):
            print(f"validation-lease: busy {owner_summary(directory)}")
            return 2
        descriptor = open_lock(directory, "lease.lock", False)
        if not acquire(descriptor):
            print(f"validation-lease: busy {owner_summary(directory)}")
            return 2
        owner = read_owner(directory)
        state = stale_state(owner)
        if state == "uncertain":
            print("validation-lease: reconciliation-required owner=unavailable")
            return 3
        if reconcile and owner is not None:
            clear_owned_record(directory, str(owner.get("leaseId")))
            print("validation-lease: reconciled")
        else:
            print(f"validation-lease: available stale={'true' if owner else 'false'}")
        return 0
    finally:
        if descriptor is not None:
            os.close(descriptor)
        os.close(controller)


def main() -> int:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("action", choices=["run", "test-run", "status", "reconcile"])
    parser.add_argument("kind", nargs="?")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    arguments = parser.parse_args()
    if arguments.action in {"status", "reconcile"}:
        if arguments.kind is not None or arguments.command:
            raise LeaseError("arguments-invalid")
        return inspect(arguments.action == "reconcile")
    if arguments.kind is None:
        raise LeaseError("arguments-invalid")
    command = arguments.command
    if command[:1] == ["--"]:
        command = command[1:]
    if arguments.action == "run" and command:
        raise LeaseError("arguments-invalid")
    if arguments.action == "test-run" and not command:
        raise LeaseError("arguments-invalid")
    return run(arguments.kind, command if arguments.action == "test-run" else None)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except LeaseError as error:
        print(f"validation-lease: {error}", file=sys.stderr)
        raise SystemExit(74) from None
