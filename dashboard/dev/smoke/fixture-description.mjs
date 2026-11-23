// The species sheet's About text, against the fixture page: the sheet opens at once, the About block shows a quiet loading state while the fake Wikipedia is slow (about
// two seconds, dev/harness.ts), then the text and its credit fill in; when the late answer fails the loading state just goes away.
//   taskset -c 0-4,8-12 nice -n 15 node dev/smoke/fixture-description.mjs --size 390x844 --theme flat-light      (OUT=<folder> keeps the screenshots there)
import { runSmoke } from "./lib/fixture.mjs";

runSmoke("fixture-description", async (fx) => {
  const { page } = fx;
  const about = () => fx.ev((deep) => {
    const root = deep(window.__panelRoot(), "kestrel-species-sheet")[0]?.shadowRoot;
    const section = [...(root?.querySelectorAll("section.block") ?? [])].find((block) => block.querySelector("h3")?.textContent === "About");
    return {
      present: Boolean(section),
      busy: section?.getAttribute("aria-busy") === "true",
      loading: Boolean(section?.querySelector('kestrel-lu-state[kind="loading"]')),
      text: section?.querySelector(".blurb")?.textContent?.slice(0, 40) ?? "",
      credit: [...(section?.querySelectorAll(".credit a") ?? [])].length,
      height: Math.round(section?.getBoundingClientRect().height ?? 0),
    };
  });
  const openCardinal = async () => {
    await fx.open("/kestrel/wildlife");
    await fx.poll(async () => (await fx.panel.count("button.species-tile")) > 0, { timeout: 15000 });
    await page.locator('button.species-tile[aria-label^="Northern Cardinal."]').first().click();
    await fx.poll(() => fx.panel.speciesOpen(), { timeout: 8000 });
  };

  // ---- the words come late -----------------------------------------------------------------------------------------------------------------------------------
  await openCardinal();
  await fx.poll(async () => (await about()).present, { timeout: 1500 });
  const waiting = await about();
  await fx.check("the sheet is open while the words are still coming, with a loading state in About", waiting.loading && waiting.busy && !waiting.text, JSON.stringify(waiting));
  await fx.shot("1-about-loading");
  await fx.poll(async () => (await about()).text.length > 10, { timeout: 6000 });
  const filled = await about();
  await fx.check("the text and its credit fill in, and the loading state is gone", filled.credit === 2 && !filled.loading && !filled.busy, JSON.stringify(filled));
  await fx.info(`About block height: ${waiting.height}px loading, ${filled.height}px filled`);
  await fx.shot("2-about-filled");

  // ---- the late answer fails ---------------------------------------------------------------------------------------------------------------------------------
  await fx.open("/kestrel/wildlife?fail=description");
  await fx.poll(async () => (await fx.panel.count("button.species-tile")) > 0, { timeout: 15000 });
  await page.locator('button.species-tile[aria-label^="Northern Cardinal."]').first().click();
  await fx.poll(() => fx.panel.speciesOpen(), { timeout: 8000 });
  await fx.poll(async () => (await about()).loading, { timeout: 1500 });
  await fx.settle(3000);
  const failed = await about();
  await fx.check("a failed late answer removes the About block quietly", !failed.present, JSON.stringify(failed));
  await fx.shot("3-about-failed");
});
