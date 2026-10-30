#!/usr/bin/env node
// "Keep recording": a heard recording that BirdNET-Go's 30-day clean-up must leave alone, on the visit page.
//   taskset -c 0-4,8-12 nice -n 15 node dev/smoke/fixture-keep.mjs [--size 390x844] [--theme flat-light]
// Needs `node dev/build.mjs` first. Screenshots go to /tmp/kestrel-keep (OUT=... changes it). The fixture server answers
// `kestrel/recording/keep/get` and `/set` (dev/harness.ts); `admin=0`, `keep=none` and `keep=fail` are its settings.
//   (1) a heard visit: the control and its plain caption, not pressed; pressing keeps it (the command carries the visit and `keep: true`), pressing again lets go
//   (2) a sighting with a call linked: the control is for the linked heard visit
//   (3) somebody who is not an administrator sees the state, disabled, with the reason
//   (4) a recording BirdNET-Go has nothing to lock for draws nothing
//   (5) a change BirdNET-Go refuses is put back, and says so
process.env.OUT ??= "/tmp/kestrel-keep";
const { runSmoke } = await import("./lib/fixture.mjs");

const CAPTION = "Kept recordings are not deleted after 30 days";

/** What the nth `<kestrel-keep-recording>` shows, read in the page. */
const read = (deep, index) => {
  const el = deep(document, "kestrel-keep-recording")[index];
  if (!el) return null;
  const root = el.shadowRoot;
  const text = (node) => (node?.textContent ?? "").replace(/\s+/g, " ").trim();
  const chip = root.querySelector("kestrel-lu-chip");
  const button = chip?.shadowRoot?.querySelector("button") ?? null;
  const box = el.getBoundingClientRect();
  const caption = root.querySelector(".caption");
  const outside = [...root.querySelectorAll("kestrel-lu-chip, .caption")].filter((node) => { const r = node.getBoundingClientRect(); return r.left < box.left - 1 || r.right > box.right + 1; }).length;
  return {
    visitId: el.visitId,
    phase: el._phase,
    chip: button ? { pressed: button.getAttribute("aria-pressed"), disabled: button.disabled, icon: chip.icon, label: chip.label, height: Math.round(button.getBoundingClientRect().height) } : null,
    caption: text(caption),
    failed: caption?.classList.contains("failed") ?? false,
    live: text(root.querySelector('[role="status"]')),
    outside,
    pageOverflow: document.documentElement.scrollWidth - innerWidth,
  };
};

await runSmoke("fixture-keep", async (fx) => {
  const block = (index = 0) => fx.ev(read, index);
  const waitBlock = (test, index = 0) => fx.poll(async () => { const b = await block(index); return b && test(b) ? b : null; }, { timeout: 8000, every: 50 });
  const calls = () => fx.page.evaluate(() => window.__ha.calls.filter((call) => call.type.startsWith("kestrel/recording/keep/")).map((call) => ({ type: call.type, visit_id: call.message.visit_id, keep: call.message.keep })));
  const press = (index = 0) => fx.page.locator("kestrel-keep-recording").nth(index).locator("button").first().click({ timeout: 8000 });

  // (1) a heard visit
  await fx.open("/kestrel/visit?v=fixture-heard-1");
  let b = await waitBlock((x) => x.phase === "ready");
  await fx.check("a heard visit shows the control", b !== null, b ? `visit ${b.visitId}` : "none");
  await fx.check("it names itself and is not pressed", b?.chip?.label === "Keep recording" && b.chip.pressed === "false" && !b.chip.disabled, JSON.stringify(b?.chip));
  await fx.check("it says what keeping does, in plain words", b?.caption === CAPTION, b?.caption);
  await fx.check("the button is a full touch target, nothing runs outside its block, the page does not scroll sideways", b !== null && b.chip.height >= 44 && b.outside === 0 && b.pageOverflow <= 0, `height ${b?.chip?.height}, outside ${b?.outside}, overflow ${b?.pageOverflow}`);
  await fx.page.locator("kestrel-keep-recording").first().scrollIntoViewIfNeeded();
  await fx.settle(350);
  await fx.shot("not-kept");
  await press();
  b = await waitBlock((x) => x.chip?.pressed === "true" && !x.chip.disabled);
  await fx.check("pressing keeps it: the button shows pressed with the pin", b?.chip?.pressed === "true", JSON.stringify(b?.chip));
  await fx.check("the keep command carries the visit and keep=true", JSON.stringify((await calls()).at(-1)) === JSON.stringify({ type: "kestrel/recording/keep/set", visit_id: "fixture-heard-1", keep: true }), JSON.stringify((await calls()).at(-1)));
  await fx.check("a polite message says it is kept", b?.live === "Recording kept.", b?.live);
  await fx.shot("kept");
  await press();
  b = await waitBlock((x) => x.chip?.pressed === "false" && !x.chip.disabled);
  await fx.check("pressing again lets it go", b?.chip?.pressed === "false" && b.live === "Recording is no longer kept.", JSON.stringify(b));

  // (2) a sighting with a call linked: its control is for the heard visit that owns the recording
  await fx.open("/kestrel/visit?v=fixture-visit-1");
  b = await waitBlock((x) => x.phase === "ready");
  await fx.check("a sighting with a linked call asks about the heard visit", b?.visitId === "fixture-heard-1", b?.visitId);
  await fx.shot("sighting-with-call");

  // (3) not an administrator
  await fx.open("/kestrel/visit?v=fixture-heard-1&admin=0&keep=");
  b = await waitBlock((x) => x.phase === "ready");
  await fx.check("a non-administrator sees the control disabled", b?.chip?.disabled === true, JSON.stringify(b?.chip));
  await fx.check("and is told who can change it", /Only an administrator can keep one/.test(b?.caption ?? ""), b?.caption);
  await fx.shot("not-admin");

  // (4) nothing to keep
  await fx.open("/kestrel/visit?v=fixture-heard-1&admin=1&keep=none");
  await fx.poll(async () => (await block())?.phase === "none", { timeout: 8000 });
  b = await block();
  await fx.check("a recording with nothing to lock draws nothing", b?.phase === "none" && b.chip === null, JSON.stringify(b));

  // (5) a refused change is put back
  await fx.open("/kestrel/visit?v=fixture-heard-1&keep=fail");
  b = await waitBlock((x) => x.phase === "ready");
  await press();
  b = await waitBlock((x) => x.failed);
  await fx.check("a change BirdNET-Go refuses is put back", b?.chip?.pressed === "false" && !b.chip.disabled, JSON.stringify(b?.chip));
  await fx.check("and the line says so", b?.caption === "Couldn't change this recording. Try again." && b.live === "Couldn't change this recording.", `${b?.caption} / ${b?.live}`);
  await fx.shot("failed");
  await fx.open("/kestrel/visit?v=fixture-heard-1&keep=");
});
