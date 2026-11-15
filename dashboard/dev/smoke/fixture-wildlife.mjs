// The wildlife features, against the fixture page: the period switch on Wildlife, what the species sheet adds (the facts strip, the 30-day chart, the About text and its credit,
// the weather and the spectrogram under a recording, with its playhead) and the two cards with their editors (dev/cards-page.ts, /kestrel/cards).
//   taskset -c 0-4,8-12 nice -n 15 node dev/smoke/fixture-wildlife.mjs --size 390x844 --theme flat-light      (OUT=<folder> keeps the screenshots there)
import { runSmoke } from "./lib/fixture.mjs";

runSmoke("fixture-wildlife", async (fx) => {
  const { page } = fx;
  const asked = () => page.evaluate(() => window.__ha.calls.filter((call) => call.type === "kestrel/species").map((call) => call.message.period ?? "all"));
  const tiles = () => fx.panel.count("button.species-tile");

  // ---- the period switch ----------------------------------------------------------------------------------------------------------------------------------
  await fx.open("/kestrel/wildlife");
  await fx.poll(async () => (await tiles()) > 0, { timeout: 15000 });
  await fx.shot("1-wildlife-all-time");
  const segmented = page.locator('kestrel-lu-segmented[label="Time"]');
  await fx.check("the time switch is on Wildlife", (await segmented.count()) === 1);
  // Under 360 pixels the toolkit shows the same choice as a native dropdown instead of squeezed labels (the dropdown exists at every width, hidden when wide).
  const choose = async (name) => {
    const dropdown = segmented.locator("select");
    if (await dropdown.isVisible()) await dropdown.selectOption({ label: name });
    else await segmented.getByText(name, { exact: true }).first().click();
    await fx.settle(800);
  };
  await choose("Today");
  await fx.check("Today asks the server for today", (await asked()).includes("today"), (await asked()).join(","));
  const today = await tiles();
  await fx.check("Today lists the species that came today", today > 0, `${today} tiles`);
  await fx.shot("2-wildlife-today");
  await choose("7 days");
  await fx.check("7 days asks the server for the week", (await asked()).includes("week"));
  await choose("30 days");
  await fx.check("30 days asks the server for the month", (await asked()).includes("month"));
  await fx.shot("3-wildlife-30-days");
  await choose("All time");

  // ---- the species sheet ----------------------------------------------------------------------------------------------------------------------------------
  await page.locator('button.species-tile[aria-label^="Northern Cardinal."]').first().click();
  await fx.poll(() => fx.panel.speciesOpen(), { timeout: 8000 });
  await fx.settle(1800);
  const sheet = await fx.ev((deep) => {
    const root = deep(window.__panelRoot(), "kestrel-species-sheet")[0]?.shadowRoot;
    return {
      facts: [...(root?.querySelectorAll(".facts .fact") ?? [])].map((el) => (el.textContent ?? "").replace(/\s+/g, " ").trim()),
      charts: [...(root?.querySelectorAll(".bars") ?? [])].map((el) => el.children.length),
      about: root?.querySelector(".blurb")?.textContent?.slice(0, 40) ?? "",
      credit: [...(root?.querySelectorAll(".credit a") ?? [])].map((a) => `${a.textContent} ${a.getAttribute("href")}`),
      chips: [...(root?.querySelectorAll(".badges kestrel-lu-chip") ?? [])].map((el) => el.getAttribute("label")),
    };
  });
  await fx.check("the sheet shows the facts strip", sheet.facts.length >= 2, sheet.facts.join(" | "));
  await fx.check("the sheet draws the 30-day chart (and the hours)", sheet.charts.includes(30) && sheet.charts.includes(24), sheet.charts.join(","));
  await fx.check("the About text is there with its credit links", sheet.about.length > 10 && sheet.credit.length === 2, `${sheet.about} / ${sheet.credit.join(" ; ")}`);
  await fx.info(`chips: ${sheet.chips.join(", ") || "none"}`);
  await fx.shot("4-sheet-top");
  await fx.ev((deep) => { deep(window.__panelRoot(), "kestrel-species-sheet")[0]?.shadowRoot.querySelector(".facts")?.scrollIntoView({ block: "start" }); });
  await fx.settle(300);
  await fx.shot("5-sheet-facts-and-chart");
  await fx.ev((deep) => { deep(window.__panelRoot(), "kestrel-species-sheet")[0]?.shadowRoot.querySelector(".blurb")?.scrollIntoView({ block: "center" }); });
  await fx.settle(300);
  await fx.shot("5b-sheet-about");
  await fx.ev((deep) => { [...deep(window.__panelRoot(), "kestrel-species-sheet")[0]?.shadowRoot.querySelectorAll(".bars") ?? []].find((el) => el.children.length === 30)?.scrollIntoView({ block: "center" }); });
  await fx.settle(300);
  await fx.shot("5c-sheet-30-days");

  // The weather and the spectrogram are asked for only when the list comes into view, so scroll to it first.
  await fx.ev((deep) => { deep(window.__panelRoot(), "kestrel-species-sheet")[0]?.shadowRoot.querySelector("kestrel-recording-list")?.scrollIntoView({ block: "start" }); });
  const extras = await fx.poll(() => fx.ev((deep) => {
    const list = deep(window.__panelRoot(), "kestrel-species-sheet")[0]?.shadowRoot.querySelector("kestrel-recording-list");
    const weather = list?.shadowRoot.querySelectorAll(".weather").length ?? 0;
    const strips = [...(list?.shadowRoot.querySelectorAll("kestrel-spectrogram") ?? [])].filter((el) => el.shadowRoot?.querySelector("button.strip")).length;
    return weather > 0 && strips > 0 ? { weather, strips } : null;
  }), { timeout: 12000 });
  await fx.check("recordings show their weather and a spectrogram", Boolean(extras), extras ? `${extras.weather} weather lines, ${extras.strips} spectrograms` : "none appeared");
  await fx.settle(1500);
  await fx.shot("6-sheet-recordings");

  const opened = await fx.ev((deep) => {
    const strip = [...deep(window.__panelRoot(), "kestrel-spectrogram")].find((el) => el.shadowRoot.querySelector("button.strip"))?.shadowRoot.querySelector("button.strip");
    strip?.click();
    return Boolean(strip);
  });
  await fx.settle(900);
  const expanded = await fx.ev((deep) => [...deep(window.__panelRoot(), "kestrel-spectrogram")].some((el) => el.shadowRoot.querySelector("button.strip")?.getAttribute("aria-expanded") === "true" && (el.shadowRoot.querySelector("img")?.naturalWidth ?? 0) === 514));
  await fx.check("a spectrogram opens to the full 514 pixel picture", opened && expanded);
  await fx.shot("7-sheet-spectrogram-open");

  // The fixture's recording is one second long, so look at the playhead while it plays.
  await fx.ev((deep) => { deep(window.__panelRoot(), "kestrel-species-sheet")[0]?.shadowRoot.querySelector("kestrel-recording-list")?.shadowRoot.querySelector("button.play:not(:disabled)")?.click(); });
  const samples = [];
  for (let i = 0; i < 16; i += 1) {
    await fx.settle(60);
    samples.push(await fx.ev((deep) => { const live = [...deep(window.__panelRoot(), "kestrel-spectrogram")].find((el) => el.hasAttribute("data-live")); return live ? Number(live.style.getPropertyValue("--f")) : null; }));
    if (i === 3) await fx.shot("8-sheet-playing");
  }
  await fx.check("the playhead follows the recording", Math.max(...samples.map((value) => value ?? 0)) > 0, samples.map((value) => (value === null ? "-" : value.toFixed(2))).join(" "));

  // ---- the cards ------------------------------------------------------------------------------------------------------------------------------------------
  const cards = new URL(`/kestrel/cards?cards=1&theme=${fx.theme}`, fx.server.url).href;
  await page.goto("about:blank");
  await page.goto(cards, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__deep(document, "kestrel-highlight-card").length >= 4, null, { timeout: 20000 });
  await fx.settle(2200);
  const registered = await page.evaluate(() => (window.customCards ?? []).map((card) => card.type));
  await fx.check("both cards are listed for the card picker", registered.includes("kestrel-highlight-card") && registered.includes("kestrel-species-list-card"), registered.join(","));
  const seen = await fx.ev((deep) => ({
    highlights: deep(document, "kestrel-highlight-card").slice(0, 4).map((card) => card.shadowRoot.querySelector("a.highlight")?.getAttribute("aria-label") ?? "(no card yet)"),
    rows: deep(document, "kestrel-species-list-card").slice(0, 3).map((card) => card.shadowRoot.querySelectorAll("kestrel-lu-row").length),
    sizes: [...document.querySelectorAll("kestrel-cards-page .cell")].map((cell) => cell.dataset.cardSize).slice(0, 7),
  }));
  await fx.check("the highlight cards have something to say", seen.highlights.slice(0, 3).every((text) => text !== "(no card yet)"), seen.highlights.join(" | "));
  await fx.check("the list cards list species", seen.rows[0] > 0 && seen.rows[0] <= 6 && seen.rows[1] <= 3, seen.rows.join(","));
  await fx.info(`getCardSize of the first seven: ${seen.sizes.join(",")}`);
  await fx.shot("9-cards");
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await fx.settle(300);
  await fx.shot("10-cards-editors");

  const period = page.locator('kestrel-highlight-card-editor select[name="period"]');
  await period.selectOption("today");
  await fx.settle(900);
  const written = await page.locator("kestrel-cards-page pre").first().textContent();
  await fx.check("the editor writes the setting it was given", /"period":"today"/.test(written ?? "") && /"type":"custom:kestrel-highlight-card"/.test(written ?? ""), written ?? "");

  await page.evaluate(() => window.scrollTo(0, 0));
  await fx.settle(200);
  await page.locator("kestrel-highlight-card a.highlight").first().click();
  const at = await fx.poll(async () => { const here = await fx.nav(); return here.path !== "/kestrel/cards" ? here : null; }, { timeout: 6000 });
  await fx.check("tapping the highlight card opens the panel on that species or visit", Boolean(at) && /^\/kestrel\/(wildlife|visit)/.test(at?.path ?? ""), at ? `${at.path}${at.search}` : "stayed on the cards page");
  await fx.shot("11-after-tap");
  await fx.back();
  await fx.settle(800);
  await fx.check("back returns to the cards", (await fx.nav()).path === "/kestrel/cards");

  // A heard visit: its weather and spectrogram sit under the audio player.
  await fx.open("/kestrel/visit?v=fixture-heard-1");
  const visitExtras = await fx.poll(() => fx.ev((deep) => {
    const weather = deep(window.__panelRoot(), ".weather").length;
    const strips = [...deep(window.__panelRoot(), "kestrel-spectrogram")].filter((el) => el.shadowRoot?.querySelector("button.strip")).length;
    return weather > 0 && strips > 0 ? { weather, strips } : null;
  }), { timeout: 12000 });
  await fx.check("a heard visit shows its weather and spectrogram under the player", Boolean(visitExtras), visitExtras ? `${visitExtras.weather} weather, ${visitExtras.strips} spectrogram` : "none appeared");
  await fx.settle(800);
  await fx.shot("14-heard-visit");

  // ---- honest states --------------------------------------------------------------------------------------------------------------------------------------
  for (const [name, query] of [["quiet", "quiet=1&fail="], ["failing", "quiet=0&fail=highlights,period"]]) {
    await page.goto("about:blank");
    await page.goto(new URL(`/kestrel/cards?cards=1&theme=${fx.theme}&${query}`, fx.server.url).href, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__deep(document, "kestrel-highlight-card").length >= 4, null, { timeout: 20000 });
    await fx.settle(2200);
    await fx.shot(`12-cards-${name}`);
  }
  await page.goto("about:blank");
  await page.goto(new URL(`/kestrel/wildlife?theme=${fx.theme}&quiet=1&fail=`, fx.server.url).href, { waitUntil: "domcontentloaded" });
  await fx.waitForPanel();
  await fx.poll(async () => (await tiles()) > 0, { timeout: 15000 });
  await choose("Today");
  const none = await fx.poll(async () => (await tiles()) === 0, { timeout: 5000 });
  await fx.check("a quiet Today shows no species tiles", Boolean(none), `${await tiles()} tiles`);
  await fx.shot("13-wildlife-quiet-today");
  await choose("All time");
});
