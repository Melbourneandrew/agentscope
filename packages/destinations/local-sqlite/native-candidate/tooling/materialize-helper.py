#!/usr/bin/python3
import base64
import hashlib
import json
import os
import stat
import sys

INVALID = "destination.local-sqlite.native-materialization.invalid"


def fail():
    raise RuntimeError(INVALID)


target = sys.argv[1]
hostile_parent_swap = len(sys.argv) == 4 and sys.argv[2] == "--hostile-parent-swap"
outside = sys.argv[3] if hostile_parent_swap else None
records = json.load(sys.stdin)
root = os.open(target, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
descriptors = {"": root}
try:
    metadata = os.fstat(root)
    if not stat.S_ISDIR(metadata.st_mode) or stat.S_IMODE(metadata.st_mode) != 0o700:
        fail()
    directories = set()
    for record in records:
        parts = record["path"].split("/")
        for length in range(1, len(parts)):
            directories.add("/".join(parts[:length]))
    for relative in sorted(directories, key=lambda value: (value.count("/"), value)):
        parent, _, name = relative.rpartition("/")
        os.mkdir(name, 0o700, dir_fd=descriptors[parent])
        descriptor = os.open(
            name,
            os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
            dir_fd=descriptors[parent],
        )
        if not stat.S_ISDIR(os.fstat(descriptor).st_mode):
            fail()
        descriptors[relative] = descriptor
    if hostile_parent_swap:
        if "nested" not in descriptors or outside is None:
            fail()
        os.rename("nested", "nested-retained", src_dir_fd=root, dst_dir_fd=root)
        os.symlink(outside, "nested", dir_fd=root)
    for record in records:
        parent, _, name = record["path"].rpartition("/")
        payload = base64.b64decode(record["base64"], validate=True)
        if len(payload) != record["bytes"] or hashlib.sha256(payload).hexdigest() != record["sha256"]:
            fail()
        descriptor = os.open(
            name,
            os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
            0o400,
            dir_fd=descriptors[parent],
        )
        try:
            offset = 0
            while offset < len(payload):
                offset += os.write(descriptor, payload[offset:])
            metadata = os.fstat(descriptor)
            if not stat.S_ISREG(metadata.st_mode) or metadata.st_size != len(payload):
                fail()
            os.lseek(descriptor, 0, os.SEEK_SET)
            observed = bytearray()
            while len(observed) < len(payload):
                chunk = os.read(descriptor, len(payload) - len(observed))
                if not chunk:
                    fail()
                observed.extend(chunk)
            if os.read(descriptor, 1) or hashlib.sha256(observed).hexdigest() != record["sha256"]:
                fail()
        finally:
            os.close(descriptor)
    for descriptor in descriptors.values():
        if not stat.S_ISDIR(os.fstat(descriptor).st_mode):
            fail()
    expected_children = {relative: set() for relative in descriptors}
    for relative in directories:
        parent, _, name = relative.rpartition("/")
        expected_children[parent].add(name)
    for record in records:
        parent, _, name = record["path"].rpartition("/")
        expected_children[parent].add(name)
    for relative, descriptor in descriptors.items():
        if set(os.listdir(descriptor)) != expected_children[relative]:
            fail()
    for relative, descriptor in descriptors.items():
        if relative == "":
            continue
        parent, _, name = relative.rpartition("/")
        linked = os.stat(name, dir_fd=descriptors[parent], follow_symlinks=False)
        retained = os.fstat(descriptor)
        if (
            not stat.S_ISDIR(linked.st_mode)
            or linked.st_dev != retained.st_dev
            or linked.st_ino != retained.st_ino
        ):
            fail()
    for record in records:
        parent, _, name = record["path"].rpartition("/")
        descriptor = os.open(
            name,
            os.O_RDONLY | os.O_NOFOLLOW,
            dir_fd=descriptors[parent],
        )
        try:
            metadata = os.fstat(descriptor)
            if not stat.S_ISREG(metadata.st_mode) or metadata.st_size != record["bytes"]:
                fail()
            observed = bytearray()
            while len(observed) < record["bytes"]:
                chunk = os.read(descriptor, record["bytes"] - len(observed))
                if not chunk:
                    fail()
                observed.extend(chunk)
            if os.read(descriptor, 1) or hashlib.sha256(observed).hexdigest() != record["sha256"]:
                fail()
        finally:
            os.close(descriptor)
    print(json.dumps({"files": len(records), "authority": "descriptor-relative-openat", "hostileParentSwap": False}))
finally:
    for descriptor in reversed(list(descriptors.values())):
        os.close(descriptor)
