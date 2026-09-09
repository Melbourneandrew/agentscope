#!/usr/bin/python3
"""Seal one sanitized failure bundle, then exec its exact in-process uploader."""

from __future__ import annotations

import fcntl
import hashlib
import os
import stat
import sys


MAXIMUM_BYTES = 1024 * 1024
MAXIMUM_UPLOADER_BYTES = 64 * 1024
UPLOADER_SHA256 = "2a82505eb7f8d5acbe2634b5822861ab2e606187dc610548574fffbbeb57b41b"
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


def descriptor_inventory() -> set[int]:
    observed: set[int] = set()
    for name in os.listdir("/proc/self/fd"):
        if not name.isascii() or not name.isdecimal():
            fail()
        descriptor = int(name)
        try:
            os.fstat(descriptor)
        except OSError:
            continue
        observed.add(descriptor)
    return observed


def inheritable_inventory() -> set[int]:
    return {
        descriptor
        for descriptor in descriptor_inventory()
        if os.get_inheritable(descriptor)
    }


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


def seal(arguments: list[str]) -> None:
    if len(arguments) != 5 or sys.platform != "linux":
        fail()
    expected_environment = {
        "ACTIONS_RESULTS_URL",
        "ACTIONS_RUNTIME_TOKEN",
        "GITHUB_SERVER_URL",
        "GITHUB_WORKSPACE",
    }
    if set(os.environ) != expected_environment:
        fail()
    node, uploader, artifact_name, deadline, expected_digest = arguments
    if (
        not os.path.isabs(node)
        or not os.path.isabs(uploader)
        or not artifact_name.isascii()
        or len(artifact_name) < 1
        or len(artifact_name) > 128
        or any(character not in "abcdefghijklmnopqrstuvwxyz0123456789-_" for character in artifact_name)
    ):
        fail()
    parse_unsigned(deadline, 2**63 - 1)
    verify_digest(expected_digest)
    node_status = os.lstat(node)
    uploader_status = os.lstat(uploader)
    if (
        not stat.S_ISREG(node_status.st_mode)
        or stat.S_ISLNK(node_status.st_mode)
        or not stat.S_ISREG(uploader_status.st_mode)
        or stat.S_ISLNK(uploader_status.st_mode)
        or uploader_status.st_size < 1
        or uploader_status.st_size > MAXIMUM_UPLOADER_BYTES
    ):
        fail()
    if descriptor_inventory() != {0, 1, 2}:
        fail()
    content = read_input()
    if f"sha256:{hashlib.sha256(content).hexdigest()}" != expected_digest:
        fail()
    uploader_descriptor = os.open(uploader, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
    try:
        if not same_identity(os.fstat(uploader_descriptor), uploader_status):
            fail()
        uploader_source = os.read(uploader_descriptor, MAXIMUM_UPLOADER_BYTES + 1)
        if len(uploader_source) != uploader_status.st_size or os.read(uploader_descriptor, 1):
            fail()
        try:
            uploader_program = uploader_source.decode("utf-8")
        except UnicodeDecodeError:
            fail()
        if hashlib.sha256(uploader_source).hexdigest() != UPLOADER_SHA256:
            fail()
    finally:
        os.close(uploader_descriptor)
    integration_root = os.path.join(
        os.environ["GITHUB_WORKSPACE"], "tests", "integration"
    )
    integration_status = os.lstat(integration_root)
    if not stat.S_ISDIR(integration_status.st_mode) or stat.S_ISLNK(
        integration_status.st_mode
    ):
        fail()
    integration_descriptor = os.open(
        integration_root,
        os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_DIRECTORY,
    )
    try:
        if not same_identity(os.fstat(integration_descriptor), integration_status):
            fail()
        os.fchdir(integration_descriptor)
        if not same_identity(os.stat("."), integration_status):
            fail()
    finally:
        os.close(integration_descriptor)
    descriptor = os.memfd_create(MEMFD_NAME, os.MFD_CLOEXEC | os.MFD_ALLOW_SEALING)
    node_descriptor = os.open(node, os.O_PATH | os.O_CLOEXEC | os.O_NOFOLLOW)
    try:
        if descriptor != 3:
            fail()
        offset = 0
        while offset < len(content):
            written = os.write(descriptor, content[offset:])
            if written <= 0:
                fail()
            offset += written
        os.fsync(descriptor)
        os.fchmod(descriptor, 0o400)
        fcntl.fcntl(descriptor, fcntl.F_ADD_SEALS, REQUIRED_SEALS)
        if fcntl.fcntl(descriptor, fcntl.F_GET_SEALS) != REQUIRED_SEALS:
            fail()
        os.lseek(descriptor, 0, os.SEEK_SET)
        os.set_inheritable(descriptor, True)
        os.close(0)
        if descriptor_inventory() != {1, 2, descriptor, node_descriptor}:
            fail()
        if inheritable_inventory() != {1, 2, descriptor}:
            fail()
        environment = {
            name: os.environ[name]
            for name in (
                "ACTIONS_RESULTS_URL",
                "ACTIONS_RUNTIME_TOKEN",
                "GITHUB_SERVER_URL",
                "GITHUB_WORKSPACE",
            )
            if name in os.environ
        }
        if set(environment) != expected_environment:
            fail()
        if not same_identity(os.fstat(node_descriptor), node_status) or os.execve not in os.supports_fd:
            fail()
        os.execve(
            node_descriptor,
            [
                node,
                "--input-type=module",
                "--eval",
                uploader_program,
                "--",
                "--fd",
                str(descriptor),
                "--size",
                str(len(content)),
                "--digest",
                expected_digest,
                "--name",
                artifact_name,
                "--deadline",
                deadline,
                "--python",
                os.path.abspath(__file__),
            ],
            environment,
        )
    finally:
        os.close(descriptor)
        os.close(node_descriptor)


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
    if sys.argv[1] == "seal":
        seal(sys.argv[2:])
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
