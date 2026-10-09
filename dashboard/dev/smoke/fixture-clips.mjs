#!/usr/bin/env node
// Deleting saved camera clips: the "Saved clips" section of Settings, and "Delete clip" on a visit page.
//   taskset -c 0-4,8-12 nice -n 15 node dev/smoke/fixture-clips.mjs [--size 390x844] [--theme flat-light]
// Needs `node dev/build.mjs` first. Screenshots go to /tmp/kestrel-clips (OUT=... changes it). The clips come from dev/harness.ts
// (312 of them; `admin=0`, `clipfail=1`, `clipdelay=ms`, `clip=ready` are harness settings).
//   (1) the section: "312 clips · 1.4 GB · oldest <month year>", and both ways to delete
//   (2) "older than": the four choices, then a confirm that names how many clips and says photos and visits are kept; "Keep them" deletes nothing
//   (3) confirming shows progress, then "Deleted N clips, freed X MB", and the numbers drop by N
//   (4) "marked Not an animal / Can't tell": its own count and size, the same confirm, the same result
//   (5) a failing recorder: an error where the numbers would be; an error inside a delete keeps the confirm and says it can be tried again
//   (6) a non-administrator sees the numbers and no delete buttons
//   (7) the visit page: "Delete clip", the confirm, then "This clip was deleted."
process.env.OUT ??= "/tmp/kestrel-clips";
const { runSmoke } = await import("./lib/fixture.mjs");

const text = (node) => (node?.textContent ?? "").replace(/\s+/g, " ").trim();
const read = (deep) => {
  const box = deep(window.__panelRoot(), "kestrel-clip-storage")[0];
  const root = box?.shadowRoot;
  if (!root) return null;
  const confirm = root.querySelector("kestrel-clip-confirm")?.shadowRoot;
  const t = (node) => (node?.textContent ?? "").replace(/\s+/g, " ").trim();
  return {
    summary: t(root.querySelector(".summary")) || t(root.querySelector(".empty")),
    result: t(root.querySelector(".result")),
    problem: t(root.querySelector(".problem")),
    note: t(root.querySelector(".note")),
    state: (() => { const el = root.querySelector("kestrel-lu-state"); return el ? `${el.heading ?? ""} ${el.message ?? ""}`.trim() : ""; })(),
    actions: [...root.querySelectorAll(".action .copy")].map((el) => t(el)),
    deleteButtons: root.querySelectorAll(".action kestrel-lu-button").length,
    ageChoices: [...root.querySelectorAll(".choices kestrel-lu-button")].map((el) => el.label),
    confirm: confirm ? { ask: t(confirm.querySelector(".ask")), about: t(confirm.querySelector(".about")), busy: t(confirm.querySelector(".busy")), problem: t(confirm.querySelector(".problem")), buttons: [...confirm.querySelectorAll("kestrel-lu-button")].map((el) => el.label) } : null,
    overflow: document.documentElement.scrollWidth - innerWidth,
  };
};

await runSmoke("fixture-clips", async (fx) => {
  const openSettings = async (query = "admin=1&clipfail=0") => {
    await fx.open(`/kestrel/live?${query}`);
    await fx.page.locator("kestrel-lu-button[label='Settings']").first().click();
    return fx.poll(async () => { const v = await fx.ev(read); return v && (v.summary || v.problem || (v.state && !/^Counting clips/.test(v.state))) ? v : null; }, { timeout: 12000 });
  };
  const toSection = async () => { await fx.page.locator("kestrel-clip-storage").first().scrollIntoViewIfNeeded(); await fx.settle(450); };
  const until = (test, timeout = 8000) => fx.poll(async () => { const v = await fx.ev(read); return v && test(v) ? v : null; }, { timeout });
  const count = (v) => Number(/^(\d+)/.exec(v.summary)?.[1] ?? NaN);

  // ---- (1) the section ----------------------------------------------------------------------------------------------------------
  let v = await openSettings("admin=1&clipfail=0&clipdelay=900");
  await toSection();
  v = await fx.ev(read);
  await fx.check("(1) the numbers read '312 clips · 1.4 GB · oldest <Month Year>'", /^312 clips · 1\.4 GB · oldest [A-Z][a-z]{2} \d{4}$/.test(v.summary), v.summary);
  await fx.check("(1) both ways to delete are offered, the second names its count and size", v.deleteButtons === 2 && /^Delete clips older than…/.test(v.actions[0]) && /Delete clips from visits marked Not an animal \/ Can't tell/.test(v.actions[1]) && /\d+ clips · [\d.]+ MB/.test(v.actions[1]), JSON.stringify(v.actions));
  await fx.check("(1) the page does not scroll sideways", v.overflow <= 0, `${v.overflow}px`);
  await fx.shot("section");
  const total = count(v);

  // ---- (2) older than ------------------------------------------------------------------------------------------------------------
  await fx.page.locator("kestrel-clip-storage kestrel-lu-button[label='Choose…']").click();
  v = await until((now) => now.ageChoices.length > 0);
  await fx.check("(2) the choices are 1 month, 3 months, 6 months, 1 year", JSON.stringify(v?.ageChoices) === JSON.stringify(["1 month", "3 months", "6 months", "1 year"]), JSON.stringify(v?.ageChoices));
  await toSection();
  await fx.shot("age");
  await fx.page.locator('kestrel-clip-storage .choices >> role=button[name="3 months"]').click();
  v = await until((now) => now.confirm);
  const asked = Number(/Delete (\d+) clips?\?/.exec(v?.confirm?.ask ?? "")?.[1] ?? NaN);
  await fx.check("(2) before deleting it says how many clips and how much space", asked > 0 && asked < total && /This frees about [\d.]+ (MB|GB)\./.test(v.confirm.ask), v?.confirm?.ask);
  await fx.check("(2) it says photos and visits are kept", /Photos and visits are kept/.test(v.confirm.about), v.confirm.about);
  await fx.check("(2) the buttons say what they do", JSON.stringify(v.confirm.buttons) === JSON.stringify([`Delete ${asked} clips`, "Keep them"]), JSON.stringify(v.confirm.buttons));
  await toSection();
  await fx.shot("confirm");
  await fx.page.locator("kestrel-clip-confirm kestrel-lu-button[label='Keep them']").click();
  v = await until((now) => !now.confirm);
  await fx.check("(2) Keep them deletes nothing", count(v) === total && !v.result, v.summary);

  // ---- (3) deleting ---------------------------------------------------------------------------------------------------------------
  await fx.page.locator("kestrel-clip-storage kestrel-lu-button[label='Choose…']").click();
  await fx.page.locator('kestrel-clip-storage .choices >> role=button[name="3 months"]').click();
  await until((now) => now.confirm);
  await fx.page.locator(`kestrel-clip-confirm >> role=button[name="Delete ${asked} clips"]`).click();
  v = await until((now) => now.confirm?.busy);
  await fx.check("(3) progress is shown while it deletes", /Deleting \d+ clips…/.test(v?.confirm?.busy ?? ""), v?.confirm?.busy);
  await toSection();
  await fx.shot("deleting");
  v = await until((now) => now.result);
  await fx.check("(3) the result says what was deleted and freed", new RegExp(`^Deleted ${asked} clips, freed [\\d.]+ (MB|GB)$`).test(v?.result ?? ""), v?.result);
  await fx.check("(3) the numbers dropped by that many clips and the confirm is gone", count(v) === total - asked && !v.confirm, v.summary);
  await toSection();
  await fx.shot("result");

  // ---- (4) marked Not an animal / Can't tell -----------------------------------------------------------------------------------------
  const wanted = Number(/(\d+) clips? ·/.exec(v.actions[1])?.[1] ?? NaN);
  await fx.page.locator("kestrel-clip-storage kestrel-lu-button[label='Delete…']").click();
  v = await until((now) => now.confirm);
  await fx.check("(4) the confirm names the same count the button showed", v?.confirm?.ask.startsWith(`Delete ${wanted} clips?`) && /Photos and visits are kept/.test(v.confirm.about), v?.confirm?.ask);
  const before = count(await fx.ev(read));
  await fx.page.locator(`kestrel-clip-confirm >> role=button[name="Delete ${wanted} clips"]`).click();
  v = await until((now) => now.result && /^Deleted/.test(now.result), 20000);
  await fx.check("(4) the result and the new numbers", !!v && count(v) === before - wanted && /^Deleted \d+ clips, freed/.test(v.result), `${v?.result} / ${v?.summary}`);

  // ---- (5) a failing recorder ---------------------------------------------------------------------------------------------------------
  v = await openSettings("admin=1&clipfail=1");
  await toSection();
  await fx.check("(5) when the recorder does not answer, an error replaces the numbers", /Couldn't count the clips/.test(v.state) && /camera recorder isn't answering/.test(v.state), v.state);
  await fx.shot("error");

  // ---- (6) not an administrator -----------------------------------------------------------------------------------------------------
  v = await openSettings("admin=0&clipfail=0");
  await toSection();
  await fx.check("(6) a non-administrator sees the numbers", /^\d+ clips · /.test(v.summary), v.summary);
  await fx.check("(6) and no delete buttons, only the reason", v.deleteButtons === 0 && /Only a Home Assistant administrator can delete clips/.test(v.note), `${v.deleteButtons} buttons; ${v.note}`);
  await fx.shot("non-admin");

  // ---- (7) the visit page -----------------------------------------------------------------------------------------------------------
  const page = () => fx.ev((deep) => {
    const root = window.__panelRoot();
    const t = (node) => (node?.textContent ?? "").replace(/\s+/g, " ").trim();
    const confirm = deep(root, "kestrel-clip-confirm").find((el) => window.__shown(el))?.shadowRoot;
    return { video: deep(root, ".visit-video").some((el) => window.__shown(el)), deleteButton: deep(root, ".clip-delete > kestrel-lu-button").some((el) => window.__shown(el)), ask: t(confirm?.querySelector(".ask")), about: t(confirm?.querySelector(".about")), note: t(deep(root, ".media-note").find((el) => window.__shown(el))), overflow: document.documentElement.scrollWidth - innerWidth };
  });
  await fx.open("/kestrel/visit?v=fixture-visit-1&admin=0&clipfail=0&clip=ready");
  let p = await fx.poll(async () => { const now = await page(); return now.video ? now : null; }, { timeout: 12000 });
  await fx.check("(7) a non-administrator sees the clip and no Delete clip", !!p && !p.deleteButton, JSON.stringify(p));
  await fx.open("/kestrel/visit?v=fixture-visit-1&admin=1&clipfail=1&clip=ready");
  p = await fx.poll(async () => { const now = await page(); return now.video && now.deleteButton ? now : null; }, { timeout: 12000 });
  await fx.check("(7) an administrator sees Delete clip next to the clip", !!p, JSON.stringify(p));
  // A recorder that does not answer: the confirm stays, says why, and the clip is still there.
  await fx.page.locator(".clip-delete kestrel-lu-button[label='Delete clip']").first().click();
  await fx.page.locator('kestrel-clip-confirm >> role=button[name="Delete 1 clip"]').first().click();
  const failed = await fx.poll(async () => { const t = await fx.ev((deep) => { const c = deep(window.__panelRoot(), "kestrel-clip-confirm").find((el) => window.__shown(el))?.shadowRoot; return (c?.querySelector(".problem")?.textContent ?? "").replace(/\s+/g, " ").trim(); }); return t || null; }, { timeout: 8000 });
  p = await page();
  await fx.check("(7) when deleting fails the confirm stays, says why, and the clip is kept", /isn't answering\. You can try again\./.test(failed ?? "") && p.video, failed ?? "");
  await fx.page.locator("kestrel-clip-confirm kestrel-lu-button[label='Keep them']").first().click();
  await fx.open("/kestrel/visit?v=fixture-visit-1&admin=1&clipfail=0&clip=ready");
  p = await fx.poll(async () => { const now = await page(); return now.video && now.deleteButton ? now : null; }, { timeout: 12000 });
  await fx.page.locator(".clip-delete kestrel-lu-button[label='Delete clip']").first().click();
  p = await fx.poll(async () => { const now = await page(); return now.ask ? now : null; }, { timeout: 5000 });
  await fx.check("(7) the confirm names the clip and says photos and visits are kept", p?.ask === "Delete 1 clip?" && /Photos and visits are kept/.test(p.about), JSON.stringify(p));
  await fx.page.locator(".clip-delete").first().scrollIntoViewIfNeeded();
  await fx.settle(450);
  await fx.shot("visit-confirm");
  await fx.page.locator('kestrel-clip-confirm >> role=button[name="Delete 1 clip"]').first().click();
  p = await fx.poll(async () => { const now = await page(); return /deleted/i.test(now.note) ? now : null; }, { timeout: 8000 });
  await fx.check("(7) afterwards the page says 'This clip was deleted.' and the clip is gone", p?.note === "This clip was deleted." && !p.video && !p.deleteButton, JSON.stringify(p));
  await fx.check("(7) the page does not scroll sideways", p.overflow <= 0, `${p.overflow}px`);
  await fx.settle(500);
  await fx.shot("visit-deleted");
});
