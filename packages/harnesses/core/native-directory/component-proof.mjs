/** Candidate-only component proof; never loaded by ordinary package builds. */
import assert from "node:assert/strict";
import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
const fail = () => {
  throw new Error("harness.directory.candidate-invalid");
};
export const componentProof = (output, directory) => {
  const primitive = createRequire(import.meta.url)(output);
  if (Object.keys(primitive).join(",") !== "observeDirectory") fail();
  mkdirSync(directory, { mode: 0o700 });
  writeFileSync(join(directory, "one"), "", { flag: "wx", mode: 0o600 });
  const fd = openSync(
    directory,
    constants.O_RDONLY |
      constants.O_NOFOLLOW |
      constants.O_DIRECTORY |
      constants.O_NONBLOCK,
  );
  try {
    const expected = fstatSync(fd, { bigint: true });
    const actual = primitive.observeDirectory(fd);
    assert.equal(actual.dev, expected.dev);
    assert.equal(actual.ino, expected.ino);
    assert.equal(actual.mode, expected.mode);
    assert.deepEqual(
      actual.entries.map((value) => Buffer.from(value).toString("utf8")),
      ["one"],
    );
    for (const invalid of [-1, 1.5, NaN, Infinity])
      assert.throws(() => primitive.observeDirectory(invalid));
  } finally {
    closeSync(fd);
  }
  const held = openSync(
    directory,
    constants.O_RDONLY |
      constants.O_NOFOLLOW |
      constants.O_DIRECTORY |
      constants.O_NONBLOCK,
  );
  try {
    const identity = fstatSync(held, { bigint: true });
    renameSync(directory, `${directory}-held`);
    mkdirSync(directory, { mode: 0o700 });
    writeFileSync(join(directory, "replacement"), "", {
      flag: "wx",
      mode: 0o600,
    });
    const observed = primitive.observeDirectory(held);
    assert.equal(observed.ino, identity.ino);
    assert.deepEqual(
      observed.entries.map((value) => Buffer.from(value).toString("utf8")),
      ["one"],
    );
  } finally {
    closeSync(held);
  }
  const counted = `${directory}-counted`;
  mkdirSync(counted, { mode: 0o700 });
  for (let index = 0; index < 1024; index += 1)
    writeFileSync(join(counted, `entry-${index}`), "", {
      flag: "wx",
      mode: 0o600,
    });
  const countFd = openSync(
    counted,
    constants.O_RDONLY |
      constants.O_NOFOLLOW |
      constants.O_DIRECTORY |
      constants.O_NONBLOCK,
  );
  try {
    assert.equal(primitive.observeDirectory(countFd).entries.length, 1024);
  } finally {
    closeSync(countFd);
  }
  writeFileSync(join(counted, "overflow"), "", { flag: "wx", mode: 0o600 });
  const overflowFd = openSync(
    counted,
    constants.O_RDONLY |
      constants.O_NOFOLLOW |
      constants.O_DIRECTORY |
      constants.O_NONBLOCK,
  );
  try {
    assert.throws(() => primitive.observeDirectory(overflowFd));
  } finally {
    closeSync(overflowFd);
  }
};
