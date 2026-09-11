#!/usr/bin/python3
"""Bootstrap the preloaded action and seal its anonymous failure bundle."""

from __future__ import annotations

import fcntl
import hashlib
import os
import stat
import sys


MAXIMUM_BYTES = 1024 * 1024
BOOTSTRAP_KEY_BYTES = 32
BOOTSTRAP_NONCE_BYTES = 16
BOOTSTRAP_AUTHORITY_BYTES = BOOTSTRAP_KEY_BYTES + BOOTSTRAP_NONCE_BYTES + 71
MEMFD_NAME = "agentscope-sanitized-failure-evidence"
BRIDGE_FILE = "failure-evidence.json"
REQUIRED_SEALS = (
    fcntl.F_SEAL_WRITE | fcntl.F_SEAL_GROW | fcntl.F_SEAL_SHRINK | fcntl.F_SEAL_SEAL
    if all(
        hasattr(fcntl, name)
        for name in ("F_SEAL_WRITE", "F_SEAL_GROW", "F_SEAL_SHRINK", "F_SEAL_SEAL")
    )
    else 0
)
BOOTSTRAP_STAGES = {"invocation", "source", "mapping", "memfd", "exec"}
bootstrap_stage = "invocation"


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


def read_input(maximum: int = MAXIMUM_BYTES) -> bytes:
    content = sys.stdin.buffer.read(maximum + 1)
    if not content or len(content) > maximum:
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
    descriptor = os.open(
        f"/proc/{pid}/stat", os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW
    )
    try:
        data = os.read(descriptor, 4097)
        if not data or len(data) > 4096 or not data.endswith(b"\n"):
            fail()
        data = data[:-1]
        if not data or b"\n" in data or b"\r" in data or b"\0" in data:
            fail()
        close = data.rfind(b") ")
        fields = data[close + 2 :].split(b" ")
        if close < 2 or len(fields) < 20 or any(not field for field in fields):
            fail()
        start = fields[19]
        if not start.isascii() or not start.isdigit():
            fail()
        return start.decode("ascii")
    finally:
        os.close(descriptor)


def bootstrap(arguments: list[str]) -> None:
    global bootstrap_stage
    bootstrap_stage = "invocation"
    if len(arguments) != 6 or sys.platform != "linux":
        fail()
    (
        node,
        integration_root,
        expected_digest,
        action_pid_value,
        expected_start,
        source_size_value,
    ) = arguments
    verify_digest(expected_digest)
    if not os.path.isabs(node) or not os.path.isabs(integration_root):
        fail()
    action_pid = parse_unsigned(action_pid_value, 2**31 - 1)
    if not expected_start.isascii() or not expected_start.isdecimal():
        fail()
    source_size = parse_unsigned(source_size_value, MAXIMUM_BYTES)
    bootstrap_stage = "source"
    supplied = read_input(MAXIMUM_BYTES + BOOTSTRAP_KEY_BYTES + BOOTSTRAP_NONCE_BYTES)
    if len(supplied) != BOOTSTRAP_KEY_BYTES + BOOTSTRAP_NONCE_BYTES + source_size:
        fail()
    key = supplied[:BOOTSTRAP_KEY_BYTES]
    nonce = supplied[BOOTSTRAP_KEY_BYTES : BOOTSTRAP_KEY_BYTES + BOOTSTRAP_NONCE_BYTES]
    source = supplied[BOOTSTRAP_KEY_BYTES + BOOTSTRAP_NONCE_BYTES :]
    if f"sha256:{hashlib.sha256(source).hexdigest()}" != expected_digest:
        fail()
    bootstrap_stage = "memfd"
    source_descriptor = os.memfd_create(
        "agentscope-preloaded-failure-action",
        os.MFD_CLOEXEC | os.MFD_ALLOW_SEALING,
    )
    bundle_descriptor = os.memfd_create(
        MEMFD_NAME,
        os.MFD_CLOEXEC | os.MFD_ALLOW_SEALING,
    )
    authority_descriptor = os.memfd_create(
        "agentscope-bootstrap-authority",
        os.MFD_CLOEXEC | os.MFD_ALLOW_SEALING,
    )
    bootstrap_stage = "mapping"
    if process_start_ticks(action_pid) != expected_start:
        fail()
    process_root = f"/proc/{action_pid}"
    process_root_status = os.lstat(process_root)
    process_root_descriptor = os.open(
        process_root,
        os.O_PATH | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_DIRECTORY,
    )
    node_descriptor = os.open("exe", os.O_PATH | os.O_CLOEXEC, dir_fd=process_root_descriptor)
    try:
        if (
            source_descriptor != 4
            or bundle_descriptor != 5
            or authority_descriptor != 6
        ):
            fail()
        if os.write(source_descriptor, source) != len(source):
            fail()
        os.fchmod(source_descriptor, 0o400)
        fcntl.fcntl(source_descriptor, fcntl.F_ADD_SEALS, REQUIRED_SEALS)
        if fcntl.fcntl(source_descriptor, fcntl.F_GET_SEALS) != REQUIRED_SEALS:
            fail()
        authority = key + nonce + expected_digest.encode("ascii")
        if len(authority) != BOOTSTRAP_AUTHORITY_BYTES:
            fail()
        if os.write(authority_descriptor, authority) != len(authority):
            fail()
        os.fchmod(authority_descriptor, 0o400)
        fcntl.fcntl(authority_descriptor, fcntl.F_ADD_SEALS, REQUIRED_SEALS)
        if fcntl.fcntl(authority_descriptor, fcntl.F_GET_SEALS) != REQUIRED_SEALS:
            fail()
        os.fchmod(bundle_descriptor, 0o600)
        os.set_inheritable(3, True)
        os.set_inheritable(source_descriptor, True)
        os.set_inheritable(bundle_descriptor, True)
        os.set_inheritable(authority_descriptor, True)
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
        mapped_status = os.fstat(node_descriptor)
        selected_status = os.stat(node, follow_symlinks=True)
        if not same_identity(os.fstat(process_root_descriptor), process_root_status):
            fail()
        if process_start_ticks(action_pid) != expected_start:
            fail()
        if (
            not stat.S_ISREG(mapped_status.st_mode)
            or not same_identity(mapped_status, selected_status)
            or os.execve not in os.supports_fd
        ):
            fail()
        bootstrap_stage = "exec"
        if (
            process_start_ticks(action_pid) != expected_start
            or not same_identity(os.fstat(node_descriptor), mapped_status)
            or not same_identity(os.stat(node, follow_symlinks=True), mapped_status)
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
                "--bootstrap-control-fd",
                "3",
                "--bootstrap-authority-fd",
                str(authority_descriptor),
            ],
            os.environ,
        )
    finally:
        os.close(source_descriptor)
        os.close(bundle_descriptor)
        os.close(authority_descriptor)
        os.close(node_descriptor)
        os.close(process_root_descriptor)


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


def bridge_create(arguments: list[str]) -> None:
    if len(arguments) != 3:
        fail()
    directory_name, size_value, digest = arguments
    if (
        len(directory_name) != 51
        or not directory_name.startswith(".agentscope-failure-upload-")
        or any(character not in "0123456789abcdef" for character in directory_name[27:])
    ):
        fail()
    size = parse_unsigned(size_value, MAXIMUM_BYTES)
    verify_digest(digest)
    workspace_descriptor = 3
    source_descriptor = 4
    directory_descriptor = None
    file_descriptor = None
    created_directory = False
    created_file = False
    try:
        os.mkdir(directory_name, 0o700, dir_fd=workspace_descriptor)
        created_directory = True
        directory_descriptor = os.open(
            directory_name,
            os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_DIRECTORY,
            dir_fd=workspace_descriptor,
        )
        file_descriptor = os.open(
            BRIDGE_FILE,
            os.O_WRONLY | os.O_CLOEXEC | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
            0o600,
            dir_fd=directory_descriptor,
        )
        created_file = True
        calculated = hashlib.sha256()
        offset = 0
        while offset < size:
            chunk = os.pread(source_descriptor, min(65536, size - offset), offset)
            if not chunk:
                fail()
            calculated.update(chunk)
            written = 0
            while written < len(chunk):
                count = os.write(file_descriptor, chunk[written:])
                if count < 1:
                    fail()
                written += count
            offset += len(chunk)
        if os.pread(source_descriptor, 1, size):
            fail()
        if f"sha256:{calculated.hexdigest()}" != digest:
            fail()
        os.fsync(file_descriptor)
        os.fchmod(file_descriptor, 0o400)
        os.fsync(file_descriptor)
        os.fsync(directory_descriptor)
        status = os.fstat(file_descriptor)
        if (
            not stat.S_ISREG(status.st_mode)
            or status.st_nlink != 1
            or status.st_size != size
            or stat.S_IMODE(status.st_mode) != 0o400
            or status.st_uid != os.getuid()
            or status.st_gid != os.getgid()
        ):
            fail()
        directory_status = os.fstat(directory_descriptor)
        named_directory = os.stat(
            directory_name, dir_fd=workspace_descriptor, follow_symlinks=False
        )
        named_file = os.stat(
            BRIDGE_FILE, dir_fd=directory_descriptor, follow_symlinks=False
        )
        if not same_identity(directory_status, named_directory) or not same_identity(
            status, named_file
        ):
            fail()
        identity = ":".join(
            str(value)
            for value in (
                directory_status.st_dev,
                directory_status.st_ino,
                directory_status.st_uid,
                directory_status.st_gid,
                status.st_dev,
                status.st_ino,
                status.st_uid,
                status.st_gid,
                status.st_size,
            )
        )
        sys.stdout.write(f'{{"status":"created:{identity}"}}\n')
    except BaseException:
        if file_descriptor is not None:
            os.close(file_descriptor)
            file_descriptor = None
        if created_file and directory_descriptor is not None:
            try:
                os.unlink(BRIDGE_FILE, dir_fd=directory_descriptor)
            except FileNotFoundError:
                pass
        if directory_descriptor is not None:
            os.close(directory_descriptor)
            directory_descriptor = None
        if created_directory:
            try:
                os.rmdir(directory_name, dir_fd=workspace_descriptor)
            except FileNotFoundError:
                pass
        os.fsync(workspace_descriptor)
        raise
    finally:
        if file_descriptor is not None:
            os.close(file_descriptor)
        if directory_descriptor is not None:
            os.close(directory_descriptor)


def bridge_remove(arguments: list[str]) -> None:
    if len(arguments) != 13:
        fail()
    directory_name, *identity_values = arguments
    expected = tuple(
        parse_unsigned(value, 2**63 - 1) for value in identity_values[:7]
    )
    expected_directory = tuple(
        parse_unsigned(value, 2**63 - 1) for value in identity_values[7:]
    )
    if (
        len(directory_name) != 51
        or not directory_name.startswith(".agentscope-failure-upload-")
        or any(character not in "0123456789abcdef" for character in directory_name[27:])
    ):
        fail()
    workspace_descriptor = 3
    directory_descriptor = 4
    file_descriptor = 5
    status = os.fstat(file_descriptor)
    named = os.stat(BRIDGE_FILE, dir_fd=directory_descriptor, follow_symlinks=False)
    observed = (
        status.st_dev,
        status.st_ino,
        status.st_uid,
        status.st_gid,
        stat.S_IMODE(status.st_mode),
        status.st_nlink,
        status.st_size,
    )
    if observed != expected or not same_identity(status, named):
        fail()
    directory_status = os.fstat(directory_descriptor)
    named_directory = os.stat(
        directory_name, dir_fd=workspace_descriptor, follow_symlinks=False
    )
    observed_directory = (
        directory_status.st_dev,
        directory_status.st_ino,
        directory_status.st_uid,
        directory_status.st_gid,
        stat.S_IMODE(directory_status.st_mode),
    )
    if (
        observed_directory != expected_directory
        or not same_identity(directory_status, named_directory)
        or not stat.S_ISDIR(directory_status.st_mode)
    ):
        fail()
    os.unlink(BRIDGE_FILE, dir_fd=directory_descriptor)
    os.fsync(directory_descriptor)
    try:
        os.stat(BRIDGE_FILE, dir_fd=directory_descriptor, follow_symlinks=False)
        fail()
    except FileNotFoundError:
        pass
    if os.listdir(directory_descriptor):
        fail()
    named_directory = os.stat(
        directory_name, dir_fd=workspace_descriptor, follow_symlinks=False
    )
    if (
        named_directory.st_dev,
        named_directory.st_ino,
        named_directory.st_uid,
        named_directory.st_gid,
        stat.S_IMODE(named_directory.st_mode),
    ) != expected_directory:
        fail()
    os.rmdir(directory_name, dir_fd=workspace_descriptor)
    os.fsync(workspace_descriptor)
    try:
        os.stat(directory_name, dir_fd=workspace_descriptor, follow_symlinks=False)
        fail()
    except FileNotFoundError:
        pass
    sys.stdout.write('{"status":"removed"}\n')


def bridge_abort(arguments: list[str]) -> None:
    if len(arguments) != 10:
        fail()
    directory_name, *identity_values = arguments
    expected = tuple(
        parse_unsigned(value, 2**63 - 1) for value in identity_values
    )
    if (
        len(directory_name) != 51
        or not directory_name.startswith(".agentscope-failure-upload-")
        or any(character not in "0123456789abcdef" for character in directory_name[27:])
    ):
        fail()
    workspace_descriptor = 3
    directory_descriptor = os.open(
        directory_name,
        os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_DIRECTORY,
        dir_fd=workspace_descriptor,
    )
    try:
        directory_status = os.fstat(directory_descriptor)
        named_directory = os.stat(
            directory_name, dir_fd=workspace_descriptor, follow_symlinks=False
        )
        file_descriptor = os.open(
            BRIDGE_FILE,
            os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW,
            dir_fd=directory_descriptor,
        )
        try:
            file_status = os.fstat(file_descriptor)
            named_file = os.stat(
                BRIDGE_FILE, dir_fd=directory_descriptor, follow_symlinks=False
            )
            observed = (
                directory_status.st_dev,
                directory_status.st_ino,
                directory_status.st_uid,
                directory_status.st_gid,
                file_status.st_dev,
                file_status.st_ino,
                file_status.st_uid,
                file_status.st_gid,
                file_status.st_size,
            )
            if (
                observed != expected
                or not same_identity(directory_status, named_directory)
                or not same_identity(file_status, named_file)
                or not stat.S_ISDIR(directory_status.st_mode)
                or not stat.S_ISREG(file_status.st_mode)
            ):
                fail()
        finally:
            os.close(file_descriptor)
        os.unlink(BRIDGE_FILE, dir_fd=directory_descriptor)
        os.fsync(directory_descriptor)
        if os.listdir(directory_descriptor):
            fail()
        named_directory = os.stat(
            directory_name, dir_fd=workspace_descriptor, follow_symlinks=False
        )
        if (
            named_directory.st_dev,
            named_directory.st_ino,
            named_directory.st_uid,
            named_directory.st_gid,
        ) != expected[:4]:
            fail()
        os.rmdir(directory_name, dir_fd=workspace_descriptor)
        os.fsync(workspace_descriptor)
        try:
            os.stat(directory_name, dir_fd=workspace_descriptor, follow_symlinks=False)
            fail()
        except FileNotFoundError:
            pass
    finally:
        os.close(directory_descriptor)
    sys.stdout.write('{"status":"aborted"}\n')


def main() -> None:
    if len(sys.argv) < 2:
        fail()
    if sys.argv[1] == "bootstrap":
        bootstrap(sys.argv[2:])
    elif sys.argv[1] == "seal-existing":
        seal_existing(sys.argv[2:])
    elif sys.argv[1] == "probe":
        probe(sys.argv[2:])
    elif sys.argv[1] == "bridge-create":
        bridge_create(sys.argv[2:])
    elif sys.argv[1] == "bridge-remove":
        bridge_remove(sys.argv[2:])
    elif sys.argv[1] == "bridge-abort":
        bridge_abort(sys.argv[2:])
    else:
        fail()


if __name__ == "__main__":
    try:
        main()
    except BaseException:
        if len(sys.argv) > 1 and sys.argv[1] == "bootstrap" and bootstrap_stage in BOOTSTRAP_STAGES:
            sys.stderr.write(
                f"integration.controller.failure-evidence-bootstrap:{bootstrap_stage}\n"
            )
        else:
            sys.stderr.write("integration.controller.failure-evidence-seal\n")
        raise SystemExit(1)
