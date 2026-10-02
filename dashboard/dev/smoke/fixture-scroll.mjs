#!/usr/bin/env node
// Scroll memory on the fixture page (the page itself scrolls, as in Home Assistant).
//   taskset -c 0-4,8-12 nice -n 15 node dev/smoke/fixture-scroll.mjs [--size 390x844] [--theme flat-light]
// Needs `node dev/build.mjs` first. Tolerance is 3 px everywhere.
//   (1) every tab remembers its own offset; a tab never visited starts at the top;
//   (2) Wildlife scrolled deep (after "Show more species"): species sheet -> visit -> Back -> Back lands on the same offset;
//   (3) a visit page opened again with another id starts at the top, whatever the previous one was scrolled to.
import { runSmoke } from "./lib/fixture.mjs";

const TOL = 3;
const near = (a, b) => Math.abs(a - b) <= TOL;
const scrollY = (fx) => fx.page.evaluate(() => Math.round(window.scrollY));
const maxScroll = (fx) => fx.page.evaluate(() => Math.round(document.documentElement.scrollHeight - innerHeight));
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

async function scrollTo(fx, y) {
  await fx.page.evaluate((top) => window.scrollTo(0, top), y);
  await fx.settle(450);
  return scrollY(fx);
}

/** The offset after `ms`, once it stopped moving (a restore that is still settling is not "back yet"). */
async function steadyY(fx, ms = 900) {
  await fx.settle(ms);
  let last = await scrollY(fx);
  for (let i = 0; i < 6; i += 1) {
    await fx.settle(150);
    const now = await scrollY(fx);
    if (now === last) return now;
    last = now;
  }
  return last;
}

async function openSpeciesInViewport(fx) {
  const label = await fx.ev((deep) => {
    const tiles = deep(window.__panelRoot(), "button.species-tile").filter((el) => window.__shown(el));
    const middle = tiles.find((el) => { const r = el.getBoundingClientRect(); const center = r.top + r.height / 2; return center > innerHeight * 0.35 && center < innerHeight * 0.7; }) ?? tiles.find((el) => window.__inViewport(el));
    if (!middle) return null;
    middle.setAttribute("data-smoke-pick", "1");
    return middle.getAttribute("aria-label");
  });
  if (!label) return null;
  await fx.page.locator("[data-smoke-pick]").first().click({ timeout: 8000 });
  const open = await fx.poll(() => fx.panel.speciesOpen(), { timeout: 6000 });
  await fx.ev((deep) => deep(window.__panelRoot(), "[data-smoke-pick]").forEach((el) => el.removeAttribute("data-smoke-pick")));
  return open ? label : null;
}

async function openVisitRow(fx, index) {
  const rows = fx.page.locator("kestrel-species-sheet kestrel-lu-audio-list button.open:visible, kestrel-species-sheet kestrel-lu-media-rail button.item:visible");
  await fx.poll(async () => (await rows.count()) > index, { timeout: 8000 });
  await rows.nth(index).click({ timeout: 8000 });
  return fx.poll(async () => (await fx.nav()).path === "/kestrel/visit" && (await fx.panel.view()) === "visit", { timeout: 6000 });
}

/** The visit page may scroll inside itself instead of the document (short screens: a side pane). Scrolls such a box to its end (or reads it). */
const innerScrollers = (fx, toEnd) => fx.ev((deep, end) => {
  const view = window.__panelRoot().querySelector('[data-view="visit"]');
  const boxes = [view, ...deep(view, "*")].filter((el) => el && el.scrollHeight > el.clientHeight + 4 && ["auto", "scroll"].includes(getComputedStyle(el).overflowY));
  if (end) for (const box of boxes) box.scrollTop = box.scrollHeight;
  return boxes.map((box) => Math.round(box.scrollTop));
}, toEnd);

const visitId = async (fx) => new URLSearchParams((await fx.nav()).search).get("v");

await runSmoke("fixture-scroll", async (fx) => {
  // (1) tabs remember their own offset
  await fx.open("/kestrel/live");
  await fx.poll(() => fx.panel.count("article.camera-tile"), { timeout: 15000 });
  await fx.settle(1200); // pictures arrive and may change the height
  const maxLive = await maxScroll(fx);
  const yLive = maxLive >= 120 ? await scrollTo(fx, clamp(Math.round(maxLive * 0.45), 60, 500)) : 0;
  fx.info(`Live scrolls ${maxLive} px at this size; parked at ${yLive}`);
  await fx.tab("wildlife");
  await fx.poll(async () => (await fx.panel.count("button.species-tile")) > 0, { timeout: 15000 });
  await fx.settle(800);
  const wildlifeStart = await steadyY(fx, 300);
  await fx.check("(1) Wildlife, never visited, starts at the top", wildlifeStart <= TOL, `y=${wildlifeStart}`);
  const maxWild = await maxScroll(fx);
  let yWild = await scrollTo(fx, clamp(Math.round(maxWild * 0.5), 100, 900));
  if (near(yWild, yLive)) yWild = await scrollTo(fx, yWild + 160);
  fx.info(`Wildlife scrolls ${maxWild} px; parked at ${yWild}`);
  if (yLive === 0) fx.skip("(1) Live keeps its offset across tabs", `Live does not scroll at ${fx.width}x${fx.height}`);
  for (let round = 1; round <= 2; round += 1) {
    await fx.tab("live");
    const l = await steadyY(fx);
    if (yLive > 0) await fx.check(`(1) round ${round}: back on Live, same offset`, near(l, yLive), `expected ${yLive}, got ${l}`);
    await fx.tab("wildlife");
    const w = await steadyY(fx);
    await fx.check(`(1) round ${round}: back on Wildlife, same offset`, near(w, yWild), `expected ${yWild}, got ${w}`);
  }
  await fx.tab("insights");
  await fx.poll(() => fx.panel.view().then((v) => v === "insights"), { timeout: 5000 });
  const insightsStart = await steadyY(fx, 300);
  await fx.check("(1) Insights, never visited, starts at the top", insightsStart <= TOL, `y=${insightsStart}`);

  // (2) Wildlife deep, out to a visit and back
  await fx.tab("wildlife");
  await steadyY(fx, 300);
  const more = fx.page.getByRole("button", { name: /show more/i }).first();
  await more.scrollIntoViewIfNeeded({ timeout: 8000 });
  await more.click({ timeout: 8000 });
  const grew = await fx.poll(async () => (await fx.panel.count("button.species-tile")) > 24, { timeout: 8000 });
  await fx.check("(2) 'Show more species' shows more than 24 tiles", !!grew, `${await fx.panel.count("button.species-tile")} tiles`);
  await fx.settle(800);
  const maxDeep = await maxScroll(fx);
  const yDeep = await scrollTo(fx, Math.round(maxDeep * 0.7));
  fx.info(`Wildlife after Show more scrolls ${maxDeep} px; parked at ${yDeep}`);
  const picked = await openSpeciesInViewport(fx);
  await fx.check("(2) a species tile in view opens its sheet", !!picked, String(picked));
  const visitUp = await openVisitRow(fx, 0);
  const idA = await visitId(fx);
  await fx.check("(2) the sheet's first recording opens a visit", !!visitUp && !!idA, `v=${idA}`);
  const topA = await steadyY(fx, 700);
  await fx.check("(3) that first visit starts at the top", topA <= TOL, `y=${topA}`);
  await fx.back();
  const sheetBack = await fx.poll(() => fx.panel.speciesOpen(), { timeout: 5000 });
  await fx.check("(2) Back from the visit shows the species sheet again", !!sheetBack);
  await fx.back();
  const sheetShut = await fx.poll(async () => !(await fx.panel.speciesOpen()), { timeout: 5000 });
  const yAfter = await steadyY(fx, 900);
  await fx.check("(2) Back, Back: Wildlife is at the same offset", !!sheetShut && near(yAfter, yDeep), `expected ${yDeep}, got ${yAfter}`);

  // (3) another visit under the same view id, after the first one was scrolled. A visit fits on most screens, so this part runs on a small window (390 x 360)
  // to make the page really scroll.
  await fx.page.setViewportSize({ width: Math.min(fx.width, 390), height: 360 });
  await fx.settle(600);
  const again = await openSpeciesInViewport(fx);
  const visitUp2 = again ? await openVisitRow(fx, 0) : false;
  const idA2 = await visitId(fx);
  await fx.settle(600);
  const maxVisit = await maxScroll(fx);
  const yVisit = maxVisit > 40 ? await scrollTo(fx, maxVisit) : 0;
  const innerParked = await innerScrollers(fx, true);
  await fx.settle(300);
  fx.info(`visit page scrolls ${maxVisit} px in the document, ${innerParked.length} inner scroll box(es) parked at ${innerParked.join(",") || "-"}`);
  await fx.back();
  await fx.poll(() => fx.panel.speciesOpen(), { timeout: 5000 });
  const visitUp3 = await openVisitRow(fx, 1);
  const idB = await visitId(fx);
  const topB = await steadyY(fx, 700);
  await fx.check("(3) a visit with another id opens", !!visitUp2 && !!visitUp3 && !!idB && idB !== idA2, `${idA2} then ${idB}`);
  const innerB = await innerScrollers(fx, false);
  const scrolledBefore = yVisit > 0 || innerParked.some((top) => top > 0);
  await fx.check("(3) it starts at the top even though the last one was scrolled", topB <= TOL && innerB.every((top) => top <= TOL), `y=${topB}, inner [${innerB.join(",")}]${scrolledBefore ? `, previous was at y=${yVisit}, inner [${innerParked.join(",")}]` : " (visit page is not scrollable at this size: trivially true)"}`);
  // the same through Home Assistant's own navigation (a notification, a link): a third id, after scrolling this one
  const maxB = await maxScroll(fx);
  if (maxB > 40) await scrollTo(fx, maxB);
  await fx.page.evaluate(() => { history.pushState(null, "", "/kestrel/visit?v=fx-seen-eastern-gray-squirrel-0"); window.dispatchEvent(new CustomEvent("location-changed", { detail: { replace: false } })); });
  await fx.poll(async () => (await visitId(fx)) === "fx-seen-eastern-gray-squirrel-0", { timeout: 4000 });
  const topC = await steadyY(fx, 900);
  await fx.check("(3) a visit reached by a plain address change starts at the top", topC <= TOL, `y=${topC}`);
  await fx.page.setViewportSize({ width: fx.width, height: fx.height });
});
