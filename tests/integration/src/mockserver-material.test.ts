import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  callbackSourcePin,
  patchCallbackSource,
} from "../mockserver-material/callback-patch.mjs";

const source = readFileSync(
  new URL(
    "../mockserver-material/upstream/CallbackWebSocketServerHandler.java",
    import.meta.url,
  ),
);
const sha256 = (bytes: string | Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

describe("exact upstream MockServer callback patch input", () => {
  it("binds the pinned source bytes and Git blob, not a moving tag", () => {
    expect(source.byteLength).toBe(callbackSourcePin.bytes);
    expect(sha256(source)).toBe(callbackSourcePin.sha256);
    expect(
      createHash("sha1")
        .update(`blob ${source.byteLength}\0`)
        .update(source)
        .digest("hex"),
    ).toBe(callbackSourcePin.blob);
    expect(callbackSourcePin.commit).toBe(
      "99005f7f6eb8397add23b2e04400f1f739c33d1f",
    );
    expect(Object.isFrozen(callbackSourcePin)).toBe(true);
  });

  it("is deterministic and does not mutate acquired source", () => {
    const before = Buffer.from(source);
    expect(patchCallbackSource(source)).toBe(
      patchCallbackSource(Buffer.from(source)),
    );
    expect(source).toEqual(before);
    expect(sha256(patchCallbackSource(source))).toBe(
      "6fba7800f61cfcf92ffe62b1269a6395d1f4d4da84429480771a95dbcbdd3920",
    );
  });

  it("retains the exact upstream Apache license", () => {
    const license = readFileSync(
      new URL("../mockserver-material/upstream/LICENSE", import.meta.url),
    );
    expect(
      createHash("sha1")
        .update(`blob ${license.byteLength}\0`)
        .update(license)
        .digest("hex"),
    ).toBe("8dada3edaf50dbc082c9a125058f25def75e625a");
  });

  it("rejects a proxy without reading its caller-controlled properties", () => {
    let reads = 0;
    const proxy = new Proxy(Buffer.from(source), {
      get() {
        reads += 1;
        throw new Error("caller getter executed");
      },
      getPrototypeOf() {
        reads += 1;
        throw new Error("caller prototype trap executed");
      },
    });
    expect(() => patchCallbackSource(proxy)).toThrow(
      "integration.mockserver-material.callback-preimage",
    );
    expect(reads).toBe(0);
  });

  it("copies intrinsic byte slots without executing length/valueOf hooks", () => {
    const hostile = Buffer.from(source);
    let reads = 0;
    for (const key of [
      "byteLength",
      "length",
      "buffer",
      "byteOffset",
      "valueOf",
    ]) {
      Object.defineProperty(hostile, key, {
        get() {
          reads += 1;
          throw new Error("caller getter executed");
        },
      });
    }
    expect(sha256(patchCallbackSource(hostile))).toBe(
      "6fba7800f61cfcf92ffe62b1269a6395d1f4d4da84429480771a95dbcbdd3920",
    );
    expect(reads).toBe(0);
  });
});

describe("exact patched callback source", () => {
  it.each(["missing", "extra", "substituted", "already-patched"])(
    "rejects %s preimages instead of patching a different source",
    (kind) => {
      const altered =
        kind === "missing"
          ? source.subarray(1)
          : kind === "extra"
            ? Buffer.concat([source, Buffer.from("\n")])
            : kind === "already-patched"
              ? Buffer.from(patchCallbackSource(source))
              : Buffer.from(source);
      if (kind === "substituted") altered[100] = altered[100]! ^ 1;
      expect(() => patchCallbackSource(altered)).toThrow(
        "integration.mockserver-material.callback-preimage",
      );
    },
  );

  it("places the shared authentication decision before handshake and registration", () => {
    const patched = patchCallbackSource(source);
    const read = patched.slice(
      patched.indexOf("public void channelRead("),
      patched.indexOf("public void channelReadComplete("),
    );
    expect(read.indexOf("callbackUpgradeAuthenticated(ctx")).toBeLessThan(
      read.indexOf("isHttp2Enabled(ctx.channel())"),
    );
    expect(read.indexOf("callbackUpgradeAuthenticated(ctx")).toBeLessThan(
      read.indexOf("upgradeChannel(ctx"),
    );
    expect(read).toContain(
      "if (!callbackUpgradeAuthenticated(ctx, (FullHttpRequest) msg)) {\n                    return;",
    );
    expect(patched).toContain(
      "httpState.evaluateControlPlaneAuthentication(mapped)",
    );
    expect(patched).toContain(
      "httpState.getControlPlaneAuthenticationHandler() == null",
    );
    expect(patched).toContain(
      "HttpResponseStatus.FORBIDDEN : HttpResponseStatus.UNAUTHORIZED",
    );
    expect(patched).toContain(
      "Http2StreamIds.stampFromNettyRequest(response, request)",
    );
    expect(patched).toContain("addListener(ChannelFutureListener.CLOSE)");
  });

  it("preserves the exact model-independent handshake/frame implementation", () => {
    const marker =
      "    private void upgradeChannel(final ChannelHandlerContext ctx, FullHttpRequest httpRequest) {";
    const original = source.toString("utf8");
    const patched = patchCallbackSource(source);
    expect(patched.slice(patched.indexOf(marker))).toBe(
      original.slice(original.indexOf(marker)),
    );
  });
});
