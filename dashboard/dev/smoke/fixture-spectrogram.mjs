// The picture under a recording (the spectrogram strip) when BirdNET-Go is slow, busy or failing, against the fixture page. What has to hold: the strip never shows a broken
// picture; a picture that is not ready says so quietly ("Picture not ready") and is asked for again later (after a pause, not in a loop, and not while the page is in the
// background); a picture that was only late shows up by itself; and the note reads well in all four looks.
// The harness setting `spectrogram=trouble` makes the recordings' pictures go wrong in turn (by the number of the visit: see dev/wildlife-fixtures.ts), and the id of
// each picture tells dev/serve.mjs how: "flaky-" is not ready the first time, "err-" fails every time (504), "blank-" is never drawn (204), "slow-" takes eight seconds.
//   taskset -c 0-4,8-12 nice -n 15 node dev/smoke/fixture-spectrogram.mjs --size 390x844 --theme glass-dark      (OUT=<folder> keeps the screenshots there)
// It runs in real time (the first pause before asking again is two seconds, the next fifteen): about a minute on a quiet machine. Checks that depend on time look at WHEN each
// ask was made, not at what the page shows at some moment, so a slow machine does not fail them. The end of the schedule (given up after about eight minutes) is not waited for;
// the schedule itself is tested in test/recordings.test.mjs.
import { THEMES, runSmoke } from "./lib/fixture.mjs";

const PICTURE = /\/birdnet_spectrogram\/([^/?]+)/;
const KINDS = ["flaky", "err", "blank", "slow"];
const kindOf = (id) => KINDS.find((kind) => id.startsWith(`${kind}-`)) ?? "plain";
/** The first pause before a picture is asked for again (pictureRetryDelay(0) in src/recordings.ts). */
const FIRST_PAUSE_MS = 2000;

/** In the page: one entry per spectrogram strip of the open species sheet, with what it shows right now. */
const readStrips = (deep) => {
  const list = deep(window.__panelRoot(), "kestrel-species-sheet")[0]?.shadowRoot.querySelector("kestrel-recording-list");
  return [...(list?.shadowRoot.querySelectorAll("kestrel-spectrogram") ?? [])].map((el) => {
    const root = el.shadowRoot;
    const strip = root.querySelector(".strip");
    const note = root.querySelector(".note");
    return {
      id: el.src ? new URL(el.src, location.href).pathname.split("/").pop() : "",
      button: Boolean(root.querySelector("button.strip")),
      note: note ? note.textContent.trim() : null,
      quiet: strip?.getAttribute("aria-hidden") === "true",
      picture: root.querySelector("img")?.naturalWidth ?? 0,
      height: Math.round(strip?.getBoundingClientRect().height ?? 0),
    };
  });
};

/** In the page: watches the strips for a broken picture (a finished load with nothing in it that is not invisible) and for the panel being told a picture failed for good. */
const startWatching = () => {
  window.__broken = [];
  window.__imageErrors = [];
  window.addEventListener("lu-image-error", (event) => window.__imageErrors.push(String(event.detail?.src ?? "")));
  setInterval(() => {
    const list = window.__deep(window.__panelRoot(), "kestrel-species-sheet")[0]?.shadowRoot.querySelector("kestrel-recording-list");
    for (const el of list?.shadowRoot.querySelectorAll("kestrel-spectrogram") ?? []) {
      const img = el.shadowRoot?.querySelector("img");
      if (img && img.complete && img.naturalWidth === 0 && getComputedStyle(img).opacity !== "0") window.__broken.push(`${el.src}: opacity ${getComputedStyle(img).opacity}`);
    }
  }, 80);
};

/** In the page: how the note under a picture that is not ready looks (its colour against the toolkit's own muted ink, and the strip it sits in). */
const readNote = (deep) => {
  const list = deep(window.__panelRoot(), "kestrel-species-sheet")[0]?.shadowRoot.querySelector("kestrel-recording-list");
  for (const el of list?.shadowRoot.querySelectorAll("kestrel-spectrogram") ?? []) {
    const note = el.shadowRoot.querySelector(".note");
    if (!note) continue;
    const probe = document.createElement("span");
    probe.style.color = "var(--lu-ink-3)";
    el.shadowRoot.append(probe);
    const muted = getComputedStyle(probe).color;
    probe.remove();
    const strip = el.shadowRoot.querySelector(".strip");
    const box = note.getBoundingClientRect();
    return { color: getComputedStyle(note).color, muted, tile: getComputedStyle(strip).backgroundColor, size: getComputedStyle(note).fontSize, fits: box.width > 0 && box.width <= strip.getBoundingClientRect().width };
  }
  return null;
};

runSmoke("fixture-spectrogram", async (fx) => {
  const { page } = fx;
  const strips = () => fx.ev(readStrips);
  const recordingsAsked = () => page.evaluate(() => window.__ha.calls.filter((call) => call.type === "kestrel/recordings").length);

  /** When each picture was asked for, by the id the server saw. */
  let asked = new Map();
  page.on("request", (request) => {
    const id = PICTURE.exec(request.url())?.[1];
    if (id) asked.set(id, [...(asked.get(id) ?? []), Date.now()]);
  });
  const askedOf = (kind) => [...asked.keys()].filter((id) => kindOf(id) === kind);
  const times = (id) => asked.get(id) ?? [];
  const failing = (rows) => rows.filter((row) => asked.has(row.id) && ["flaky", "err", "blank"].includes(kindOf(row.id)));
  /** The ids asked for so far whose picture was not ready the first time. */
  const failers = () => failing([...asked.keys()].map((id) => ({ id }))).map((row) => row.id);

  /** Opens the species sheet of the Northern Cardinal, whose recordings have pictures that go wrong in turn, and brings its list into view (a picture is asked for only when its strip is near). */
  const openSheet = async () => {
    asked = new Map();
    await fx.open("/kestrel/wildlife?spectrogram=trouble");
    await fx.poll(async () => (await fx.panel.count("button.species-tile")) > 0, { timeout: 15000 });
    await page.locator('button.species-tile[aria-label^="Northern Cardinal."]').first().click();
    await fx.poll(() => fx.panel.speciesOpen(), { timeout: 8000 });
    await fx.settle(2800); // the About text follows the sheet by about two seconds and pushes the list down: scroll only after that, so the rows stay where they are put
    const listed = await fx.poll(() => fx.ev((deep) => {
      const list = deep(window.__panelRoot(), "kestrel-species-sheet")[0]?.shadowRoot.querySelector("kestrel-recording-list");
      list?.scrollIntoView({ block: "start" });
      return Boolean(list);
    }), { timeout: 12000 });
    if (!listed) throw new Error("the recording list did not appear on the species sheet");
    await page.evaluate(startWatching);
  };
  /** Waits until every picture that is going to fail has failed once (its note is up). */
  const firstMisses = () => fx.poll(async () => {
    const rows = failing(await strips());
    return rows.length > 0 && rows.every((row) => row.note) ? rows : null;
  }, { timeout: 30000 });

  // ---- 1. the natural course: notes, one more try after the first pause, no loop, late pictures arrive -------------------------------------------------------
  await openSheet();
  const noted = await firstMisses();
  const startedAt = Math.min(...[...asked.values()].flat());
  await fx.info(`asked so far: ${[...asked.keys()].map((id) => id.replace("fx-heard-northern-cardinal-", "#")).join(", ") || "nothing"}`);
  await fx.check("every kind of trouble is on screen to be asked about (flaky, failing, never drawn, slow)", KINDS.every((kind) => askedOf(kind).length > 0), KINDS.map((kind) => `${kind}: ${askedOf(kind).length}`).join(", "));
  await fx.check("a picture that is not ready says so quietly: a note, no button, hidden from screen readers", Boolean(noted) && noted.every((row) => row.note === "Picture not ready" && row.quiet && !row.button && row.picture === 0), JSON.stringify((noted ?? []).map((row) => [row.id.slice(0, 5), row.note, row.button])));
  const early = await strips();
  const slowNow = early.filter((row) => kindOf(row.id) === "slow" && asked.has(row.id));
  await fx.check("a slow picture shows nothing until it comes: no note, no broken picture", slowNow.length > 0 && slowNow.every((row) => row.button && row.note === null && (row.picture === 0 || row.picture === 514)), JSON.stringify(slowNow.map((row) => [row.button, row.note, row.picture])));
  const calls = await recordingsAsked();
  await fx.shot("1-not-ready");

  // The first pause is two seconds: the second ask comes after it, not at once and not much later.
  const again = await fx.poll(() => (failers().length > 0 && failers().every((id) => times(id).length >= 2) ? true : null), { timeout: 15000 });
  await fx.check("a picture that was not ready is asked for again", Boolean(again), [...asked.entries()].filter(([id]) => kindOf(id) !== "slow").map(([id, at]) => `${id.slice(0, 5)}:${at.length}`).join(" "));
  const gaps = failers().map((id) => times(id)[1] - times(id)[0]);
  await fx.check("it waits for the pause first (about two seconds), it does not ask again at once", gaps.length > 0 && gaps.every((gap) => gap >= FIRST_PAUSE_MS - 200 && gap <= 9000), gaps.join(", ") + " ms");
  const flaky = await fx.poll(async () => {
    const rows = (await strips()).filter((row) => kindOf(row.id) === "flaky" && asked.has(row.id));
    return rows.length > 0 && rows.every((row) => row.button && row.picture === 514 && row.note === null) ? rows : null;
  }, { timeout: 15000 });
  await fx.check("a picture that was only late shows up by itself, as the usual strip", Boolean(flaky), flaky ? `${flaky.length} strip(s) with the 514 pixel picture` : "still not there");

  // Eight seconds in, the slow picture is drawn. By then the failing ones have been asked twice and are resting until the next pause (fifteen seconds).
  const slowArrived = await fx.poll(async () => {
    const rows = (await strips()).filter((row) => kindOf(row.id) === "slow" && asked.has(row.id));
    return rows.length > 0 && rows.every((row) => row.button && row.picture === 514) ? rows : null;
  }, { timeout: 25000 });
  await fx.check("a slow picture shows when it arrives", Boolean(slowArrived));
  const resting = await strips();
  const stillFailing = failing(resting).filter((row) => ["err", "blank"].includes(kindOf(row.id)));
  // Twice so far; a third ask is fine only if the next pause (fifteen seconds) really passed, which a slow machine can make happen before this line runs.
  const restedLongEnough = (id) => times(id).length === 2 || (times(id).length > 2 && times(id)[2] - times(id)[1] >= 14000);
  await fx.check("a picture that keeps failing is asked for twice so far, not in a loop, and keeps its note", stillFailing.length > 0 && stillFailing.every((row) => restedLongEnough(row.id) && row.note === "Picture not ready" && !row.button), stillFailing.map((row) => `${row.id.slice(0, 5)}:${times(row.id).length}`).join(" "));
  const plain = resting.filter((row) => kindOf(row.id) === "plain" && asked.has(row.id));
  await fx.check("an ordinary recording is asked for once and shows its picture", plain.length === 0 || plain.every((row) => times(row.id).length === 1 && row.picture === 514), plain.length ? plain.map((row) => `${row.id.slice(-2)}:${times(row.id).length}`).join(" ") : "none on screen");
  const slowAsks = askedOf("slow").map((id) => times(id).length);
  await fx.check("a slow picture is asked for once: waiting is not failing", slowAsks.length > 0 && slowAsks.every((count) => count === 1), slowAsks.join(","));
  const ordinaryHeight = resting.find((row) => row.button && row.picture === 514)?.height;
  await fx.check("a note keeps the height of the strip, so nothing moves when the picture arrives", stillFailing.length > 0 && stillFailing.every((row) => row.height === ordinaryHeight), `note ${stillFailing.map((row) => row.height).join(",")} / picture ${ordinaryHeight}`);
  await fx.check("asking for a picture again does not ask the server for the recordings again", (await recordingsAsked()) === calls, `${calls} then ${await recordingsAsked()}`);
  await fx.check("it was never told a picture failed for good while it is still trying", (await page.evaluate(() => window.__imageErrors)).length === 0);
  await fx.check("never a visible broken picture, from the first ask to now", (await page.evaluate(() => window.__broken)).length === 0, (await page.evaluate(() => window.__broken)).slice(0, 2).join(" | ") || `${Math.round((Date.now() - startedAt) / 1000)} s watched`);
  await fx.shot("2-after-eight-seconds");

  // ---- 2. a page in the background does not keep asking ---------------------------------------------------------------------------------------------------------
  await openSheet();
  await firstMisses();
  await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" }); });
  const countsThen = Object.fromEntries([...asked.entries()].map(([id, at]) => [id, at.length]));
  await fx.settle(FIRST_PAUSE_MS * 2 + 500);
  const moved = [...asked.entries()].filter(([id, at]) => kindOf(id) !== "slow" && at.length !== countsThen[id]).map(([id]) => id.slice(0, 5));
  await fx.check("nothing is asked for again while the page is in the background", moved.length === 0, moved.length ? `asked again: ${moved.join(", ")}` : "the same number of asks after four and a half seconds");
  await page.evaluate(() => { delete document.visibilityState; });
  const resumed = await fx.poll(() => ["err", "blank"].flatMap((kind) => askedOf(kind)).every((id) => times(id).length >= 2) ? true : null, { timeout: 20000 }); // a rest of up to fifteen seconds may still be running
  await fx.check("back in front, it asks again", Boolean(resumed));
  await fx.check("and it was still never a broken picture", (await page.evaluate(() => window.__broken)).length === 0);

  // ---- 3. the note in all four looks ----------------------------------------------------------------------------------------------------------------------------
  for (const look of THEMES) {
    await page.evaluate((name) => window.__ha.setTheme(name), look);
    await fx.settle(600);
    const note = await fx.ev(readNote);
    await fx.check(`the note uses the toolkit's muted ink and fits its strip (${look})`, Boolean(note) && note.color === note.muted && note.fits && note.color !== note.tile, note ? `${note.color} on ${note.tile}, ${note.size}` : "no note on screen");
    await fx.shot(`3-${look}`);
  }
}, { watchdogSeconds: 600 });
