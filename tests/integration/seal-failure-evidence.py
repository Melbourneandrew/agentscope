#!/usr/bin/python3
"""Bootstrap the preloaded action and seal its anonymous failure bundle."""

from __future__ import annotations

import fcntl
import hashlib
import os
import stat
import sys


MAXIMUM_BYTES = 1024 * 1024
MEMFD_NAME = "agentscope-sanitized-failure-evidence"
REQUIRED_SEALS = (
    fcntl.F_SEAL_WRITE | fcntl.F_SEAL_GROW | fcntl.F_SEAL_SHRINK | fcntl.F_SEAL_SEAL
)
BOOTSTRAP_STAGES = frozenset({"invocation", "source", "mapping", "memfd", "exec"})
bootstrap_stage: str | None = None


def fail() -> None:
    raise RuntimeError("integration.controller.failure-evidence-seal")


def parse_unsigned(value: str, maximum: int) -> int:
    if (
        not value.isascii()
        or not value.isdecimal()
        or (value.startswith("0") and value != "0")
    ):
        fail()
    parsed = int(value)
    if parsed < 0 or parsed > maximum:
        fail()
    return parsed


def verify_digest(value: str) -> None:
    if len(value) != 71 or not value.startswith("sha256:"):
        fail()
    if any(character not in "0123456789abcdef" for character in value[7:]):
        fail()


def read_input() -> bytes:
    content = sys.stdin.buffer.read(MAXIMUM_BYTES + 1)
    if not content or len(content) > MAXIMUM_BYTES:
        fail()
    return content


def same_identity(left: os.stat_result, right: os.stat_result) -> bool:
    return (
        left.st_dev,
        left.st_ino,
        left.st_mode,
        left.st_nlink,
        left.st_uid,
        left.st_gid,
        left.st_size,
    ) == (
        right.st_dev,
        right.st_ino,
        right.st_mode,
        right.st_nlink,
        right.st_uid,
        right.st_gid,
        right.st_size,
    )


def process_start_ticks(pid: int) -> str:
    with open(f"/proc/{pid}/stat", "rb", buffering=0) as process_status:
        process_bytes = process_status.read(4097)
    close = process_bytes.rfind(b") ")
    fields = process_bytes[close + 2 :].split()
    if close < 2 or len(fields) < 20:
        fail()
    start = fields[19]
    if not start.isascii() or not start.isdigit():
        fail()
    return start.decode("ascii")


def authenticate_live_node(pid: int, expected_start: str, node: str) -> int:
    if process_start_ticks(pid) != expected_start:
        fail()
    mapping_path = f"/proc/{pid}/exe"
    descriptor = os.open(mapping_path, os.O_PATH | os.O_CLOEXEC)
    try:
        mapped = os.fstat(descriptor)
        named = os.stat(node)
        adjacent = os.stat(mapping_path)
        if (
            not stat.S_ISREG(mapped.st_mode)
            or mapped.st_size < 1
            or not same_identity(mapped, named)
            or not same_identity(mapped, adjacent)
            or process_start_ticks(pid) != expected_start
            or not same_identity(mapped, os.fstat(descriptor))
            or not same_identity(mapped, os.stat(mapping_path))
        ):
            fail()
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def bootstrap(arguments: list[str]) -> None:
    global bootstrap_stage
    bootstrap_stage = "invocation"
    if len(arguments) != 5 or sys.platform != "linux":
        fail()
    node, integration_root, expected_digest, action_pid_value, action_start = arguments
    verify_digest(expected_digest)
    if not os.path.isabs(node) or not os.path.isabs(integration_root):
        fail()
    action_pid = parse_unsigned(action_pid_value, 2**31 - 1)
    if not action_start.isascii() or not action_start.isdecimal():
        fail()
    bootstrap_stage = "source"
    source = read_input()
    if f"sha256:{hashlib.sha256(source).hexdigest()}" != expected_digest:
        fail()
    bootstrap_stage = "memfd"
    source_descriptor = -1
    bundle_descriptor = -1
    node_descriptor = -1
    try:
        source_descriptor = os.memfd_create(
            "agentscope-preloaded-failure-action",
            os.MFD_CLOEXEC | os.MFD_ALLOW_SEALING,
        )
        bundle_descriptor = os.memfd_create(
            MEMFD_NAME,
            os.MFD_CLOEXEC | os.MFD_ALLOW_SEALING,
        )
        if source_descriptor != 3 or bundle_descriptor != 4:
            fail()
        if os.write(source_descriptor, source) != len(source):
            fail()
        os.fchmod(source_descriptor, 0o400)
        fcntl.fcntl(source_descriptor, fcntl.F_ADD_SEALS, REQUIRED_SEALS)
        if fcntl.fcntl(source_descriptor, fcntl.F_GET_SEALS) != REQUIRED_SEALS:
            fail()
        os.fchmod(bundle_descriptor, 0o600)
        os.set_inheritable(source_descriptor, True)
        os.set_inheritable(bundle_descriptor, True)
        bootstrap_stage = "mapping"
        node_descriptor = authenticate_live_node(action_pid, action_start, node)
        os.close(0)
        bootstrap_stage = "exec"
        root_status = os.lstat(integration_root)
        root_descriptor = os.open(
            integration_root,
            os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_DIRECTORY,
        )
        try:
            if not same_identity(os.fstat(root_descriptor), root_status):
                fail()
            os.fchdir(root_descriptor)
        finally:
            os.close(root_descriptor)
        if os.execve not in os.supports_fd:
            fail()
        if (
            process_start_ticks(action_pid) != action_start
            or not same_identity(os.fstat(node_descriptor), os.stat(node))
            or not same_identity(
                os.fstat(node_descriptor), os.stat(f"/proc/{action_pid}/exe")
            )
        ):
            fail()
        os.execve(
            node_descriptor,
            [
                node,
                "--input-type=module",
                "--eval",
                source.decode("utf-8"),
                "--",
                "--outer-controller",
                "--source-fd",
                str(source_descriptor),
                "--bundle-fd",
                str(bundle_descriptor),
                "--source-digest",
                expected_digest,
            ],
            os.environ,
        )
    finally:
        for descriptor in (source_descriptor, bundle_descriptor, node_descriptor):
            if descriptor >= 0:
                os.close(descriptor)


def seal_existing(arguments: list[str]) -> None:
    if len(arguments) != 2 or sys.platform != "linux":
        fail()
    size = parse_unsigned(arguments[0], MAXIMUM_BYTES)
    verify_digest(arguments[1])
    descriptor = 3
    status = os.fstat(descriptor)
    if (
        not stat.S_ISREG(status.st_mode)
        or status.st_nlink != 0
        or status.st_size != size
        or stat.S_IMODE(status.st_mode) != 0o600
    ):
        fail()
    os.fsync(descriptor)
    os.fchmod(descriptor, 0o400)
    fcntl.fcntl(descriptor, fcntl.F_ADD_SEALS, REQUIRED_SEALS)
    if fcntl.fcntl(descriptor, fcntl.F_GET_SEALS) != REQUIRED_SEALS:
        fail()
    sys.stdout.write('{"status":"sealed"}\n')


def probe(arguments: list[str]) -> None:
    if len(arguments) != 5 or sys.platform != "linux":
        fail()
    pid = parse_unsigned(arguments[0], 2**31 - 1)
    descriptor = parse_unsigned(arguments[1], 2**20)
    size = parse_unsigned(arguments[2], MAXIMUM_BYTES)
    digest = arguments[3]
    expected_start = arguments[4]
    verify_digest(digest)
    if not expected_start.isascii() or not expected_start.isdecimal():
        fail()
    path = f"/proc/{pid}/fd/{descriptor}"
    copy = os.open(path, os.O_RDONLY | os.O_CLOEXEC)
    try:
        status = os.fstat(copy)
        if (
            not stat.S_ISREG(status.st_mode)
            or stat.S_IMODE(status.st_mode) != 0o400
            or status.st_size != size
            or fcntl.fcntl(copy, fcntl.F_GET_SEALS) != REQUIRED_SEALS
            or os.readlink(path) != f"/memfd:{MEMFD_NAME} (deleted)"
        ):
            fail()
        calculated = hashlib.sha256()
        remaining = size
        while remaining:
            chunk = os.read(copy, min(65536, remaining))
            if not chunk:
                fail()
            calculated.update(chunk)
            remaining -= len(chunk)
        if os.read(copy, 1) or f"sha256:{calculated.hexdigest()}" != digest:
            fail()
    finally:
        os.close(copy)
    with open(f"/proc/{pid}/stat", "rb", buffering=0) as process_status:
        process_bytes = process_status.read(4097)
    close = process_bytes.rfind(b") ")
    fields = process_bytes[close + 2 :].split()
    if close < 2 or len(fields) < 20 or fields[19].decode("ascii") != expected_start:
        fail()
    sys.stdout.write('{"status":"authenticated"}\n')


def main() -> None:
    if len(sys.argv) < 2:
        fail()
    if sys.argv[1] == "bootstrap":
        bootstrap(sys.argv[2:])
    elif sys.argv[1] == "seal-existing":
        seal_existing(sys.argv[2:])
    elif sys.argv[1] == "probe":
        probe(sys.argv[2:])
    else:
        fail()


if __name__ == "__main__":
    try:
        main()
    except BaseException:
        if bootstrap_stage in BOOTSTRAP_STAGES:
            sys.stderr.write(
                f"integration.controller.failure-evidence-bootstrap:{bootstrap_stage}\n"
            )
        else:
            sys.stderr.write("integration.controller.failure-evidence-seal\n")
        raise SystemExit(1)
