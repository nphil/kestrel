#!/usr/bin/env node
// Back / Escape ordering on the fixture page: what the toolkit promises (docs/api/ha.md) against the real panel.
//   taskset -c 0-4,8-12 nice -n 15 node dev/smoke/fixture-back.mjs [--size 390x844] [--theme flat-light]
// Needs `node dev/build.mjs` first. History is counted with the Navigation API's entry index (history.length keeps forward entries).
//   (i)   Wildlife -> species tile: ?s= is the one new entry; Back closes ONLY the sheet.
//   (ii)  species sheet -> recording row -> visit -> "Wrong?" picker: picker = +1 entry, Back / Escape close only it; Back walks visit -> sheet -> list -> out.
//   (iii) tabs replace the entry, leaving Live adds ONE marker entry; Back -> Live, Back leaves.
//   (iv)  help sheet (opened by the keyboard button in the top bar, hidden on touch) closes with Back and with Escape.
import { runSmoke } from "./lib/fixture.mjs";

const SPECIES = "Northern Cardinal";
const tile = (fx, name = null) => fx.page.locator(name ? `button.species-tile[aria-label^="${name}."]` : "button.species-tile").first();
const sheetUrl = (n) => n.path === "/kestrel/wildlife" && new URLSearchParams(n.search).get("s") === SPECIES;

async function openTile(fx, name) {
  await tile(fx, name).click({ timeout: 10000 });
  return fx.poll(() => fx.panel.speciesOpen(), { timeout: 6000 });
}

/** Taps the first recording row (or clip) of the open species sheet; resolves once the visit page is up. */
async function openVisitFromSheet(fx) {
  const row = fx.page.locator("kestrel-species-sheet kestrel-lu-audio-list button.open:visible, kestrel-species-sheet kestrel-lu-media-rail button.item:visible").first();
  await row.click({ timeout: 10000 });
  return fx.poll(async () => (await fx.nav()).path === "/kestrel/visit" && (await fx.panel.view()) === "visit", { timeout: 6000 });
}

await runSmoke("fixture-back", async (fx) => {
  // (i) species sheet
  await fx.open("/kestrel/live");
  await fx.poll(() => fx.panel.count("article.camera-tile"), { timeout: 15000 });
  await fx.tab("wildlife");
  const wildlifeUp = await fx.poll(async () => (await fx.panel.count("button.species-tile")) > 0, { timeout: 15000 });
  await fx.check("(i) Wildlife tab shows species tiles", !!wildlifeUp);
  const before = await fx.nav();
  const opened = await openTile(fx, SPECIES);
  const open = await fx.nav();
  await fx.check("(i) species tile opens the sheet", !!opened, `${open.path}${open.search}`);
  await fx.check("(i) address has ?s= and that is exactly one new entry", open.search.includes("s=") && open.index === before.index + 1, `index ${before.index} -> ${open.index}`);
  await fx.back();
  const closed = await fx.nav();
  const sheetGone = await fx.poll(async () => !(await fx.panel.speciesOpen()), { timeout: 4000 });
  await fx.check("(i) Back closes the sheet", !!sheetGone);
  await fx.check("(i) Back left the page where it was (no extra entry)", closed.path === "/kestrel/wildlife" && closed.search === "" && closed.index === before.index, `index ${closed.index}, ${closed.path}${closed.search}`);
  await fx.check("(i) species list still there", (await fx.panel.count("button.species-tile")) > 0 && (await fx.panel.view()) === "wildlife");

  // (ii) sheet -> visit -> picker. A deep link to Wildlife: nothing of the panel below it.
  await fx.open("/kestrel/wildlife");
  await fx.poll(async () => (await fx.panel.count("button.species-tile")) > 0, { timeout: 15000 });
  const base = await fx.nav();
  await fx.check("(ii) opened on the Wildlife deep link", base.path === "/kestrel/wildlife", `index ${base.index}`);
  await openTile(fx, SPECIES);
  const sheetEntry = await fx.nav();
  const onVisit = await openVisitFromSheet(fx);
  const visit = await fx.nav();
  await fx.check("(ii) a recording row opens the visit page as a new entry", !!onVisit && visit.index === sheetEntry.index + 1 && visit.search.includes("v="), `index ${sheetEntry.index} -> ${visit.index}, ${visit.path}${visit.search}`);
  await fx.settle(500);
  const wrong = fx.page.getByRole("button", { name: /wrong/i }).first();
  await wrong.click({ timeout: 10000 });
  const pickerOpen = await fx.poll(() => fx.panel.layerOpen("wrong-picker"), { timeout: 5000 });
  const picker = await fx.nav();
  await fx.check("(ii) 'Wrong?' opens the picker sheet as one new entry", !!pickerOpen && picker.index === visit.index + 1 && picker.search === visit.search, `index ${visit.index} -> ${picker.index}`);
  await fx.back();
  const afterBack = await fx.nav();
  const pickerGone = await fx.poll(async () => !(await fx.panel.layerOpen("wrong-picker")), { timeout: 4000 });
  await fx.check("(ii) Back closes only the picker (still on the visit)", !!pickerGone && afterBack.index === visit.index && afterBack.path === "/kestrel/visit" && afterBack.search === visit.search && (await fx.panel.view()) === "visit", `index ${afterBack.index}, ${afterBack.path}`);
  await wrong.click({ timeout: 10000 });
  await fx.poll(() => fx.panel.layerOpen("wrong-picker"), { timeout: 5000 });
  await fx.key("Escape");
  const afterEscape = await fx.nav();
  const escGone = await fx.poll(async () => !(await fx.panel.layerOpen("wrong-picker")), { timeout: 4000 });
  await fx.check("(ii) Escape closes the picker and leaves no extra entry", !!escGone && afterEscape.index === visit.index && afterEscape.path === "/kestrel/visit", `index ${afterEscape.index}, ${afterEscape.path}${afterEscape.search}`);
  await fx.back();
  const toSheet = await fx.nav();
  const sheetBack = await fx.poll(() => fx.panel.speciesOpen(), { timeout: 5000 });
  await fx.check("(ii) Back from the visit returns to the species sheet, open", !!sheetBack && sheetUrl(toSheet) && toSheet.index === sheetEntry.index, `index ${toSheet.index}, ${toSheet.path}${toSheet.search}`);
  await fx.back();
  const toList = await fx.nav();
  const sheetShut = await fx.poll(async () => !(await fx.panel.speciesOpen()), { timeout: 4000 });
  await fx.check("(ii) Back again closes the sheet", !!sheetShut && toList.path === "/kestrel/wildlife" && toList.search === "" && toList.index === base.index, `index ${toList.index}, ${toList.path}${toList.search}`);
  await fx.back();
  const left = await fx.poll(() => fx.left(), { timeout: 5000 });
  await fx.check("(ii) Back again leaves the panel", !!left, fx.page.url());

  // (iii) tabs
  await fx.open("/kestrel/live");
  await fx.poll(() => fx.panel.count("article.camera-tile"), { timeout: 15000 });
  const live = await fx.nav();
  await fx.tab("wildlife");
  const wild = await fx.nav();
  await fx.tab("insights");
  const insights = await fx.nav();
  await fx.check("(iii) Live -> Wildlife adds exactly the one marker entry", wild.path === "/kestrel/wildlife" && wild.index === live.index + 1, `index ${live.index} -> ${wild.index}`);
  await fx.check("(iii) Wildlife -> Insights replaces the entry", insights.path === "/kestrel/insights" && insights.index === wild.index && (await fx.panel.view()) === "insights", `index ${wild.index} -> ${insights.index}`);
  await fx.back();
  const homeAgain = await fx.nav();
  await fx.check("(iii) Back from Insights returns to Live", homeAgain.path === "/kestrel/live" && homeAgain.index === live.index && (await fx.panel.view()) === "live" && /live/.test((await fx.panel.navCurrent()) ?? ""), `index ${homeAgain.index}, nav ${await fx.panel.navCurrent()}`);
  await fx.back();
  await fx.check("(iii) the next Back leaves the panel", !!(await fx.poll(() => fx.left(), { timeout: 5000 })), fx.page.url());

  await fx.open("/kestrel/live");
  await fx.poll(() => fx.panel.count("article.camera-tile"), { timeout: 15000 });
  const liveB = await fx.nav();
  await fx.tab("wildlife");
  await fx.tab("live");
  const popped = await fx.nav();
  await fx.check("(iii) choosing Live again takes the marker entry away", popped.path === "/kestrel/live" && popped.index === liveB.index && (await fx.panel.view()) === "live", `index ${liveB.index} -> ${popped.index}`);

  // (iv) help sheet: the top bar's keyboard button (Home Assistant answers "?" itself, so the panel has no key for it)
  const finePointer = await fx.page.evaluate(() => matchMedia("(pointer: fine)").matches);
  if (!finePointer) fx.skip("(iv) help sheet closes with Back", "the keyboard button is hidden on touch; this size is touch");
  else {
    await fx.open("/kestrel/live");
    await fx.poll(() => fx.panel.count("article.camera-tile"), { timeout: 15000 });
    const pre = await fx.nav();
    await fx.page.locator("kestrel-lu-button.shortcuts:visible").first().click({ timeout: 8000 });
    const helpOpen = await fx.poll(() => fx.panel.layerOpen("help"), { timeout: 4000 });
    const help = await fx.nav();
    await fx.check("(iv) the keyboard button opens the help sheet as one new entry", !!helpOpen && help.index === pre.index + 1 && help.path === pre.path, `index ${pre.index} -> ${help.index}`);
    await fx.back();
    const helpShut = await fx.poll(async () => !(await fx.panel.layerOpen("help")), { timeout: 4000 });
    const post = await fx.nav();
    await fx.check("(iv) Back closes the help sheet only", !!helpShut && post.index === pre.index && post.path === "/kestrel/live", `index ${post.index}, ${post.path}`);
    await fx.page.locator("kestrel-lu-button.shortcuts:visible").first().click({ timeout: 8000 });
    await fx.poll(() => fx.panel.layerOpen("help"), { timeout: 4000 });
    await fx.key("Escape");
    const escShut = await fx.poll(async () => !(await fx.panel.layerOpen("help")), { timeout: 4000 });
    const postEsc = await fx.nav();
    await fx.check("(iv) Escape closes the help sheet and leaves no extra entry", !!escShut && postEsc.index === pre.index && postEsc.path === "/kestrel/live", `index ${postEsc.index}, ${postEsc.path}`);
  }
});
