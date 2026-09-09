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


def bootstrap(arguments: list[str]) -> None:
    if len(arguments) != 3 or sys.platform != "linux":
        fail()
    node, integration_root, expected_digest = arguments
    verify_digest(expected_digest)
    if not os.path.isabs(node) or not os.path.isabs(integration_root):
        fail()
    source = read_input()
    if f"sha256:{hashlib.sha256(source).hexdigest()}" != expected_digest:
        fail()
    source_descriptor = os.memfd_create(
        "agentscope-preloaded-failure-action",
        os.MFD_CLOEXEC | os.MFD_ALLOW_SEALING,
    )
    bundle_descriptor = os.memfd_create(
        MEMFD_NAME,
        os.MFD_CLOEXEC | os.MFD_ALLOW_SEALING,
    )
    node_status = os.lstat(node)
    node_descriptor = os.open(node, os.O_PATH | os.O_CLOEXEC | os.O_NOFOLLOW)
    try:
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
        os.close(0)
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
        if (
            not stat.S_ISREG(node_status.st_mode)
            or not same_identity(os.fstat(node_descriptor), node_status)
            or os.execve not in os.supports_fd
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
        os.close(source_descriptor)
        os.close(bundle_descriptor)
        os.close(node_descriptor)


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
        sys.stderr.write("integration.controller.failure-evidence-seal\n")
        raise SystemExit(1)
