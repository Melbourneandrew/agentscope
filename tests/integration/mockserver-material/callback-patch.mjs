/** Exact upstream callback patch; not a build, runtime or admission receipt. */
import { createHash } from "node:crypto";

export const callbackSourcePin = Object.freeze({
  repository: "https://github.com/mock-server/mockserver-monorepo",
  commit: "99005f7f6eb8397add23b2e04400f1f739c33d1f",
  tree: "333bec518db87837c485f2cc31b6c46ccda3994e",
  path: "mockserver/mockserver-netty/src/main/java/org/mockserver/netty/websocketregistry/CallbackWebSocketServerHandler.java",
  blob: "57b475c1a1e2e2efbbf6ce8114a2ba538ae32d77",
  bytes: 9101,
  sha256: "a7405e04faeb27cf0b9811557a8e70a78ecb92d237d9fb462fcd6505b36d8edf",
});

const fail = () => {
  throw new Error("integration.mockserver-material.callback-preimage");
};
const replaceExactlyOnce = (source, before, after) => {
  const index = source.indexOf(before);
  if (index < 0 || source.indexOf(before, index + before.length) >= 0) fail();
  return source.slice(0, index) + after + source.slice(index + before.length);
};

// Uses MockServer's existing parsed request and shared auth decision. No second
// token registry, model parser, listener or gateway is introduced.
const authenticateUpgrade = `    private boolean callbackUpgradeAuthenticated(ChannelHandlerContext ctx, FullHttpRequest request) {
        if (httpState.getControlPlaneAuthenticationHandler() == null) {
            rejectCallbackUpgrade(ctx, request, HttpResponseStatus.UNAUTHORIZED);
            return false;
        }
        org.mockserver.model.HttpRequest mapped = new org.mockserver.mappers.FullHttpRequestToMockServerHttpRequest(
            httpState.getConfiguration(),
            mockServerLogger,
            isSslEnabledUpstream(ctx.channel()),
            org.mockserver.socket.tls.SniHandler.retrieveClientCertificates(mockServerLogger, ctx),
            ctx.channel().localAddress() instanceof java.net.InetSocketAddress
                ? ((java.net.InetSocketAddress) ctx.channel().localAddress()).getPort() : null
        ).mapFullHttpRequestToMockServerRequest(
            request, null, ctx.channel().localAddress(), ctx.channel().remoteAddress(),
            org.mockserver.socket.tls.SniHandler.getALPNProtocol(mockServerLogger, ctx)
        );
        HttpState.ControlPlaneAuthDecision decision = httpState.evaluateControlPlaneAuthentication(mapped);
        if (decision.isAllowed()) {
            return true;
        }
        rejectCallbackUpgrade(ctx, request,
            decision.outcome() == HttpState.ControlPlaneAuthOutcome.FORBIDDEN
                ? HttpResponseStatus.FORBIDDEN : HttpResponseStatus.UNAUTHORIZED);
        return false;
    }

    private void rejectCallbackUpgrade(ChannelHandlerContext ctx, FullHttpRequest request, HttpResponseStatus status) {
        DefaultFullHttpResponse response = new DefaultFullHttpResponse(HttpVersion.HTTP_1_1, status, Unpooled.EMPTY_BUFFER);
        HttpUtil.setContentLength(response, 0);
        Http2StreamIds.stampFromNettyRequest(response, request);
        ctx.channel().writeAndFlush(response).addListener(ChannelFutureListener.CLOSE);
    }

`;

export const patchCallbackSource = (input) => {
  if (!Buffer.isBuffer(input) || input.byteLength !== callbackSourcePin.bytes)
    fail();
  const bytes = Buffer.from(input);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const blob = createHash("sha1")
    .update(`blob ${bytes.byteLength}\0`)
    .update(bytes)
    .digest("hex");
  if (digest !== callbackSourcePin.sha256 || blob !== callbackSourcePin.blob)
    fail();
  let source = bytes.toString("utf8");
  source = replaceExactlyOnce(
    source,
    "    private final MockServerLogger mockServerLogger;",
    "    private final MockServerLogger mockServerLogger;\n    private final HttpState httpState;",
  );
  source = replaceExactlyOnce(
    source,
    "    public CallbackWebSocketServerHandler(HttpState httpStateHandler) {",
    "    public CallbackWebSocketServerHandler(HttpState httpStateHandler) {\n        httpState = httpStateHandler;",
  );
  source = replaceExactlyOnce(
    source,
    "                if (isHttp2Enabled(ctx.channel())) {",
    "                if (!callbackUpgradeAuthenticated(ctx, (FullHttpRequest) msg)) {\n                    return;\n                }\n                if (isHttp2Enabled(ctx.channel())) {",
  );
  const patched = replaceExactlyOnce(
    source,
    "    private void upgradeChannel(final ChannelHandlerContext ctx, FullHttpRequest httpRequest) {",
    authenticateUpgrade +
      "    private void upgradeChannel(final ChannelHandlerContext ctx, FullHttpRequest httpRequest) {",
  );
  if (
    createHash("sha256").update(patched).digest("hex") !==
    "6fba7800f61cfcf92ffe62b1269a6395d1f4d4da84429480771a95dbcbdd3920"
  )
    fail();
  return patched;
};
