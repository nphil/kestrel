#!/usr/bin/env node
// "How sure, really": the tier of a heard visit (Likely / Possible / Check this one), the sentence that says why, and the classifier's
// confidence on a camera visit.
//   taskset -c 0-4,8-12 nice -n 15 node dev/smoke/fixture-tier.mjs [--size 390x844] [--theme flat-light]
// Needs `node dev/build.mjs` first. Screenshots go to /tmp/kestrel-tier (OUT=... changes it). The visits come from dev/harness.ts (fx-tier-*, fx-seen-labelscore).
//   (1) the visit page of the Check visit: the "Check this one" chip, the models-disagree sentence under the title, 62% sure
//   (2) Likely: a chip and no sentence; Possible: a chip and its sentence
//   (3) a camera visit: 99% (the classifier), not the box's 84%, and no tier chip
//   (4) the review list: the row of the Check visit carries the sentence
//   (5) the species sheet: the Possible recording is marked, the Likely one is not
// Every step also checks that the page does not scroll sideways.
process.env.OUT ??= "/tmp/kestrel-tier";
const { runSmoke } = await import("./lib/fixture.mjs");

const SAME = "The two models disagree: v3.0 says Blue Jay, Perch says American Crow.";

/** What the visit page says about the evidence: the chips, the sentence under the title and the big number. */
const readVisit = (deep) => {
  const root = window.__panelRoot();
  const summary = deep(root, ".visit-summary").find((el) => window.__shown(el));
  if (!summary) return null;
  const text = (node) => (node?.textContent ?? "").replace(/\s+/g, " ").trim();
  const chips = [...summary.querySelectorAll(".visit-tags kestrel-lu-chip")].map((chip) => ({ label: chip.label ?? chip.getAttribute("label"), kind: chip.kind ?? chip.getAttribute("kind") }));
  const score = summary.querySelector(".score");
  return { title: text(summary.querySelector("h2")), why: text(summary.querySelector(".tier-why")), chips, score: score ? text(score) : "", aria: score?.getAttribute("aria-label") ?? "", pageOverflow: document.documentElement.scrollWidth - innerWidth };
};

await runSmoke("fixture-tier", async (fx) => {
  const openVisit = async (id) => {
    await fx.open(`/kestrel/visit?v=${id}`);
    return fx.poll(async () => { const v = await fx.ev(readVisit); return v && v.chips.length ? v : null; }, { timeout: 12000 });
  };
  const tierChip = (v) => v.chips.find((chip) => ["Likely", "Possible", "Check this one"].includes(chip.label));

  // ---- (1) the Check visit -------------------------------------------------------------------------------------------------------------
  let v = await openVisit("fx-tier-check");
  await fx.check("(1) the Check visit opens", !!v && v.title === "Blue Jay", v?.title);
  await fx.check("(1) its chip reads 'Check this one' and is a warning", tierChip(v)?.label === "Check this one" && tierChip(v).kind === "warning", JSON.stringify(tierChip(v)));
  await fx.check("(1) the sentence under the title names both models and both birds", v.why === SAME, v.why);
  await fx.check("(1) the big number is the call's own 62%", v.score === "62%" && v.aria === "62 percent sure", `${v.score} / ${v.aria}`);
  await fx.check("(1) the page does not scroll sideways", v.pageOverflow <= 0, `${v.pageOverflow}px`);
  await fx.check("(1) no jargon on the page", !/tier|model score|occurrence|undefined|NaN/i.test((await fx.page.evaluate(() => window.__panelRoot().querySelector(".visit-summary")?.textContent ?? "")).replace(/models disagree/i, "")), "none of: tier, model score, occurrence, undefined, NaN");
  await fx.settle(400);
  await fx.shot("visit-check");

  // ---- (2) Likely and Possible ---------------------------------------------------------------------------------------------------------
  v = await openVisit("fx-tier-likely");
  await fx.check("(2) Likely: a positive chip and no sentence", tierChip(v)?.label === "Likely" && tierChip(v).kind === "positive" && v.why === "", `${JSON.stringify(tierChip(v))} / "${v.why}"`);
  await fx.check("(2) Likely: 94% sure, no sideways scroll", v.score === "94%" && v.pageOverflow <= 0, `${v.score}; ${v.pageOverflow}px`);
  await fx.shot("visit-likely");
  v = await openVisit("fx-tier-possible");
  await fx.check("(2) Possible: a neutral chip and 'A faint call, heard once.'", tierChip(v)?.label === "Possible" && tierChip(v).kind === "neutral" && v.why === "A faint call, heard once.", `${JSON.stringify(tierChip(v))} / "${v.why}"`);
  await fx.shot("visit-possible");

  // ---- (3) a camera visit ---------------------------------------------------------------------------------------------------------------
  v = await openVisit("fx-seen-labelscore");
  await fx.check("(3) camera visit: 99% sure (the classifier), not the box's 84%", v.score === "99%" && v.aria === "99 percent sure", `${v.score} / ${v.aria}`);
  await fx.check("(3) camera visit: no tier chip and no sentence", !tierChip(v) && v.why === "", `${JSON.stringify(v.chips)} / "${v.why}"`);
  await fx.shot("visit-seen");
  v = await openVisit("fixture-visit-1");
  await fx.check("(3) an older camera visit without the new fields still shows its own 91%", v.score === "91%" && !tierChip(v), `${v.score}`);

  // ---- (4) the review list ---------------------------------------------------------------------------------------------------------------
  await fx.open("/kestrel/insights");
  const rows = await fx.poll(async () => {
    const found = await fx.ev((deep) => deep(window.__panelRoot(), ".review-section kestrel-lu-row").filter((el) => window.__shown(el)).map((el) => ({ heading: el.heading, detail: el.detail, why: el.nextElementSibling?.classList.contains("review-why") ? el.nextElementSibling.textContent.trim() : "", whyLeft: el.nextElementSibling?.classList.contains("review-why") ? Math.round(el.nextElementSibling.getBoundingClientRect().left) : null, whyShown: el.nextElementSibling?.classList.contains("review-why") ? window.__shown(el.nextElementSibling) : null })));
    return found.length ? found : null;
  }, { timeout: 12000 });
  const checkRow = rows?.find((row) => row.why === SAME);
  await fx.check("(4) the Check visit's row has camera and time, and the sentence in full under it", !!checkRow && /^Back Door · [^·]+$/.test(checkRow.detail) && checkRow.whyShown === true, JSON.stringify(checkRow ?? rows));
  await fx.check("(4) the second-opinion row says who heard it, in two sentences", !!rows?.some((row) => row.why === "Only Perch heard this one; v3.0 did not. A bird not heard here before."), JSON.stringify(rows?.map((row) => row.why)));
  await fx.check("(4) the old row (no tier) has just camera and time and no sentence", !!rows?.some((row) => /^Backyard · [^·]+$/.test(row.detail) && row.why === ""), JSON.stringify(rows?.map((row) => row.detail)));
  await fx.page.evaluate(() => window.__deep(window.__panelRoot(), ".review-section")[0]?.scrollIntoView({ block: "center" }));
  await fx.settle(400);
  await fx.check("(4) the page does not scroll sideways", (await fx.page.evaluate(() => document.documentElement.scrollWidth - innerWidth)) <= 0);
  await fx.shot("review");

  // ---- (5) the species sheet -------------------------------------------------------------------------------------------------------------
  await fx.open("/kestrel/wildlife?s=Blue%20Jay");
  await fx.check("(5) Blue Jay's sheet opens", await fx.poll(() => fx.panel.speciesOpen(), { timeout: 12000 }));
  await fx.settle(800);
  const listRows = await fx.poll(async () => {
    const found = await fx.ev((deep) => {
      const sheet = deep(window.__panelRoot(), "kestrel-species-sheet")[0]?.shadowRoot;
      const list = sheet?.querySelector("kestrel-lu-audio-list");
      return list ? [...list.shadowRoot.querySelectorAll(".row, li")].map((el) => ({ text: (el.textContent ?? "").replace(/\s+/g, " ").trim(), mark: (el.querySelector(".mark")?.textContent ?? "").trim() })) : [];
    });
    return found.length ? found : null;
  }, { timeout: 12000 });
  const marks = (listRows ?? []).map((row) => row.mark).filter(Boolean);
  await fx.check("(5) the Possible recording carries a 'Possible' mark", marks.some((mark) => mark.startsWith("Possible")), JSON.stringify(marks));
  await fx.check("(5) the Check recording carries a 'Check this one' mark", marks.some((mark) => mark.startsWith("Check this one")), JSON.stringify(marks));
  await fx.check("(5) the Likely recording has no tier mark", !marks.some((mark) => mark.startsWith("Likely")), JSON.stringify(marks));
  await fx.check("(5) the 62% of the Check recording is shown", (listRows ?? []).some((row) => row.text.includes("62%")), JSON.stringify((listRows ?? []).slice(0, 3).map((row) => row.text)));
  await fx.page.evaluate(() => {
    const sheet = window.__deep(window.__panelRoot(), "kestrel-species-sheet")[0]?.shadowRoot;
    sheet?.querySelector("kestrel-lu-audio-list")?.scrollIntoView({ block: "start" });
  });
  await fx.settle(500);
  await fx.check("(5) the page does not scroll sideways", (await fx.page.evaluate(() => document.documentElement.scrollWidth - innerWidth)) <= 0);
  await fx.shot("sheet-heard");
}, { watchdogSeconds: 240 });
