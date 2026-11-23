// Who took a reference photo: what the panel makes of the server's answer (src/api.ts) and the caption it writes (src/vocab.ts).
// Node runs the TypeScript files as they are:  cd dashboard && npm test
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { loadPhotoCredit, photoInfo } from "../src/api.ts";
import { photoCredit } from "../src/vocab.ts";

const info = (over = {}) => ({ source: "iNaturalist", credit: "Jane Birder", licence: "CC BY-NC", page: "https://www.inaturalist.org/photos/123", ...over });
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** Answers every fetch with `reply()` and counts the asks. */
const serve = (reply) => {
  const asked = [];
  globalThis.fetch = async (url) => { asked.push(String(url)); return reply(); };
  return asked;
};
const json = (value, status = 200) => () => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

test("the caption names only the parts it has, with no stray separators", () => {
  assert.equal(photoCredit(info()), "Photo · Jane Birder · CC BY-NC · iNaturalist");
  assert.equal(photoCredit(info({ credit: "" })), "Photo · CC BY-NC · iNaturalist");
  assert.equal(photoCredit(info({ licence: "" })), "Photo · Jane Birder · iNaturalist");
  assert.equal(photoCredit(info({ source: "" })), "Photo · Jane Birder · CC BY-NC");
  assert.equal(photoCredit(info({ credit: "", licence: "" })), "Photo · iNaturalist");
  assert.equal(photoCredit(info({ credit: "", licence: "", source: "" })), "Photo");
});

test("the answer is read as it is, and only an https page is kept as a link", () => {
  assert.deepEqual(photoInfo(info()), info());
  assert.equal(photoInfo(info({ page: "http://example.org/x" })).page, "");
  assert.equal(photoInfo(info({ page: "javascript:alert(1)" })).page, "");
  assert.equal(photoInfo(info({ page: "//example.org/x" })).page, "");
  assert.equal(photoInfo(info({ page: "" })).page, "");
  assert.equal(photoInfo(info({ page: 7 })).page, "");
  assert.equal(photoInfo(info({ credit: "  Jane  " })).credit, "Jane");
});

test("an answer with nothing to say is null", () => {
  for (const value of [undefined, null, 7, "iNaturalist", [], {}, { page: "https://example.org" }, info({ source: "", credit: "", licence: "" }), { source: 5, credit: null, licence: false }]) {
    assert.equal(photoInfo(value), null, JSON.stringify(value));
  }
});

test("200 gives the credit", async () => {
  serve(json(info()));
  assert.deepEqual(await loadPhotoCredit("/api/kestrel/media/reference-info/ok?authSig=a"), info());
});

test("204, an error status and an unreadable answer are null, and nothing is thrown", async () => {
  serve(() => new Response(null, { status: 204 }));
  assert.equal(await loadPhotoCredit("/api/kestrel/media/reference-info/none?authSig=a"), null);
  serve(json(info(), 500));
  assert.equal(await loadPhotoCredit("/api/kestrel/media/reference-info/broken?authSig=a"), null);
  serve(() => new Response("<html>not json</html>", { status: 200 }));
  assert.equal(await loadPhotoCredit("/api/kestrel/media/reference-info/garbage?authSig=a"), null);
  serve(json(["not", "an", "object"]));
  assert.equal(await loadPhotoCredit("/api/kestrel/media/reference-info/array?authSig=a"), null);
  serve(json({}));
  assert.equal(await loadPhotoCredit("/api/kestrel/media/reference-info/empty?authSig=a"), null);
  globalThis.fetch = async () => { throw new TypeError("network down"); };
  assert.equal(await loadPhotoCredit("/api/kestrel/media/reference-info/offline?authSig=a"), null);
});

test("a credit is asked for once per photo, whatever the signature", async () => {
  const asked = serve(json(info()));
  const first = await loadPhotoCredit("/api/kestrel/media/reference-info/jay?authSig=first");
  const again = await loadPhotoCredit("/api/kestrel/media/reference-info/jay?authSig=second");
  assert.deepEqual(again, first);
  assert.equal(asked.length, 1);
  await loadPhotoCredit("/api/kestrel/media/reference-info/wren?authSig=first");
  assert.equal(asked.length, 2, "another photo is another question");
});

test("a photo the server knew nothing about is asked about again, so a later credit shows up", async () => {
  let asked = 0;
  globalThis.fetch = async () => { asked += 1; return asked === 1 ? new Response(null, { status: 204 }) : json(info())(); };
  const url = "/api/kestrel/media/reference-info/late?authSig=a";
  assert.equal(await loadPhotoCredit(url), null);
  assert.deepEqual(await loadPhotoCredit(url), info());
  assert.equal(asked, 2);
});

test("a credit that takes longer than a few seconds is given up on, and the request is cancelled", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let cancelled = false;
  globalThis.fetch = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener("abort", () => { cancelled = true; reject(new DOMException("aborted", "AbortError")); });
  });
  const answer = loadPhotoCredit("/api/kestrel/media/reference-info/stuck?authSig=a");
  t.mock.timers.tick(7_999);
  await Promise.resolve();
  assert.equal(cancelled, false, "still waiting");
  t.mock.timers.tick(1);
  assert.equal(await answer, null);
  assert.equal(cancelled, true);
});

test("a credit that arrives in time leaves no timer behind", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  serve(json(info()));
  assert.deepEqual(await loadPhotoCredit("/api/kestrel/media/reference-info/quick?authSig=a"), info());
  let cancelled = false;
  globalThis.fetch = (url, init) => { init.signal.addEventListener("abort", () => { cancelled = true; }); return Promise.resolve(json(info())()); };
  await loadPhotoCredit("/api/kestrel/media/reference-info/quick-two?authSig=a");
  t.mock.timers.tick(60_000);
  assert.equal(cancelled, false, "nothing fired once the answer was in");
});

test("only the credits looked at lately are kept, so a tab left open does not grow without end", async () => {
  const asked = serve(json(info()));
  const url = (n) => `/api/kestrel/media/reference-info/species-${n}?authSig=a`;
  await loadPhotoCredit(url(0));
  for (let n = 1; n <= 250; n += 1) await loadPhotoCredit(url(n));
  assert.equal(asked.length, 251);
  await loadPhotoCredit(url(250));
  assert.equal(asked.length, 251, "a recent one is still kept");
  await loadPhotoCredit(url(0));
  assert.equal(asked.length, 252, "the first one was let go, and is asked about again");
});

test("a credit that is looked at again is not let go while others come and go", async () => {
  const asked = serve(json(info()));
  const url = (n) => `/api/kestrel/media/reference-info/loved-${n}?authSig=a`;
  await loadPhotoCredit(url("favourite"));
  for (let n = 0; n < 400; n += 1) {
    await loadPhotoCredit(url(n));
    if (n % 50 === 0) await loadPhotoCredit(url("favourite"));
  }
  assert.equal(asked.filter((address) => address.includes("favourite")).length, 1);
});
