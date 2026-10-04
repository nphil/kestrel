#!/usr/bin/env node
// "Play reference": what a species actually sounds like, from Xeno-canto or iNaturalist, on the species sheet and on the visit page.
//   taskset -c 0-4,8-12 nice -n 15 node dev/smoke/fixture-reference.mjs [--size 390x844] [--theme flat-light]
// Needs `node dev/build.mjs` first. Screenshots go to /tmp/kestrel-ref (OUT=... changes it). The fixture server answers `kestrel/species/reference`
// (dev/harness.ts) and streams dev/fixtures/call.mp3 for the signed `species_sound` links (dev/serve.mjs).
//   (1) Northern Cardinal's sheet: idle (nothing asked, nothing downloaded) -> pressed (loading) -> ready: chip, Song/Call switch, player, credit,
//       link, playback started by itself, focus kept; reopening shows the kept answer at once, without playing, without asking again
//   (2) Spring Peeper: three recordings. House Mouse: none. Great Horned Owl: an error, then Try again works (and a sparse clip reads cleanly)
//   (3) a browser that refuses autoplay is ignored; the same press from the keyboard keeps the focus inside the block
//   (4) the socket down is "couldn't look it up", never a crash; Try again works once it is back
//   (5) the visit page: the heard tile (Common Raccoon) and the "Also heard" tile, compact, under the recording; none for "Not an animal"
//   (6) the species changes under a block (back to its button), an answer that arrives after that or after the block was removed is ignored,
//       and kept answers live 30 minutes after they were last on screen and never past 6 hours (the clock is moved in the page)
//   (7) Home Assistant restarts: the block goes back to its button, and the next press gets links of the new key
process.env.OUT ??= "/tmp/kestrel-ref";
const { runSmoke, MEDIA_PATH } = await import("./lib/fixture.mjs");

const LATENCY = 500;
const SOUND = `${MEDIA_PATH}species_sound/`;
const sheetUrl = (name, latency = LATENCY) => `/kestrel/wildlife?s=${encodeURIComponent(name)}&latency=${latency}`;
const epochOf = (url) => { const match = /authSig=e(\d+)/.exec(url ?? ""); return match ? Number(match[1]) : -1; };

/** Everything the checks need to know about the nth `<kestrel-reference-sound>`, read in the page. Text is whitespace-normalised (no-break spaces too). */
const readBlock = (deep, index) => {
  const el = deep(document, "kestrel-reference-sound")[index];
  if (!el) return null;
  const root = el.shadowRoot;
  const one = (selector) => root.querySelector(selector);
  const text = (node) => (node?.textContent ?? "").replace(/\s+/g, " ").trim();
  const chip = one("kestrel-lu-chip");
  const seg = one("kestrel-lu-segmented");
  const player = one("kestrel-lu-audio-player");
  const audio = player?.shadowRoot?.querySelector("audio") ?? null;
  const state = one("kestrel-lu-state");
  const start = one(".start kestrel-lu-button");
  const link = one(".link");
  const section = one("kestrel-lu-section");
  return {
    phase: el._phase,
    compact: el.hasAttribute("compact"),
    heading: section ? section.heading : null,
    icon: section ? section.icon : null,
    start: start ? { label: start.label, loading: start.loading, icon: start.icon, kind: start.kind } : null,
    hint: text(one(".hint")),
    note: text(one(".note")),
    chip: chip ? { text: text(chip.shadowRoot.querySelector(".text")), icon: chip.icon, kind: chip.kind } : null,
    segmented: seg ? { options: seg.options.map((option) => option.label), value: seg.value, label: seg.label } : null,
    player: player ? { src: player.src, mark: player.mark, label: player.label, preload: player.preload } : null,
    audio: audio ? { paused: audio.paused, played: audio.played.length, error: audio.error ? audio.error.code : null } : null,
    audios: deep(root, "audio").length,
    credit: text(one(".credit")),
    link: link ? { href: link.href, target: link.target, label: link.label, icon: link.icon, kind: link.kind } : null,
    error: state ? { kind: state.kind, message: state.message, retry: state.retryLabel, compact: state.compact } : null,
    live: text(one('[role="status"]')),
    liveAttr: one('[role="status"]')?.getAttribute("aria-live") ?? null,
  };
};

/** Where the block and its parts are, and whether any of them is cut off or runs outside it. */
const readGeometry = (deep, index) => {
  const el = deep(document, "kestrel-reference-sound")[index];
  const host = el.getBoundingClientRect();
  const target = Number.parseFloat(getComputedStyle(el).getPropertyValue("--lu-target")) || 48;
  const spaceThree = Number.parseFloat(getComputedStyle(el).getPropertyValue("--lu-space-3")) || 12;
  const parts = [];
  for (const [name, selector] of [["chip", "kestrel-lu-chip"], ["segmented", "kestrel-lu-segmented"], ["player", "kestrel-lu-audio-player"], ["credit", ".credit"], ["link", ".link"], ["button", ".start kestrel-lu-button"], ["hint", ".hint"], ["state", "kestrel-lu-state"], ["note", ".note"]]) {
    const node = el.shadowRoot.querySelector(selector);
    if (!node) continue;
    const box = node.getBoundingClientRect();
    parts.push({ name, left: box.left, right: box.right, height: box.height });
  }
  const buttons = [...deep(el.shadowRoot, "kestrel-lu-button")].map((button) => button.getBoundingClientRect().height);
  const retry = el.shadowRoot.querySelector("kestrel-lu-state")?.shadowRoot?.querySelector("button");
  if (retry) buttons.push(retry.getBoundingClientRect().height);
  const style = getComputedStyle(el);
  const inner = el.shadowRoot.querySelector("kestrel-lu-section");
  const sheetBody = el.closest("kestrel-lu-sheet")?.shadowRoot?.querySelector(".body") ?? null;
  const own = [...el.shadowRoot.querySelectorAll("*")].filter((node) => node.localName !== "style");
  const segmented = el.shadowRoot.querySelector("kestrel-lu-segmented");
  const cut = segmented ? [...segmented.shadowRoot.querySelectorAll(".name")].filter((node) => node.scrollWidth > node.clientWidth).map((node) => node.textContent.trim()) : [];
  return {
    host: { left: host.left, right: host.right, top: host.top, height: host.height },
    parts, target, spaceThree, buttons, cut,
    outside: parts.filter((part) => (part.name === "link" ? part.left < host.left - spaceThree - 1 : part.left < host.left - 1) || part.right > host.right + 1).map((part) => part.name),
    pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
    sheetOverflow: sheetBody ? sheetBody.scrollWidth - sheetBody.clientWidth : 0,
    border: { width: style.borderTopWidth, style: style.borderTopStyle },
    paddingTop: Number.parseFloat(style.paddingTop),
    marginTop: Number.parseFloat(style.marginTop),
    sectionBorder: inner ? getComputedStyle(inner).borderTopWidth : null,
    animated: own.filter((node) => { const css = getComputedStyle(node); return css.animationName !== "none" || css.transitionDuration.split(",").some((value) => Number.parseFloat(value) > 0); }).map((node) => node.localName),
    parent: el.parentElement?.className ?? "",
  };
};

/** Who has the focus now: the chain of hosts down to the element, so "inside the block" is a plain question. */
const readFocus = (deep) => {
  const chain = [];
  let node = document.activeElement;
  while (node) {
    chain.push(node.localName + (node.getAttribute?.("role") ? `[${node.getAttribute("role")}]` : ""));
    node = node.shadowRoot?.activeElement ?? null;
  }
  return { chain, inBlock: chain.includes("kestrel-reference-sound"), onBody: chain.length === 1 && chain[0] === "body" };
};

await runSmoke("fixture-reference", async (fx) => {
  const block = (index = 0) => fx.ev(readBlock, index);
  const geometry = (index = 0) => fx.ev(readGeometry, index);
  const waitBlock = (test, { index = 0, timeout = 8000 } = {}) => fx.poll(async () => { const b = await block(index); return b && test(b) ? b : null; }, { timeout, every: 50 });
  const calls = () => fx.page.evaluate(() => window.__ha.calls.filter((call) => call.type === "kestrel/species/reference").length);
  const soundRequests = () => fx.media.log.filter((entry) => entry.path.startsWith("species_sound/"));
  const reveal = async (index = 0) => { await fx.page.locator("kestrel-reference-sound").nth(index).scrollIntoViewIfNeeded(); await fx.settle(350); };
  const pressStart = (index = 0) => fx.page.locator("kestrel-reference-sound").nth(index).locator("kestrel-lu-button").first().click({ timeout: 8000 });
  const pressRetry = (index = 0) => fx.page.locator("kestrel-reference-sound").nth(index).locator("kestrel-lu-state button").first().click({ timeout: 8000 });
  const sheetOpenWithBlock = async () => {
    const open = await fx.poll(() => fx.panel.speciesOpen(), { timeout: 12000 });
    const idle = await waitBlock((b) => b.phase === "idle", { timeout: 12000 });
    await fx.settle(500); // the sheet's enter motion
    return open && idle;
  };
  const openSheet = async (name, latency = LATENCY) => { await fx.open(sheetUrl(name, latency)); return sheetOpenWithBlock(); };
  /** The way a person gets there: the Wildlife list, then the species tile. */
  const openSheetByTile = async (name) => {
    await fx.open(`/kestrel/wildlife?latency=${LATENCY}`);
    await fx.page.locator(`button.species-tile[aria-label^="${name}."]`).first().click({ timeout: 15000 });
    return sheetOpenWithBlock();
  };
  const geometryOk = async (label, index = 0) => {
    const g = await geometry(index);
    await fx.check(`${label}: nothing is cut off or outside the block, and the page does not scroll sideways`, g.outside.length === 0 && g.pageOverflow <= 0 && g.sheetOverflow <= 1, `outside: ${g.outside.join(",") || "none"}; page ${g.pageOverflow}; sheet ${g.sheetOverflow}`);
    await fx.check(`${label}: every button is at least ${g.target}px high`, g.buttons.every((height) => height >= g.target - 0.5), g.buttons.map((height) => Math.round(height)).join(", ") || "no buttons");
    await fx.check(`${label}: every label of the switch is shown in full (no ellipsis)`, g.cut.length === 0, g.cut.length ? `cut off: ${g.cut.join(", ")}` : "none cut off");
    await fx.check(`${label}: the block adds no animation or transition of its own`, g.animated.length === 0, g.animated.join(",") || "none");
    return g;
  };

  // ---- (1) Northern Cardinal: the whole path ---------------------------------------------------------------------------------------------
  await fx.check("(1) Northern Cardinal's sheet opens with a reference block", await openSheetByTile("Northern Cardinal"));
  let b = await block();
  await fx.check("(1) idle: titled 'Reference sound' with the book-music icon, not the heard waveform", b.heading === "Reference sound" && b.icon === "mdi:book-music" && b.icon !== "mdi:waveform", `${b.heading} / ${b.icon}`);
  await fx.check("(1) idle: a secondary 'Play reference' button with a play icon, and the caption 'What a Northern Cardinal sounds like'", b.start?.label === "Play reference" && b.start.kind === "secondary" && b.start.icon === "mdi:play" && b.hint === "What a Northern Cardinal sounds like", `${JSON.stringify(b.start)} / ${b.hint}`);
  await fx.check("(1) idle: no player, no chip, no message", !b.player && !b.chip && !b.note && !b.error && b.phase === "idle");
  await fx.check("(1) idle: nothing was asked and nothing downloaded (the lookup is lazy)", (await calls()) === 0 && soundRequests().length === 0, `${await calls()} lookups, ${soundRequests().length} downloads`);
  const order = await fx.ev((deep) => {
    const sheet = deep(document, "kestrel-species-sheet")[0].shadowRoot;
    const hero = sheet.querySelector(".hero");
    const reference = sheet.querySelector("kestrel-reference-sound");
    const onCamera = [...sheet.querySelectorAll("kestrel-lu-section")].find((section) => section.heading === "On camera");
    return { directlyAfterHero: hero?.nextElementSibling === reference, directlyBeforeOnCamera: reference?.nextElementSibling === onCamera };
  });
  await fx.check("(1) placement: directly after the photo block and before the 'On camera' section", order.directlyAfterHero && order.directlyBeforeOnCamera, JSON.stringify(order));
  let g = await geometryOk("(1) idle");
  await fx.check("(1) idle: one hairline above the block, and the section inside adds none (no doubled edge)", g.border.width === "1px" && g.border.style === "solid" && g.sectionBorder === "0px", `${g.border.width} ${g.border.style}; section ${g.sectionBorder}`);
  await reveal();
  await fx.shot("sheet-idle");

  await pressStart();
  const loading = await waitBlock((x) => x.phase === "loading", { timeout: 2000 });
  await fx.check("(1) pressed: the button shows loading and reads 'Finding a recording…'", loading?.start?.loading === true && loading.start.label === "Finding a recording…", JSON.stringify(loading?.start));
  await fx.check("(1) pressed: a polite live region says so", loading?.live === "Finding a recording…" && loading.liveAttr === "polite", `${loading?.live} / ${loading?.liveAttr}`);
  await fx.shot("sheet-loading");
  b = await waitBlock((x) => x.phase === "ready");
  await fx.check("(1) the answer arrives and the button is replaced by the player", !!b && !b.start && !!b.player, b ? b.phase : "never ready");
  await fx.check("(1) exactly one lookup was made", (await calls()) === 1, `${await calls()}`);
  await fx.check("(1) ready: the chip reads exactly 'Reference · Xeno-canto', with the reference icon", b.chip?.text === "Reference · Xeno-canto" && b.chip.icon === "mdi:book-music", `${b.chip?.text} / ${b.chip?.icon}`);
  await fx.check("(1) ready: a 'Reference recording' switch with Song and Call, Song chosen", JSON.stringify(b.segmented?.options) === JSON.stringify(["Song", "Call"]) && b.segmented.label === "Reference recording" && b.segmented.value === "xc-694038", JSON.stringify(b.segmented));
  await fx.check("(1) ready: the player plays a signed species_sound link", !!b.player?.src.startsWith(`${SOUND}xc-694038?authSig=`), b.player?.src);
  await fx.check("(1) ready: the player is marked 'Reference', loads nothing before play, and has a name", b.player?.mark === "Reference" && b.player.preload === "none" && b.player.label === "Reference recording of Northern Cardinal: Song", JSON.stringify(b.player));
  await fx.check("(1) ready: the credit line is Song, recordist, licence, quality and length", b.credit === "Song · Jane Birder · CC BY-NC-SA 4.0 · Quality A · 14 s", b.credit);
  await fx.check("(1) ready: 'View at Xeno-canto' opens the recording's page in a new tab", b.link?.label === "View at Xeno-canto" && b.link.href === "https://xeno-canto.org/694038" && b.link.target === "_blank" && b.link.icon === "mdi:open-in-new" && b.link.kind === "quiet", JSON.stringify(b.link));
  await fx.check("(1) ready: the live region announces the result", b.live === "Reference recording ready, from Xeno-canto.", b.live);
  const started = await fx.poll(async () => { const x = await block(); return x?.audio && (x.audio.played > 0 || !x.audio.paused) ? x : null; }, { timeout: 6000 });
  await fx.check("(1) ready: playback started by itself (the press was the gesture)", !!started, JSON.stringify(started?.audio ?? (await block())?.audio));
  const fetched = await fx.poll(async () => soundRequests().find((entry) => entry.path === "species_sound/xc-694038" && entry.status < 400), { timeout: 4000 });
  await fx.check("(1) ready: the clip itself was fetched through the signed link (status < 400)", !!fetched, JSON.stringify(soundRequests().slice(0, 3)));
  const focus = await fx.ev(readFocus);
  await fx.check("(1) ready: focus was not stolen (it is on the page or inside the block, never in another control)", focus.inBlock || focus.onBody, focus.chain.join(" > "));
  g = await geometryOk("(1) ready");
  await fx.check("(1) ready: an icon and text for the source, so the meaning does not rest on colour", b.chip?.icon === "mdi:book-music" && b.chip.text.startsWith("Reference"), b.chip?.text);
  await reveal();
  await fx.shot("sheet-song");

  await fx.page.evaluate(() => { const el = window.__deep(document, "kestrel-reference-sound")[0]; window.__oldAudio = window.__deep(el.shadowRoot, "audio")[0]; });
  await fx.page.locator("kestrel-reference-sound").first().locator('[role="radio"]', { hasText: "Call" }).click({ timeout: 8000 });
  b = await waitBlock((x) => x.player?.src.includes("xc-412983"), { timeout: 4000 });
  await fx.check("(1) Call: the player now has the call's signed link", !!b, b?.player?.src ?? "still the song");
  await fx.check("(1) Call: chip, credit and link follow the chosen recording", b?.chip?.text === "Reference · Xeno-canto" && b.credit === "Call · Sam Listener · CC BY-NC-SA 4.0 · Quality A · 6 s" && b.link?.href === "https://xeno-canto.org/412983" && b.segmented?.value === "xc-412983" && b.player?.label === "Reference recording of Northern Cardinal: Call", `${b?.credit} / ${b?.link?.href}`);
  const old = await fx.page.evaluate(() => ({ connected: window.__oldAudio.isConnected, paused: window.__oldAudio.paused }));
  await fx.check("(1) Call: the song's player is gone and stopped, and only one player is left", old.connected === false && old.paused === true && b?.audios === 1, `${JSON.stringify(old)}; ${b?.audios} players`);
  await reveal();
  await fx.shot("sheet-call");

  await fx.key("Escape");
  await fx.poll(async () => !(await fx.panel.speciesOpen()) && (await fx.ev((deep) => deep(window.__panelRoot(), "kestrel-species-sheet").length)) === 0, { timeout: 6000 });
  await fx.page.locator('button.species-tile[aria-label^="Northern Cardinal."]').first().click({ timeout: 10000 });
  await fx.poll(() => fx.panel.speciesOpen(), { timeout: 6000 });
  b = await waitBlock((x) => x.phase === "ready", { timeout: 2500 });
  await fx.check("(1) reopened: the kept answer shows the player at once", !!b && !!b.player, b ? b.phase : "not ready within 2.5 s");
  await fx.check("(1) reopened: no second lookup, Song is chosen again, and the clip does not play by itself", (await calls()) === 1 && b?.segmented?.value === "xc-694038" && b.audio?.played === 0 && b.audio.paused === true, `${await calls()} lookups; ${b?.segmented?.value}; ${JSON.stringify(b?.audio)}`);

  // ---- (2) other answers ------------------------------------------------------------------------------------------------------------------
  await fx.check("(2) Spring Peeper's sheet opens", await openSheet("Spring Peeper"));
  await pressStart();
  b = await waitBlock((x) => x.phase === "ready");
  await fx.check("(2) Spring Peeper: three iNaturalist clips in the switch", !!b && JSON.stringify(b.segmented?.options) === JSON.stringify(["Clip 1", "Clip 2", "Clip 3"]) && b.chip?.text === "Reference · iNaturalist", `${JSON.stringify(b?.segmented?.options)} / ${b?.chip?.text}`);
  await fx.check("(2) Spring Peeper: the first clip's credit has no quality", b?.credit === "Clip 1 · frogwatcher · CC BY-NC · 18 s" && b.link?.label === "View at iNaturalist" && b.link.href === "https://www.inaturalist.org/observations/1944677", `${b?.credit} / ${b?.link?.href}`);
  await fx.page.locator("kestrel-reference-sound").first().locator('[role="radio"]', { hasText: "Clip 3" }).click({ timeout: 8000 });
  b = await waitBlock((x) => x.player?.src.includes("inat-1180932"), { timeout: 4000 });
  await fx.check("(2) Spring Peeper: 'Clip 3' swaps in the third clip", !!b && b.credit === "Clip 3 · marsh_ears · CC BY-NC · 9 s" && b.link?.href === "https://www.inaturalist.org/observations/1180932", `${b?.credit}`);
  await geometryOk("(2) three clips");
  await reveal();
  await fx.shot("peeper-three");

  await fx.check("(2) House Mouse's sheet opens", await openSheet("House Mouse"));
  await pressStart();
  b = await waitBlock((x) => x.phase === "none");
  await fx.check("(2) House Mouse: one quiet line, 'No reference recording found for House Mouse.'", b?.note === "No reference recording found for House Mouse." && !b.player && !b.segmented && !b.chip && !b.error && !b.start, JSON.stringify(b));
  await fx.check("(2) House Mouse: the line is announced politely", b?.live === "No reference recording found for House Mouse.", b?.live);
  await geometryOk("(2) none");
  await reveal();
  await fx.shot("mouse-none");

  await fx.check("(2) Great Horned Owl's sheet opens", await openSheet("Great Horned Owl"));
  await pressStart();
  b = await waitBlock((x) => x.phase === "unavailable");
  await fx.check("(2) Great Horned Owl: an error line with 'Couldn't look up a reference recording.' and Try again", b?.error?.kind === "error" && b.error.compact === true && b.error.message === "Couldn't look up a reference recording." && b.error.retry === "Try again" && !b.player, JSON.stringify(b?.error));
  await geometryOk("(2) error");
  await reveal();
  await fx.shot("owl-error");
  await pressRetry();
  b = await waitBlock((x) => x.phase === "ready");
  await fx.check("(2) Great Horned Owl: Try again asks again and the recording arrives", !!b && b.chip?.text === "Reference · Xeno-canto" && (await calls()) === 2, `${b?.phase}; ${await calls()} lookups`);
  await fx.check("(2) Great Horned Owl: one recording means no switch", b?.segmented === null, JSON.stringify(b?.segmented));
  await fx.check("(2) Great Horned Owl: a sparse clip reads cleanly (no recordist, licence or length: no stray separators)", b?.credit === "Song · Quality B", b?.credit);
  await reveal();
  await fx.shot("owl-ready");

  await fx.check("(2) Eastern Screech-Owl's sheet opens", await openSheet("Eastern Screech-Owl"));
  b = await block();
  await fx.check("(2) an 'an' before a vowel: 'What an Eastern Screech-Owl sounds like'", b?.hint === "What an Eastern Screech-Owl sounds like", b?.hint);

  // ---- (3) a browser that refuses autoplay; the same press from the keyboard ------------------------------------------------------------
  await fx.check("(3) Carolina Wren's sheet opens", await openSheet("Carolina Wren"));
  await fx.page.evaluate(() => { window.__plays = 0; HTMLMediaElement.prototype.play = function () { window.__plays += 1; return Promise.reject(new DOMException("play() was blocked", "NotAllowedError")); }; });
  await fx.page.locator("kestrel-reference-sound").first().locator("kestrel-lu-button").first().focus();
  await fx.page.keyboard.press("Enter");
  b = await waitBlock((x) => x.phase === "ready");
  const tried = await fx.poll(() => fx.page.evaluate(() => window.__plays > 0), { timeout: 3000 });
  await fx.check("(3) a refused autoplay is tried once and ignored: the player is simply ready to play", !!b && !!tried && b.audio?.played === 0 && b.audio.paused === true && b.player?.src.includes("xc-701122"), `${b?.phase}; tried ${tried}; ${JSON.stringify(b?.audio)}`);
  const keyboardFocus = await fx.ev(readFocus);
  await fx.check("(3) pressed from the keyboard: the button was replaced and the focus stayed inside the block", keyboardFocus.inBlock, keyboardFocus.chain.join(" > "));

  // ---- (4) the socket is down ---------------------------------------------------------------------------------------------------------------
  await fx.check("(4) Common Raccoon's sheet opens", await openSheet("Common Raccoon"));
  await fx.page.evaluate(() => window.__ha.disconnect());
  await fx.settle(300);
  await pressStart();
  b = await waitBlock((x) => x.phase === "unavailable", { timeout: 6000 });
  await fx.check("(4) no connection: shown as 'Couldn't look up a reference recording.' with Try again, not a crash", b?.error?.message === "Couldn't look up a reference recording." && b.error.retry === "Try again", JSON.stringify(b?.error));
  await fx.page.evaluate(() => window.__ha.reconnect());
  await fx.poll(() => fx.page.evaluate(() => window.__ha.hass.connection.connected), { timeout: 8000 });
  await fx.settle(600);
  await reveal();
  await pressRetry();
  b = await waitBlock((x) => x.phase === "ready", { timeout: 10000 });
  await fx.check("(4) back online: Try again finds the Common Raccoon recording", !!b && b.chip?.text === "Reference · iNaturalist" && b.player?.src.includes("inat-3302188"), `${b?.phase}; ${b?.chip?.text}`);

  // ---- (5) the visit page -------------------------------------------------------------------------------------------------------------------
  const visitBlock = async (path, what) => {
    await fx.open(`${path}&latency=${LATENCY}`);
    const there = await fx.poll(async () => (await fx.panel.count("kestrel-reference-sound")) > 0, { timeout: 15000 });
    await waitBlock((x) => x.phase === "idle", { timeout: 6000 });
    await fx.settle(600);
    await fx.check(`(5) ${what}: the visit page shows a reference block`, !!there);
  };
  await visitBlock("/kestrel/visit?v=fixture-heard-1", "heard visit");
  b = await block();
  g = await geometry();
  await fx.check("(5) heard visit: compact, no heading, idle button and the caption 'What a Common Raccoon sounds like'", b.compact && b.heading === null && b.start?.label === "Play reference" && b.hint === "What a Common Raccoon sounds like", `${b.compact}; ${b.heading}; ${b.hint}`);
  await fx.check("(5) heard visit: inside the heard tile, below the recording, split by one hairline with the 12px padding", g.parent.includes("heard-panel") && g.border.width === "1px" && g.border.style === "solid" && g.paddingTop === g.spaceThree && g.marginTop === 0, `${g.parent}; ${g.border.width} ${g.border.style}; padding ${g.paddingTop} vs ${g.spaceThree}; margin ${g.marginTop}`);
  const below = await fx.ev((deep) => {
    const el = deep(document, "kestrel-reference-sound")[0];
    const own = deep(el.parentElement, "kestrel-lu-audio-player").find((player) => !el.shadowRoot.contains(player));
    return own ? { above: own.getBoundingClientRect().bottom <= el.getBoundingClientRect().top + 1, src: own.src, mark: own.mark } : null;
  });
  await fx.check("(5) heard visit: the visit's own recording stays above it, a different file with its own marks", !!below && below.above && below.src.includes(`${MEDIA_PATH}audio/`) && below.mark === "Cleaned", JSON.stringify(below));
  await geometryOk("(5) heard visit idle");
  await reveal();
  await fx.shot("visit-heard-idle");
  await pressStart();
  b = await waitBlock((x) => x.phase === "ready");
  await fx.check("(5) heard visit: ready with 'Reference · iNaturalist' and a species_sound link", b?.chip?.text === "Reference · iNaturalist" && !!b.player?.src.startsWith(`${SOUND}inat-3302188?authSig=`) && b.segmented === null, `${b?.chip?.text}; ${b?.player?.src}`);
  await geometryOk("(5) heard visit ready");
  await reveal();
  await fx.shot("visit-heard-ready");

  await visitBlock("/kestrel/visit?v=fixture-visit-1", "'Also heard' tile");
  b = await block();
  const tile = await fx.ev((deep) => { const el = deep(document, "kestrel-reference-sound")[0]; return el.parentElement?.querySelector(".heard-copy strong")?.textContent?.trim() ?? null; });
  await fx.check("(5) 'Also heard' tile: the block is in the tile 'Also heard: Northern Cardinal' with the caption 'What a Northern Cardinal sounds like'", tile === "Also heard: Northern Cardinal" && b.compact && b.hint === "What a Northern Cardinal sounds like", `${tile}; ${b.hint}`);
  await geometryOk("(5) 'Also heard' idle");
  await reveal();
  await fx.shot("visit-alsoheard-idle");
  await pressStart();
  b = await waitBlock((x) => x.phase === "ready");
  await fx.check("(5) 'Also heard' tile: Song and Call from Xeno-canto", JSON.stringify(b?.segmented?.options) === JSON.stringify(["Song", "Call"]) && b.chip?.text === "Reference · Xeno-canto" && !!b.player?.src.includes(`${SOUND}xc-694038`), `${JSON.stringify(b?.segmented?.options)}; ${b?.chip?.text}`);
  await geometryOk("(5) 'Also heard' ready");
  await reveal();
  await fx.shot("visit-alsoheard-ready");

  // Three iNaturalist clips in the compact tile, the narrowest place the switch has to fit (a heard visit of a Spring Peeper).
  await visitBlock("/kestrel/visit?v=fx-heard-spring-peeper-0", "heard Spring Peeper visit");
  await pressStart();
  b = await waitBlock((x) => x.phase === "ready");
  await fx.check("(5) heard Spring Peeper visit: 'Clip 1', 'Clip 2', 'Clip 3' in the compact tile", !!b && b.compact && JSON.stringify(b.segmented?.options) === JSON.stringify(["Clip 1", "Clip 2", "Clip 3"]) && b.chip?.text === "Reference · iNaturalist" && b.credit === "Clip 1 · frogwatcher · CC BY-NC · 18 s", `${JSON.stringify(b?.segmented?.options)}; ${b?.chip?.text}; ${b?.credit}`);
  await geometryOk("(5) heard Spring Peeper visit, three clips");
  await reveal();
  await fx.shot("visit-three-clips");

  // A visit marked "Not an animal" has no species to play. A slow answer keeps the optimistic page on screen long enough to look at it.
  await fx.open(`/kestrel/visit?v=fixture-heard-1&latency=2500`);
  await fx.poll(async () => (await fx.panel.count("kestrel-reference-sound")) > 0, { timeout: 20000 });
  await fx.settle(600);
  await fx.page.locator('kestrel-lu-button[label="Wrong?"]').first().click({ timeout: 8000 });
  await fx.page.locator('kestrel-lu-sheet[layer="wrong-picker"] kestrel-lu-button[label="Not an animal"]').first().click({ timeout: 10000 });
  const gone = await fx.poll(async () => (await fx.panel.count("kestrel-reference-sound")) === 0, { timeout: 2000 });
  const stillHeard = await fx.ev((deep) => deep(window.__panelRoot(), ".heard-panel").some((tileEl) => /Not an animal detected here/.test(tileEl.textContent ?? "")));
  await fx.check("(5) marked 'Not an animal': the heard tile stays and the reference block is gone", !!gone && stillHeard, `block gone: ${!!gone}; heard tile says so: ${stillHeard}`);
  await fx.shot("visit-not-animal");

  // ---- (6) the species changes under a block; an answer that arrives late; how long kept answers live --------------------------------------
  await fx.check("(6) Northern Cardinal's sheet opens", await openSheetByTile("Northern Cardinal"));
  const owner = (code) => fx.page.evaluate(code);
  await pressStart();
  b = await waitBlock((x) => x.phase === "ready");
  await owner(() => { window.__deep(document, "kestrel-reference-sound")[0].species = "Spring Peeper"; });
  b = await waitBlock((x) => x.phase === "idle" && x.hint === "What a Spring Peeper sounds like", { timeout: 3000 });
  await fx.check("(6) another species resets the block to its button: the old chip, player and sound are gone", !!b && !b.player && !b.chip && b.audios === 0 && !!b.start, b ? `${b.phase}; ${b.audios} players` : "still showing the old species");
  await owner(() => { window.__deep(document, "kestrel-reference-sound")[0].species = "Carolina Wren"; });
  await waitBlock((x) => x.hint === "What a Carolina Wren sounds like", { timeout: 3000 });
  const asked = await calls();
  const downloads = soundRequests().length;
  await pressStart();
  await waitBlock((x) => x.phase === "loading", { timeout: 2000 });
  await owner(() => { window.__deep(document, "kestrel-reference-sound")[0].species = "Common Raccoon"; });
  await fx.settle(1600); // the Carolina Wren answer is back by now
  b = await block();
  await fx.check("(6) an answer that arrives after the species changed is ignored: no player for the old species, nothing played", (await calls()) === asked + 1 && b?.phase === "idle" && !b.player && b.hint === "What a Common Raccoon sounds like" && soundRequests().length === downloads, `${b?.phase}; ${b?.hint}; lookups ${await calls()} (was ${asked}); downloads ${soundRequests().length} (was ${downloads})`);
  await pressStart();
  await waitBlock((x) => x.phase === "loading", { timeout: 2000 });
  await owner(() => { const el = window.__deep(document, "kestrel-reference-sound")[0]; window.__removed = el; el.remove(); });
  await fx.settle(1600);
  const late = await fx.page.evaluate(() => window.__removed._phase);
  await fx.check("(6) an answer that arrives after the block was removed is ignored: nothing shown, nothing played", late === "idle" && soundRequests().length === downloads, `${late}; downloads ${soundRequests().length} (was ${downloads})`);

  // Time travel: answers are kept 30 minutes after they were last on screen, and never more than 6 hours after the server gave them.
  await fx.check("(6) Northern Cardinal's sheet opens for the time limits", await openSheetByTile("Northern Cardinal"));
  await owner(() => { const real = Date.now.bind(Date); window.__jump = 0; Date.now = () => real() + window.__jump; });
  const at = (minutes) => owner(`window.__jump = ${minutes} * 60000`);
  const closeSheet = async () => { await fx.key("Escape"); await fx.poll(async () => !(await fx.panel.speciesOpen()) && (await fx.ev((deep) => deep(window.__panelRoot(), "kestrel-species-sheet").length)) === 0, { timeout: 6000 }); };
  const reopen = async () => { await fx.page.locator('button.species-tile[aria-label^="Northern Cardinal."]').first().click({ timeout: 10000 }); await fx.poll(() => fx.panel.speciesOpen(), { timeout: 6000 }); await fx.settle(300); return block(); };
  await pressStart();
  await waitBlock((x) => x.phase === "ready");
  const answered = await calls();
  await at(350); // the sheet stays open for 5 h 50 min, then closes
  await closeSheet();
  await at(358); // 8 minutes later: seen a moment ago, answered 5 h 58 min ago
  b = await reopen();
  await fx.check("(6) seen 8 minutes ago and answered 5 h 58 min ago: the kept answer is shown", b?.phase === "ready" && (await calls()) === answered, `${b?.phase}; lookups ${await calls()}`);
  await closeSheet();
  await at(370); // 12 minutes later: seen a moment ago, but the answer is 6 h 10 min old
  b = await reopen();
  await fx.check("(6) seen 12 minutes ago but answered 6 h 10 min ago: asked again, not reused", b?.phase === "idle" && !!b.start, `${b?.phase}`);
  await pressStart();
  b = await waitBlock((x) => x.phase === "ready");
  await fx.check("(6) pressing asks the server again", (await calls()) === answered + 1 && !!b, `lookups ${await calls()} (was ${answered})`);
  await closeSheet();
  await at(370 + 31);
  b = await reopen();
  await fx.check("(6) 31 minutes after it was last on screen, an answer is forgotten", b?.phase === "idle", `${b?.phase}`);

  // ---- (7) Home Assistant restarts ----------------------------------------------------------------------------------------------------------
  await fx.check("(7) Northern Cardinal's sheet opens before the restart", await openSheet("Northern Cardinal"));
  await pressStart();
  b = await waitBlock((x) => x.phase === "ready");
  const before = epochOf(b?.player?.src);
  await fx.page.evaluate(() => { void window.__ha.restart({ downMs: 1500 }); });
  b = await waitBlock((x) => x.phase === "idle", { timeout: 20000 });
  await fx.check("(7) after the restart the dead links are dropped: the block is back at its button", !!b && !!b.start && !b.player, b ? b.phase : "still showing the old player");
  await fx.settle(500);
  await pressStart();
  b = await waitBlock((x) => x.phase === "ready", { timeout: 10000 });
  await fx.check(`(7) the next press gets links of the new key (e${before} before, e${fx.epoch} now), not the kept ones`, !!b && epochOf(b.player?.src) === fx.epoch && fx.epoch > before, `${b?.player?.src}`);
}, { watchdogSeconds: 420 });
