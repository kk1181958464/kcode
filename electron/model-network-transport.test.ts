import assert from "node:assert/strict";
import test from "node:test";
import {
  isChromiumNetworkTransportError,
  isDirectNetworkTransportError,
  nextModelNetworkTransport,
  networkTransportErrorText,
} from "./model-network-transport";

test("switches from Electron to direct transport after Chromium stream errors", () => {
  for (const message of [
    "net::ERR_EMPTY_RESPONSE",
    "net::ERR_INCOMPLETE_CHUNKED_ENCODING",
    "net::ERR_HTTP2_PROTOCOL_ERROR",
  ]) {
    const error = new Error(message);
    assert.equal(isChromiumNetworkTransportError(error), true);
    assert.equal(nextModelNetworkTransport("electron", error), "direct");
  }
});

test("switches back when the direct transport cannot reach the provider", () => {
  const error = new TypeError("fetch failed", {
    cause: new Error("UND_ERR_SOCKET: other side closed"),
  });
  assert.equal(isDirectNetworkTransportError(error), true);
  assert.match(networkTransportErrorText(error), /UND_ERR_SOCKET/);
  assert.equal(nextModelNetworkTransport("direct", error), "electron");
});

test("does not switch transport for model or authentication errors", () => {
  for (const message of ["invalid api key", "模型不属于当前供应商"]) {
    const error = new Error(message);
    assert.equal(nextModelNetworkTransport("electron", error), "electron");
    assert.equal(nextModelNetworkTransport("direct", error), "direct");
  }
});
