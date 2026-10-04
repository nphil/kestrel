#!/usr/bin/env node
// Who took a reference photo: the one caption line under it, on the species sheet and on the heard-visit page.
//   taskset -c 0-4,8-12 nice -n 15 node dev/smoke/fixture-photo-credit.mjs [--size 390x844] [--theme flat-light]
// Needs `node dev/build.mjs` first. Screenshots go to /tmp/kestrel-photo-credit (OUT=... changes it). The fixture server answers the signed
// `reference-info/<slug>` links (dev/serve.mjs): Common Raccoon -> iNaturalist credit, Blue Jay -> Wikipedia (no photographer), House Finch -> 204,
// Tufted Titmouse -> 500.
//   (1) Common Raccoon and Blue Jay: the exact caption text, the source name is a link (new tab, noopener noreferrer), polite status, directly under the
//       picture, not cut off, nothing sideways; the "Reference photo" chip is where and what it was
//   (2) House Finch (204) and Tufted Titmouse (500): no caption and no space kept for one, chip unchanged, no console error; a species with a photo of
//       its own (Northern Cardinal): no chip, no caption, nothing asked
//   (3) the species changes under the open sheet: the caption goes at once, the next one arrives, and an answer that is late for the first species
//       is ignored; coming back to a species asks nothing again
//   (4) the heard visit page (Common Raccoon): the same caption under the hero picture
process.env.OUT ??= "/tmp/kestrel-photo-credit";
const { runSmoke, MEDIA_PATH } = await import("./lib/fixture.mjs");

const RACCOON = "Photo · Jane Birder · CC BY-NC · iNaturalist";
const BLUE_JAY = "Photo · CC BY-SA 4.0 · Wikipedia";
const sheetUrl = (name) => `/kestrel/wildlife?s=${encodeURIComponent(name)}`;

/** The species sheet's picture, chip and caption: what they say and where they are. Text is whitespace-normalised. */
const readSheet = (deep) => {
  const host = deep(document, "kestrel-species-sheet")[0];
  const sheet = host?.shadowRoot;
  const photo = sheet?.querySelector(".photo");
  if (!photo) return null;
  const rect = (el) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height }; };
  const image = photo.querySelector("kestrel-lu-image");
  const caption = photo.querySelector(".credit");
  const chip = photo.querySelector("kestrel-lu-chip.chip");
  const link = caption?.querySelector("a") ?? null;
  const style = caption ? getComputedStyle(caption) : null;
  return {
    species: host.species?.species ?? "",
    photo: rect(photo), image: rect(image), hero: rect(sheet.querySelector(".hero")),
    chip: chip ? { label: chip.getAttribute("label"), ...rect(chip) } : null,
    caption: caption ? {
      text: caption.textContent.replace(/\s+/g, " ").trim(), role: caption.getAttribute("role"), tag: caption.tagName, ...rect(caption),
      clipped: caption.scrollWidth > caption.clientWidth + 1, overflow: style.overflow, wrap: style.overflowWrap, color: style.color, size: style.fontSize, lineHeight: style.lineHeight,
      link: link ? { text: link.textContent, href: link.getAttribute("href"), target: link.getAttribute("target"), rel: link.getAttribute("rel") } : null,
      links: caption.querySelectorAll("a").length,
    } : null,
    captions: sheet.querySelectorAll(".credit").length,
    pageOverflow: document.documentElement.scrollWidth - innerWidth,
    viewport: { w: innerWidth, h: innerHeight },
  };
};

/** The visit page's hero picture, chip and caption. */
const readVisit = (deep) => {
  const root = window.__panelRoot();
  const hero = deep(root, ".visit-hero")[0];
  if (!hero) return null;
  const media = hero.querySelector(".hero-media");
  const rect = (el) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height }; };
  const image = media.querySelector("kestrel-lu-image");
  const caption = hero.querySelector(".credit");
  const chip = hero.querySelector("kestrel-lu-chip.snapshot-chip");
  const link = caption?.querySelector("a") ?? null;
  return {
    hero: rect(hero), image: image ? rect(image) : null, chip: chip ? chip.getAttribute("label") : null,
    caption: caption ? { text: caption.textContent.replace(/\s+/g, " ").trim(), role: caption.getAttribute("role"), inMedia: media.contains(caption), clipped: caption.scrollWidth > caption.clientWidth + 1, ...rect(caption), link: link ? { href: link.getAttribute("href"), target: link.getAttribute("target"), rel: link.getAttribute("rel") } : null } : null,
    pageOverflow: document.documentElement.scrollWidth - innerWidth,
  };
};

await runSmoke("fixture-photo-credit", async (fx) => {
  const infoRequests = (slug) => fx.media.log.filter((entry) => entry.path === `reference-info/${slug}`);
  const sheet = () => fx.ev(readSheet);
  const waitSheet = (test, timeout = 6000) => fx.poll(async () => { const s = await sheet(); return s && test(s) ? s : null; }, { timeout, every: 60 });
  /** The sheet is open and its picture has been laid out (the enter motion is over). */
  const openSheet = async (name) => {
    await fx.open(sheetUrl(name));
    const shown = await waitSheet((s) => s.species === name && s.image.width > 0);
    await fx.settle(500);
    return shown;
  };
  /** Changes the species under the open sheet, the way Back or a link does: the address changes and the panel is told. */
  const switchTo = (name) => fx.page.evaluate((to) => { history.pushState(null, "", `/kestrel/wildlife?s=${encodeURIComponent(to)}`); window.dispatchEvent(new Event("location-changed")); }, name);
  const layout = async (label, s) => {
    const c = s.caption;
    await fx.check(`${label}: the caption is not cut off, wraps long words and the page does not scroll sideways`, !c.clipped && c.wrap === "anywhere" && s.pageOverflow <= 0 && c.left >= s.hero.left - 0.5 && c.right <= s.hero.right + 0.5 && c.left >= 0 && c.right <= s.viewport.w, `clipped ${c.clipped}; wrap ${c.wrap}; page ${s.pageOverflow}; caption ${Math.round(c.left)}..${Math.round(c.right)} in hero ${Math.round(s.hero.left)}..${Math.round(s.hero.right)}`);
    await fx.check(`${label}: it sits directly under the picture, inside its column, a small gap below`, c.top >= s.image.bottom - 0.5 && c.top - s.image.bottom <= 12 && s.photo.bottom >= c.bottom - 0.5 && c.width <= s.photo.width + 0.5, `gap ${(c.top - s.image.bottom).toFixed(1)}px; photo ${Math.round(s.photo.width)}px wide, caption ${Math.round(c.width)}px`);
    await fx.check(`${label}: caption type is the small caption size, muted ink, not bold`, parseFloat(c.size) <= 14 && c.color !== "rgba(0, 0, 0, 0)", `${c.size} / ${c.color}`);
  };
  const chipUnchanged = (label, s) => fx.check(`${label}: the 'Reference photo' chip is unchanged (same label, top right of the picture)`, s.chip?.label === "Reference photo" && s.chip.top >= s.image.top - 0.5 && s.chip.top - s.image.top < 24 && s.chip.right <= s.image.right + 0.5 && s.image.right - s.chip.right < 24, JSON.stringify(s.chip));

  // ---- (1) Common Raccoon: an iNaturalist credit, with a link ---------------------------------------------------------------------------------
  let s = await openSheet("Common Raccoon");
  await fx.check("(1) Common Raccoon's sheet opens", !!s, s ? `${Math.round(s.image.width)}x${Math.round(s.image.height)} picture` : "never opened");
  s = await waitSheet((x) => x.caption !== null);
  await fx.check("(1) Common Raccoon: the caption arrives, in a <p> with the polite 'status' role", !!s && s.caption.tag === "P" && s.caption.role === "status", s ? `${s.caption.tag} role=${s.caption.role}` : "no caption");
  await fx.check("(1) Common Raccoon: the caption reads exactly 'Photo · Jane Birder · CC BY-NC · iNaturalist'", s?.caption.text === RACCOON, s?.caption.text);
  await fx.check("(1) Common Raccoon: only the source name is a link: iNaturalist's photo page, new tab, noopener noreferrer", s?.caption.links === 1 && s.caption.link.text === "iNaturalist" && s.caption.link.href === "https://www.inaturalist.org/photos/123" && s.caption.link.target === "_blank" && /\bnoopener\b/.test(s.caption.link.rel) && /\bnoreferrer\b/.test(s.caption.link.rel), JSON.stringify(s?.caption.link));
  await fx.check("(1) Common Raccoon: exactly one caption", s?.captions === 1, `${s?.captions}`);
  await layout("(1) Common Raccoon", s);
  await chipUnchanged("(1) Common Raccoon", s);
  await fx.check("(1) Common Raccoon: the credit was asked for once, with the signed link", infoRequests("common-raccoon").length === 1 && infoRequests("common-raccoon")[0].status === 200, JSON.stringify(infoRequests("common-raccoon")));
  await fx.shot("sheet-raccoon");

  // ---- (3, first half) the species changes under the open sheet: the caption goes at once ---------------------------------------------------------
  await switchTo("House Finch");
  const gone = await fx.poll(async () => { const x = await sheet(); return x && x.species === "House Finch" ? x : null; }, { timeout: 4000, every: 20 });
  await fx.check("(3) switching to House Finch: the sheet changes species and Raccoon's caption is gone with it", !!gone && gone.caption === null && gone.captions === 0, gone ? `species ${gone.species}; caption ${gone.caption?.text}` : "sheet did not change");
  await fx.settle(500);
  const afterFinch = await sheet();
  await fx.check("(3) House Finch: still no caption a moment later (a 204 shows nothing), chip unchanged", afterFinch.caption === null && afterFinch.chip?.label === "Reference photo", `${afterFinch.caption?.text} / ${afterFinch.chip?.label}`);
  await switchTo("Blue Jay");
  s = await waitSheet((x) => x.species === "Blue Jay" && x.caption !== null);
  await fx.check("(3) switching to Blue Jay: its own caption arrives", s?.caption.text === BLUE_JAY, s?.caption?.text ?? "no caption");
  await switchTo("Common Raccoon");
  s = await waitSheet((x) => x.species === "Common Raccoon" && x.caption !== null);
  await fx.check("(3) coming back to Common Raccoon: its caption again, and nothing was asked a second time", s?.caption.text === RACCOON && infoRequests("common-raccoon").length === 1 && infoRequests("blue-jay").length === 1, `raccoon asked ${infoRequests("common-raccoon").length}x, blue jay ${infoRequests("blue-jay").length}x`);

  // ---- (1) Blue Jay: a Wikipedia credit without a photographer ------------------------------------------------------------------------------------
  s = await openSheet("Blue Jay");
  s = await waitSheet((x) => x.caption !== null);
  await fx.check("(1) Blue Jay: the caption reads exactly 'Photo · CC BY-SA 4.0 · Wikipedia' (no empty part, no stray separator)", s?.caption.text === BLUE_JAY, s?.caption.text);
  await fx.check("(1) Blue Jay: 'Wikipedia' links to the Blue jay article, new tab, noopener noreferrer", s?.caption.links === 1 && s.caption.link.text === "Wikipedia" && s.caption.link.href === "https://en.wikipedia.org/wiki/Blue_jay" && s.caption.link.target === "_blank" && /\bnoopener\b/.test(s.caption.link.rel) && /\bnoreferrer\b/.test(s.caption.link.rel), JSON.stringify(s?.caption.link));
  await layout("(1) Blue Jay", s);
  await chipUnchanged("(1) Blue Jay", s);
  await fx.shot("sheet-blue-jay");

  // ---- (2) nothing known (204) and a failing server (500): nothing shown, no space kept ---------------------------------------------------------
  for (const [name, slug, status] of [["House Finch", "house-finch", 204], ["Tufted Titmouse", "tufted-titmouse", 500]]) {
    s = await openSheet(name);
    const asked = await fx.poll(() => infoRequests(slug).length > 0 ? infoRequests(slug) : null, { timeout: 4000 });
    await fx.settle(600);
    s = await sheet();
    await fx.check(`(2) ${name}: the server was asked and said ${status}`, !!asked && asked[0].status === status, JSON.stringify(asked));
    await fx.check(`(2) ${name}: no caption at all, and no space kept for one under the picture`, s.caption === null && s.captions === 0 && Math.abs(s.photo.height - s.image.height) < 1, `captions ${s.captions}; photo ${s.photo.height.toFixed(1)}px, picture ${s.image.height.toFixed(1)}px`);
    await chipUnchanged(`(2) ${name}`, s);
    await fx.shot(`sheet-${slug}`);
  }
  await fx.check("(2) the 500 answer left no console error behind", fx.errors.length === 0, fx.errors.join(" | ") || "none");

  // ---- (2) a species with a photo of its own: no chip, no caption, nothing asked -----------------------------------------------------------------
  const before = fx.media.log.filter((entry) => entry.path.startsWith("reference-info/")).length;
  s = await openSheet("Northern Cardinal");
  await fx.settle(600);
  s = await sheet();
  await fx.check("(2) Northern Cardinal (own photo): no chip, no caption, and no credit was asked for", s.chip === null && s.caption === null && fx.media.log.filter((entry) => entry.path.startsWith("reference-info/")).length === before, `chip ${s.chip?.label}; caption ${s.caption?.text}`);

  // ---- (3, second half) an answer that is late for the first species is ignored --------------------------------------------------------------------
  await fx.page.route(`**${MEDIA_PATH}reference-info/common-raccoon*`, async (route) => { await new Promise((done) => setTimeout(done, 1800)); await route.fallback(); });
  await openSheet("Common Raccoon");
  await switchTo("Blue Jay");
  s = await waitSheet((x) => x.species === "Blue Jay" && x.caption !== null);
  await fx.check("(3) Blue Jay's caption shows while Raccoon's answer is still on its way", s?.caption.text === BLUE_JAY, s?.caption?.text ?? "no caption");
  await fx.settle(2600); // the slow answer for Raccoon lands now
  s = await sheet();
  await fx.check("(3) the late answer for Common Raccoon changed nothing: still Blue Jay's caption", s.species === "Blue Jay" && s.caption?.text === BLUE_JAY && s.captions === 1, `${s.species}: ${s.caption?.text}`);
  await fx.page.unroute(`**${MEDIA_PATH}reference-info/common-raccoon*`);

  // ---- (4) the heard visit page --------------------------------------------------------------------------------------------------------------
  await fx.open("/kestrel/visit?v=fixture-heard-1");
  const visit = await fx.poll(async () => { const v = await fx.ev(readVisit); return v?.caption ? v : null; }, { timeout: 8000 });
  await fx.check("(4) the heard visit page shows the same caption under the hero picture", visit?.caption.text === RACCOON && visit.caption.role === "status" && visit.caption.inMedia && visit.caption.top >= visit.image.bottom - 0.5 && visit.caption.top - visit.image.bottom <= 12, visit ? `${visit.caption.text}; gap ${(visit.caption.top - visit.image.bottom).toFixed(1)}px` : "no caption");
  await fx.check("(4) visit page: the link is iNaturalist's photo page, new tab, noopener noreferrer", visit?.caption.link?.href === "https://www.inaturalist.org/photos/123" && visit.caption.link.target === "_blank" && /noopener/.test(visit.caption.link.rel) && /noreferrer/.test(visit.caption.link.rel), JSON.stringify(visit?.caption.link));
  await fx.check("(4) visit page: chip 'Reference photo' as before, caption not cut off, nothing sideways", visit?.chip === "Reference photo" && !visit.caption.clipped && visit.pageOverflow <= 0 && visit.caption.left >= visit.hero.left - 0.5 && visit.caption.right <= visit.hero.right + 0.5, `chip ${visit?.chip}; clipped ${visit?.caption.clipped}; page ${visit?.pageOverflow}`);
  await fx.shot("visit-raccoon");
}, { watchdogSeconds: 240 });
