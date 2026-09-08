#!/usr/bin/python3
"""Hold one sanitized CI failure bundle in a sealed anonymous Linux file."""

from __future__ import annotations

import fcntl
import hashlib
import json
import os
import select
import signal
import stat
import sys
import time


MAXIMUM_BYTES = 1024 * 1024
MAXIMUM_LIFETIME_NANOSECONDS = 20 * 60 * 1_000_000_000
MEMFD_NAME = "agentscope-sanitized-failure-evidence"
REQUIRED_SEALS = (
    fcntl.F_SEAL_WRITE | fcntl.F_SEAL_GROW | fcntl.F_SEAL_SHRINK | fcntl.F_SEAL_SEAL
)


def fail() -> None:
    raise RuntimeError("integration.controller.failure-evidence-keeper")


def canonical(value: object) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def parse_unsigned(value: str, maximum: int) -> int:
    if not value.isascii() or not value.isdecimal() or value.startswith("0") and value != "0":
        fail()
    parsed = int(value)
    if parsed < 0 or parsed > maximum:
        fail()
    return parsed


def process_start_time_ticks(pid: int) -> str:
    with open(f"/proc/{pid}/stat", "rb", buffering=0) as source:
        content = source.read(4097)
    if not content or len(content) > 4096 or not content.endswith(b"\n"):
        fail()
    close = content.rfind(b") ")
    if close < 2:
        fail()
    fields = content[close + 2 : -1].split(b" ")
    if len(fields) < 20 or not fields[19].isascii() or not fields[19].isdigit():
        fail()
    return fields[19].decode("ascii")


def live_descriptors() -> set[int]:
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


def read_input() -> bytes:
    content = sys.stdin.buffer.read(MAXIMUM_BYTES + 1)
    if not content or len(content) > MAXIMUM_BYTES:
        fail()
    return content


def verify_memfd(pid: int, start: str, descriptor: int, size: int, digest: str) -> None:
    if process_start_time_ticks(pid) != start:
        fail()
    path = f"/proc/{pid}/fd/{descriptor}"
    target = os.readlink(path)
    if target != f"/memfd:{MEMFD_NAME} (deleted)":
        fail()
    copy = os.open(path, os.O_RDONLY | os.O_CLOEXEC)
    try:
        before = os.fstat(copy)
        if (
            not stat.S_ISREG(before.st_mode)
            or stat.S_IMODE(before.st_mode) != 0o400
            or before.st_size != size
            or fcntl.fcntl(copy, fcntl.F_GET_SEALS) != REQUIRED_SEALS
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
        after = os.fstat(copy)
        if (before.st_dev, before.st_ino, before.st_size) != (
            after.st_dev,
            after.st_ino,
            after.st_size,
        ):
            fail()
    finally:
        os.close(copy)


def hold(deadline: int) -> None:
    now = time.monotonic_ns()
    if deadline <= now or deadline - now > MAXIMUM_LIFETIME_NANOSECONDS:
        fail()
    if live_descriptors() != {0, 1, 2}:
        fail()
    content = read_input()
    descriptor = os.memfd_create(
        MEMFD_NAME, os.MFD_CLOEXEC | os.MFD_ALLOW_SEALING
    )
    read_pipe = -1
    write_pipe = -1
    child = -1
    try:
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
        digest = f"sha256:{hashlib.sha256(content).hexdigest()}"
        read_pipe, write_pipe = os.pipe2(os.O_CLOEXEC)
        child = os.fork()
        if child == 0:
            os.close(read_pipe)
            os.close(0)
            os.close(1)
            os.close(2)
            stopped = False

            def stop(_signal: int, _frame: object) -> None:
                nonlocal stopped
                stopped = True

            signal.signal(signal.SIGTERM, stop)
            signal.signal(signal.SIGINT, stop)
            if live_descriptors() != {descriptor, write_pipe}:
                os._exit(70)
            os.write(write_pipe, b"R")
            os.close(write_pipe)
            while not stopped:
                remaining = deadline - time.monotonic_ns()
                if remaining <= 0:
                    os.close(descriptor)
                    os._exit(124)
                time.sleep(min(remaining / 1_000_000_000, 0.1))
            os.close(descriptor)
            os._exit(0)
        os.close(write_pipe)
        write_pipe = -1
        remaining_seconds = max(0.0, (deadline - time.monotonic_ns()) / 1_000_000_000)
        ready, _, _ = select.select([read_pipe], [], [], min(10.0, remaining_seconds))
        if not ready or os.read(read_pipe, 2) != b"R":
            fail()
        start = process_start_time_ticks(child)
        verify_memfd(child, start, descriptor, len(content), digest)
        receipt = {
            "digest": digest,
            "fd": descriptor,
            "keeperReceiptVersion": 1,
            "pid": child,
            "size": len(content),
            "startTimeTicks": start,
        }
        sys.stdout.buffer.write(canonical(receipt))
        sys.stdout.buffer.flush()
    except BaseException:
        if child > 0:
            try:
                os.kill(child, signal.SIGKILL)
            except ProcessLookupError:
                pass
            os.waitpid(child, 0)
        raise
    finally:
        if read_pipe >= 0:
            os.close(read_pipe)
        if write_pipe >= 0:
            os.close(write_pipe)
        os.close(descriptor)


def parse_identity(arguments: list[str]) -> tuple[int, str, int, int, str]:
    if len(arguments) != 5:
        fail()
    pid = parse_unsigned(arguments[0], 2**31 - 1)
    start = arguments[1]
    if (
        not start.isascii()
        or not start.isdecimal()
        or start.startswith("0")
    ):
        fail()
    descriptor = parse_unsigned(arguments[2], 2**20)
    size = parse_unsigned(arguments[3], MAXIMUM_BYTES)
    digest = arguments[4]
    if len(digest) != 71 or not digest.startswith("sha256:"):
        fail()
    if any(character not in "0123456789abcdef" for character in digest[7:]):
        fail()
    return pid, start, descriptor, size, digest


def inspect_identity(arguments: list[str]) -> None:
    identity = parse_identity(arguments)
    verify_memfd(*identity)
    sys.stdout.buffer.write(canonical({"status": "authenticated"}))


def retire(arguments: list[str]) -> None:
    if len(arguments) != 6:
        fail()
    identity = parse_identity(arguments[:5])
    deadline = parse_unsigned(arguments[5], 2**63 - 1)
    if deadline <= time.monotonic_ns():
        fail()
    if not hasattr(os, "pidfd_open") or not hasattr(signal, "pidfd_send_signal"):
        fail()
    pidfd = os.pidfd_open(identity[0], 0)
    try:
        verify_memfd(*identity)
        signal.pidfd_send_signal(pidfd, signal.SIGTERM)
        poller = select.poll()
        poller.register(pidfd, select.POLLIN)
        remaining_ms = max(0, (deadline - time.monotonic_ns()) // 1_000_000)
        if not poller.poll(remaining_ms):
            fail()
        while True:
            try:
                if process_start_time_ticks(identity[0]) != identity[1]:
                    break
            except FileNotFoundError:
                break
            if time.monotonic_ns() >= deadline:
                fail()
            time.sleep(0.01)
    finally:
        os.close(pidfd)
    sys.stdout.buffer.write(canonical({"status": "retired"}))


def main() -> None:
    if sys.platform != "linux" or len(sys.argv) < 2:
        fail()
    command = sys.argv[1]
    if command == "hold" and len(sys.argv) == 3:
        hold(parse_unsigned(sys.argv[2], 2**63 - 1))
    elif command == "inspect":
        inspect_identity(sys.argv[2:])
    elif command == "retire":
        retire(sys.argv[2:])
    else:
        fail()


if __name__ == "__main__":
    try:
        main()
    except BaseException:
        sys.stderr.write("integration.controller.failure-evidence-keeper\n")
        raise SystemExit(1)
