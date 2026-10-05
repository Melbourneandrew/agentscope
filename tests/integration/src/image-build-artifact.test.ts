import { describe, expect, it } from "vitest";

import {
  maximumBuildArtifactBytes,
  readBuildArtifactTar,
} from "../image-preparation/build-artifact.mjs";

const failure = "integration.images.build.artifact";
const checksum = (archive: Buffer) => {
  archive.fill(32, 148, 156);
  const sum = archive.subarray(0, 512).reduce((total, byte) => total + byte, 0);
  archive.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
};
const tar = (payload = Buffer.from('{"research":true}')) => {
  const archive = Buffer.alloc(
    512 + Math.ceil(payload.length / 512) * 512 + 1024,
  );
  archive.write("material.json");
  const fields: readonly (readonly [number, number, number])[] = [
    [100, 8, 0o644],
    [108, 8, 0],
    [116, 8, 0],
    [124, 12, payload.length],
    [136, 12, 0],
    [329, 8, 0],
    [337, 8, 0],
  ];
  for (const [offset, length, value] of fields)
    archive.write(
      `${value.toString(8).padStart(length - 1, "0")}\0`,
      offset,
      "ascii",
    );
  archive[156] = 48;
  archive.write("ustar\0", 257, "ascii");
  archive.write("00", 263, "ascii");
  payload.copy(archive, 512);
  checksum(archive);
  return archive;
};

describe("bounded build research tar", () => {
  it("returns owned exact bytes without JSON parsing or extraction", () => {
    const payload = Buffer.from([0, 255, 128, 10]);
    const archive = tar(payload);
    const result = readBuildArtifactTar(archive);
    expect(result).toEqual(payload);
    archive.fill(1);
    expect(result).toEqual(payload);
  });
  it.each(["../material.json", "/material.json", "other.json"])(
    "rejects name %s",
    (name) => {
      const archive = tar();
      archive.fill(0, 0, 100);
      archive.write(name);
      checksum(archive);
      expect(() => readBuildArtifactTar(archive)).toThrow(failure);
    },
  );
  it.each([49, 50, 51, 52, 53, 54, 55, 76, 120])(
    "rejects nonregular type %i",
    (type) => {
      const archive = tar();
      archive[156] = type;
      checksum(archive);
      expect(() => readBuildArtifactTar(archive)).toThrow(failure);
    },
  );
  it.each([100, 108, 116, 124, 136, 148, 157, 257, 263, 265, 329, 337, 345])(
    "rejects malformed authority/header field %i",
    (offset) => {
      const archive = tar();
      archive[offset] = 255;
      if (offset !== 148) checksum(archive);
      expect(() => readBuildArtifactTar(archive)).toThrow(failure);
    },
  );
  it("rejects truncation, nonzero padding, extra members and excess bytes", () => {
    const archive = tar();
    for (const invalid of [
      archive.subarray(0, 1024),
      archive.subarray(0, archive.length - 1),
      Buffer.concat([archive, Buffer.from([0])]),
      Buffer.alloc(maximumBuildArtifactBytes + 10241),
    ])
      expect(() => readBuildArtifactTar(invalid)).toThrow(failure);
    archive[900] = 1;
    expect(() => readBuildArtifactTar(archive)).toThrow(failure);
    const duplicate = Buffer.concat([tar().subarray(0, 1024), tar()]);
    expect(() => readBuildArtifactTar(duplicate)).toThrow(failure);
  });
  it("accepts the inclusive payload bound and rejects empty/excess payload", () => {
    expect(
      readBuildArtifactTar(tar(Buffer.alloc(maximumBuildArtifactBytes))).length,
    ).toBe(maximumBuildArtifactBytes);
    for (const size of [0, maximumBuildArtifactBytes + 1])
      expect(() => readBuildArtifactTar(tar(Buffer.alloc(size)))).toThrow(
        failure,
      );
  });
  it.each([108, 116, 329, 337])(
    "rejects nonzero ownership/device field %i",
    (offset) => {
      const archive = tar();
      archive.write("0000001\0", offset, "ascii");
      checksum(archive);
      expect(() => readBuildArtifactTar(archive)).toThrow(failure);
    },
  );
  it("rejects post-NUL name data and nonzero terminal padding", () => {
    for (const offset of [30, 1535]) {
      const archive = tar();
      archive[offset] = 65;
      if (offset < 512) checksum(archive);
      expect(() => readBuildArtifactTar(archive)).toThrow(failure);
    }
  });
  it("rejects proxies without consulting their properties", () => {
    let effects = 0;
    const input = new Proxy(tar(), {
      get() {
        effects += 1;
        throw new Error("trap");
      },
    });
    expect(() => readBuildArtifactTar(input)).toThrow(failure);
    expect(effects).toBe(0);
  });
});
