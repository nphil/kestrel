// How the panel decides that a signed media link is dead (src/recovery.ts). Node runs the TypeScript file as it is:
//   cd dashboard && npm test
import assert from "node:assert/strict";
import { test } from "node:test";
import { signatureRejected, signedLinkExpired } from "../src/recovery.ts";

const b64url = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const NOW = Date.UTC(2026, 9, 2, 12, 0, 0);
const link = (claims, path = "/api/kestrel/media/species_ref/Antrostomus%20carolinensis") =>
  `${path}?authSig=${b64url({ alg: "HS256", typ: "JWT" })}.${b64url(claims)}.signature`;
const at = (seconds) => Math.floor(NOW / 1000) + seconds;

test("a link past its expiry is dead without asking anybody", () => {
  assert.equal(signedLinkExpired(link({ exp: at(-1) }), 0, NOW), true);
  assert.equal(signedLinkExpired(link({ exp: at(-3600) }), 0, NOW), true);
});

test("a link that is still good is not", () => {
  assert.equal(signedLinkExpired(link({ exp: at(60) }), 0, NOW), false);
  assert.equal(signedLinkExpired(link({ exp: at(12 * 3600) }), 0, NOW), false);
});

test("the margin counts a link that is about to run out", () => {
  assert.equal(signedLinkExpired(link({ exp: at(30) }), 60_000, NOW), true);
  assert.equal(signedLinkExpired(link({ exp: at(90) }), 60_000, NOW), false);
});

test("a token with base64url characters is read", () => {
  // `?` (0x3f) and `>` (0x3e) in the claims make standard base64 use '/' and '+'; base64url writes '_' and '-'.
  const claims = { exp: at(-5), note: "???>>>" };
  const payload = b64url(claims);
  assert.match(payload, /[_-]/);
  assert.equal(signedLinkExpired(`/m?authSig=h.${payload}.s`, 0, NOW), true);
});

test("a link whose expiry cannot be read is never called expired", () => {
  for (const url of [null, undefined, "", "/media/x", "/media/x?authSig=", "/media/x?authSig=e0", "/media/x?authSig=a.b.c", "/media/x?authSig=a.!!!.c", link({ iss: "x" }), link({ exp: "soon" })]) {
    assert.equal(signedLinkExpired(url, 0, NOW), false, String(url));
  }
});

test("the signature is found among other query parameters", () => {
  const url = `/m/x.jpg?width=640&authSig=${b64url({})}.${b64url({ exp: at(-1) })}.s&height=480`;
  assert.equal(signedLinkExpired(url, 0, NOW), true);
});

const answering = (status) => async () => ({ status });

test("401 and 403 mean the signature is dead", async () => {
  assert.equal(await signatureRejected("/m?authSig=x", answering(401)), true);
  assert.equal(await signatureRejected("/m?authSig=x", answering(403)), true);
});

test("any other answer means the signature was accepted", async () => {
  for (const status of [200, 206, 204, 404, 500, 502]) assert.equal(await signatureRejected("/m?authSig=x", answering(status)), false, String(status));
});

test("an unreachable server is neither", async () => {
  const down = async () => { throw new TypeError("Failed to fetch"); };
  assert.equal(await signatureRejected("/m?authSig=x", down), null);
});

test("a server that is slow to answer counted the signature as good, and the check gives up", async () => {
  const slow = (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
  assert.equal(await signatureRejected("/m?authSig=x", slow, 20), false);
});

test("the check asks for one byte, never from the cache, and sends the sign-in cookie", async () => {
  let seen;
  await signatureRejected("/m?authSig=x", async (url, init) => { seen = { url, init }; return { status: 200 }; });
  assert.equal(seen.url, "/m?authSig=x");
  assert.equal(seen.init.headers.Range, "bytes=0-0");
  assert.equal(seen.init.cache, "no-store");
  assert.equal(seen.init.credentials, "same-origin");
});
