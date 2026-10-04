#!/usr/bin/env node
// "Could also be": the species a second listen to a heard recording hears more strongly than the detector's call, on the visit page and at the top of
// the "What was it?" picker, each with its "Play reference" button; choosing one corrects the visit.
//   taskset -c 0-4,8-12 nice -n 15 node dev/smoke/fixture-alternatives.mjs [--size 390x844] [--theme flat-light]
// Needs `node dev/build.mjs` first. Screenshots go to /tmp/kestrel-alternatives (OUT=... changes it). The visits come from dev/harness.ts (fx-alts-*).
//   (1) the visit page: the list with three species and their percentages, the play buttons, no sideways scroll
//   (2) a play button asks for that species' recording only when pressed (Northern Cardinal: a player; House Finch: "no recording")
//   (3) a recording where nothing is heard more strongly, and one the service never looked at: no list
//   (4) the picker: the same list under the search box; typing turns the species into ordinary rows
//   (5) choosing one corrects the visit as the picker always did, and the list then leaves out the species it became
process.env.OUT ??= "/tmp/kestrel-alternatives";
const { runSmoke } = await import("./lib/fixture.mjs");

const read = (deep, scope) => {
  const root = window.__panelRoot();
  const box = deep(root, `${scope ?? ""}kestrel-alternatives`).find((el) => window.__shown(el));
  const text = (node) => (node?.textContent ?? "").replace(/\s+/g, " ").trim();
  const title = text(deep(root, ".visit-title-row h2").find((el) => window.__shown(el)));
  if (!box) return { title, rows: null, pageOverflow: document.documentElement.scrollWidth - innerWidth };
  const items = [...box.shadowRoot.querySelectorAll("li")].map((li) => {
    const row = li.querySelector("kestrel-lu-row");
    const reference = li.querySelector("kestrel-reference-sound");
    return { name: row.heading, score: text(row.querySelector(".score")), reference: reference?.species, button: !!reference?.shadowRoot?.querySelector("kestrel-lu-button"), hint: !!reference?.shadowRoot?.querySelector(".hint"), player: !!reference?.shadowRoot?.querySelector("kestrel-lu-audio-player"), note: text(reference?.shadowRoot?.querySelector(".note")) };
  });
  return { title, rows: items, heading: text(box.shadowRoot.querySelector("h3")), inSheet: !!box.closest("kestrel-lu-sheet"), pageOverflow: document.documentElement.scrollWidth - innerWidth };
};

await runSmoke("fixture-alternatives", async (fx) => {
  const openVisit = async (id) => {
    await fx.open(`/kestrel/visit?v=${id}`);
    return fx.poll(async () => { const v = await fx.ev(read); return v && v.title ? v : null; }, { timeout: 12000 });
  };

  // ---- (1) the visit page ----------------------------------------------------------------------------------------------------------------
  let v = await openVisit("fx-alts-thrush");
  await fx.check("(1) the visit opens", v?.title === "Hermit Thrush", v?.title);
  await fx.check("(1) 'Could also be' lists the three species, strongest first, with whole percentages", JSON.stringify(v.rows?.map((r) => [r.name, r.score])) === JSON.stringify([["Northern Cardinal", "41%"], ["House Finch", "27%"], ["Spring Peeper", "16%"]]), JSON.stringify(v.rows?.map((r) => [r.name, r.score])));
  await fx.check("(1) every species has the existing Play reference button, without the extra hint line", !!v.rows?.every((r) => r.button && !r.hint && r.reference === r.name), JSON.stringify(v.rows?.map((r) => [r.button, r.hint])));
  await fx.check("(1) the heading is the plain 'Could also be', and the list sits inside the recording's panel", v.heading === "Could also be" && (await fx.page.locator(".heard-panel kestrel-alternatives").count()) === 1, v.heading);
  await fx.check("(1) the page does not scroll sideways", v.pageOverflow <= 0, `${v.pageOverflow}px`);
  await fx.page.locator("kestrel-alternatives").first().scrollIntoViewIfNeeded();
  await fx.settle(500);
  await fx.shot("visit");

  // ---- (2) nothing is asked until a button is pressed ---------------------------------------------------------------------------------------
  const asked = () => fx.media.log.filter((entry) => entry.path.startsWith("species_sound/")).length;
  const before = asked();
  await fx.page.locator("kestrel-alternatives li >> nth=0 >> kestrel-reference-sound >> kestrel-lu-button").first().click();
  v = await fx.poll(async () => { const now = await fx.ev(read); return now.rows?.[0]?.player ? now : null; }, { timeout: 8000 });
  await fx.check("(2) pressing Play reference on Northern Cardinal brings its player, and only its", !!v && v.rows[0].player && !v.rows[1].player && !v.rows[2].player, JSON.stringify(v?.rows?.map((r) => r.player)));
  await fx.page.locator("kestrel-alternatives li >> nth=1 >> kestrel-reference-sound >> kestrel-lu-button").first().click();
  v = await fx.poll(async () => { const now = await fx.ev(read); return now.rows?.[1]?.note ? now : null; }, { timeout: 8000 });
  await fx.check("(2) House Finch has no recording: it says so in words", !!v && /No reference recording found for House Finch/.test(v.rows[1].note), v?.rows?.[1]?.note);
  await fx.check("(2) the page still does not scroll sideways with a player open", v.pageOverflow <= 0, `${v.pageOverflow}px`);
  await fx.settle(500);
  await fx.shot("visit-playing");
  fx.info(`recordings asked for while pressing: ${asked() - before}`);

  // ---- (3) no list ---------------------------------------------------------------------------------------------------------------------
  v = await openVisit("fx-alts-agree");
  await fx.check("(3) a recording where nothing is heard more strongly has no list", v.rows === null, JSON.stringify(v.rows));
  v = await openVisit("fx-alts-old");
  await fx.check("(3) a recording the service never looked at has no list", v.rows === null, JSON.stringify(v.rows));

  // ---- (4) the picker --------------------------------------------------------------------------------------------------------------------
  v = await openVisit("fx-alts-thrush");
  await fx.page.locator(".visit-actions kestrel-lu-button[label='Wrong?']").first().click();
  const SHEET = "kestrel-lu-sheet[layer='wrong-picker'] ";
  v = await fx.poll(async () => { const now = await fx.ev(read, SHEET); return now.rows ? now : null; }, { timeout: 8000 });
  await fx.check("(4) the picker shows the same three species at the top, in the sheet", !!v && v.rows.length === 3 && v.inSheet && v.rows[0].name === "Northern Cardinal", JSON.stringify(v?.rows?.map((r) => r.name)));
  const pickerRows = await fx.ev((deep) => deep(window.__panelRoot(), "kestrel-lu-sheet[layer='wrong-picker'] > kestrel-lu-row").map((el) => el.heading));
  await fx.check("(4) they are not repeated as ordinary rows below", !pickerRows.some((name) => ["Northern Cardinal", "House Finch", "Spring Peeper"].includes(name)), JSON.stringify(pickerRows.slice(0, 6)));
  await fx.settle(500);
  await fx.shot("picker");
  await fx.page.locator("kestrel-lu-sheet[layer='wrong-picker'] input.species-search").fill("finch");
  await fx.settle(300);
  const typed = await fx.ev((deep) => ({ list: deep(window.__panelRoot(), "kestrel-lu-sheet[layer='wrong-picker'] kestrel-alternatives").some((el) => window.__shown(el)), rows: deep(window.__panelRoot(), "kestrel-lu-sheet[layer='wrong-picker'] > kestrel-lu-row").map((el) => [el.heading, el.detail]) }));
  await fx.check("(4) typing hides the block and the species is an ordinary row you can find", !typed.list && typed.rows.some(([name, detail]) => name === "House Finch" && detail === "27% sure"), JSON.stringify(typed));
  await fx.page.locator("kestrel-lu-sheet[layer='wrong-picker'] input.species-search").fill("");
  await fx.settle(300);

  // ---- (5) choosing one ----------------------------------------------------------------------------------------------------------------------
  await fx.page.locator("kestrel-lu-sheet[layer='wrong-picker'] kestrel-alternatives li >> nth=1 >> kestrel-lu-row").first().click();
  v = await fx.poll(async () => { const now = await fx.ev(read); return now.title === "House Finch" && now.rows ? now : null; }, { timeout: 8000 });
  await fx.check("(5) the visit became House Finch", !!v, v?.title);
  await fx.check("(5) the list now offers the other two, not the species the visit became", JSON.stringify(v?.rows?.map((r) => r.name)) === JSON.stringify(["Northern Cardinal", "Spring Peeper"]), JSON.stringify(v?.rows?.map((r) => r.name)));
  await fx.shot("corrected");
});
