#!/usr/bin/env node
// Bird recordings: the "Bird recordings" section of Settings.
//   taskset -c 0-4,8-12 nice -n 15 node dev/smoke/fixture-retention.mjs [--size 390x844] [--theme flat-light]
// Needs `node dev/build.mjs` first. Screenshots go to /tmp/kestrel-retention (OUT=... changes it). The numbers come from dev/harness.ts: a 30 GB share with
// 4.2 GB in it, kept for 30 days, 12 recordings kept (`recordings=60|90|space|off|other|full|unknown|fail`, `retentionfail=1`, `admin=0`, `latency=ms` are harness settings).
//   (1) the section: "4.2 GB of 30 GB used · 14% full", the kept line, two controls (a set time / until space runs low; 30, 60, 90 days), the plain words, the small print
//   (2) a longer time saves at once and shows "Saving…" while it does; it is still 60 days when the sheet is closed and opened again
//   (3) a shorter time asks first: how long, what stays, safe answer focused; "Keep recordings" changes nothing; the red button saves it
//   (4) "Until space runs low" saves at once and drops the days control; "For a set time" goes back to the age it had, after a yes
//   (5) a failing save keeps the old choice and says nothing was changed; a non-administrator sees the numbers and disabled controls
//   (6) 92% full: the warning, the integration's refusal of a time limit, and "Until space runs low" asking first
//   (7) nothing removed / a custom rule: neither choice marked; space unreadable: one quiet line; BirdNET-Go not answering: an error with a way to retry
process.env.OUT ??= "/tmp/kestrel-retention";
const { runSmoke } = await import("./lib/fixture.mjs");

const read = (deep) => {
  const box = deep(window.__panelRoot(), "kestrel-recording-retention")[0];
  const root = box?.shadowRoot;
  if (!root) return null;
  const t = (node) => (node?.textContent ?? "").replace(/\s+/g, " ").trim();
  const confirm = root.querySelector(".confirm");
  const state = root.querySelector("kestrel-lu-state");
  const controls = [...root.querySelectorAll("kestrel-lu-segmented")];
  return {
    summary: t(root.querySelector(".summary")),
    unknown: t(root.querySelector(".unknown")),
    kept: t(root.querySelector(".kept")),
    meter: root.querySelector(".meter span") ? { width: root.querySelector(".meter span").style.width, near: root.querySelector(".meter span").classList.contains("near") } : null,
    labels: [...root.querySelectorAll(".label")].map(t),
    controls: controls.map((c) => ({ label: c.label, options: c.options.map((o) => o.label), value: c.value, disabled: c.disabled, cut: [...c.shadowRoot.querySelectorAll(".name")].filter((n) => n.scrollWidth > n.clientWidth).map((n) => n.textContent.trim()) })),
    about: [...root.querySelectorAll(".about")].filter((n) => !n.closest(".confirm")).map(t),
    warning: t(root.querySelector(".warning")),
    problem: t(root.querySelector(".problem")),
    saving: root.querySelector("kestrel-lu-chip")?.label ?? "",
    notes: [...root.querySelectorAll(".note")].map(t).filter(Boolean),
    state: state ? { heading: state.heading ?? "", message: state.message ?? "", kind: state.kind } : null,
    confirm: confirm ? { ask: t(confirm.querySelector(".ask")), about: t(confirm.querySelector(".about")), buttons: [...confirm.querySelectorAll("kestrel-lu-button")].map((b) => b.label), safeFocused: root.activeElement?.classList.contains("keep") === true } : null,
    wider: box.scrollWidth - box.clientWidth,
    overflow: document.documentElement.scrollWidth - innerWidth,
  };
};

await runSmoke("fixture-retention", async (fx) => {
  const until = (test, timeout = 8000) => fx.poll(async () => { const v = await fx.ev(read); return v && test(v) ? v : null; }, { timeout });
  const toSection = async () => { await fx.page.locator("kestrel-recording-retention").first().scrollIntoViewIfNeeded(); await fx.settle(450); };
  // Harness settings stay for the tab (see dev/harness.ts), so each opening says all of them.
  const openSettings = async (changes = {}) => {
    await fx.open(`/kestrel/live?${new URLSearchParams({ admin: "1", retentionfail: "0", recordings: "30", latency: "60", ...changes })}`);
    await fx.page.locator("kestrel-lu-button[label='Settings']").first().click();
    return until((v) => v.summary || v.unknown || v.state?.kind === "error", 12000);
  };
  const choose = (name) => fx.page.locator(`kestrel-recording-retention >> role=radio[name="${name}"]`).click();
  const button = (name) => fx.page.locator(`kestrel-recording-retention >> role=button[name="${name}"]`).click();
  const days = (v) => v?.controls[1]?.value;

  // ---- (1) the section ----------------------------------------------------------------------------------------------------------
  let v = await openSettings({ latency: "500" });
  await toSection();
  v = await fx.ev(read);
  await fx.check("(1) the storage reads '4.2 GB of 30 GB used · 14% full'", v.summary === "4.2 GB of 30 GB used · 14% full", v.summary);
  await fx.check("(1) the meter is 14% long and not in the warning colour", v.meter?.width === "14%" && v.meter.near === false, JSON.stringify(v.meter));
  await fx.check("(1) the kept recordings are counted and called safe", v.kept === "12 recordings you've kept are never removed.", v.kept);
  await fx.check("(1) two controls: a set time (chosen) or until space runs low; then 30, 60, 90 days (30 chosen)", JSON.stringify(v.controls.map((c) => [c.label, c.options, c.value])) === JSON.stringify([["Keep recordings", ["For a set time", "Until space runs low"], "time"], ["For how long", ["30 days", "60 days", "90 days"], "30"]]), JSON.stringify(v.controls));
  await fx.check("(1) no option label is cut off", v.controls.every((c) => c.cut.length === 0), JSON.stringify(v.controls.map((c) => c.cut)));
  await fx.check("(1) the plain words: oldest first, kept recordings never", v.about[0] === "30 days. Recordings older than 30 days are removed, oldest first. Recordings you keep are never removed.", v.about[0]);
  await fx.check("(1) the guard is explained under a time limit", /^If the storage reaches 90% full, Kestrel switches to “Until space runs low” by itself/.test(v.about[1] ?? ""), v.about[1]);
  await fx.check("(1) the small print says how often it tidies up", v.notes.join(" | ") === "BirdNET-Go tidies up every 15 minutes and always leaves at least 10 recordings of each species.", v.notes.join(" | "));
  await fx.check("(1) nothing to flag: no warning, error, question or saving chip", !v.warning && !v.problem && !v.saving && !v.confirm, JSON.stringify([v.warning, v.problem, v.saving, v.confirm]));
  await fx.check("(1) nothing sticks out sideways", v.wider <= 0 && v.overflow <= 0, `${v.wider}px / ${v.overflow}px`);
  await fx.shot("section");

  // ---- (2) a longer time saves at once ------------------------------------------------------------------------------------------
  await choose("60 days");
  v = await until((now) => now.saving);
  await fx.check("(2) 'Saving…' shows while it saves, and both controls wait", v?.saving === "Saving…" && v.controls.every((c) => c.disabled) && days(v) === "60", JSON.stringify([v?.saving, v?.controls.map((c) => c.disabled), days(v)]));
  await toSection();
  await fx.shot("saving");
  v = await until((now) => !now.saving);
  await fx.check("(2) a longer time asks nothing: 60 days now, the words follow", !v.confirm && days(v) === "60" && v.about[0].startsWith("60 days. Recordings older than 60 days are removed, oldest first."), `${days(v)} / ${v.about[0]}`);
  await fx.key("Escape");
  await fx.page.locator("kestrel-lu-button[label='Settings']").first().click();
  v = await until((now) => now.summary && days(now) === "60");
  await fx.check("(2) closed and opened again, it still says 60 days (read back from the server)", days(v) === "60", String(days(v)));

  // ---- (3) a shorter time asks first --------------------------------------------------------------------------------------------
  await choose("30 days");
  v = await until((now) => now.confirm);
  await fx.check("(3) it asks how long, and what stays", v?.confirm?.ask === "Remove recordings older than 30 days?" && /^BirdNET-Go starts within 15 minutes, oldest first\. Recordings you keep are never removed\. Removed recordings can't be brought back\.$/.test(v.confirm.about), v?.confirm?.ask);
  await fx.check("(3) the buttons say what they do, and the safe answer has the focus", JSON.stringify(v.confirm.buttons) === JSON.stringify(["Remove older recordings", "Keep recordings"]) && v.confirm.safeFocused, JSON.stringify([v.confirm.buttons, v.confirm.safeFocused]));
  await fx.check("(3) nothing changed yet: still 60 days", days(v) === "60" && !v.saving, String(days(v)));
  await toSection();
  await fx.shot("confirm");
  await button("Keep recordings");
  v = await until((now) => !now.confirm);
  await fx.check("(3) Keep recordings changes nothing", days(v) === "60" && !v.problem, String(days(v)));
  await choose("30 days");
  await until((now) => now.confirm);
  await button("Remove older recordings");
  v = await until((now) => !now.confirm && !now.saving && days(now) === "30");
  await fx.check("(3) the red button saves it: 30 days, the question gone", !!v && days(v) === "30", String(days(v)));

  // ---- (4) until space runs low -------------------------------------------------------------------------------------------------
  await choose("Until space runs low");
  v = await until((now) => now.controls.length === 1 && !now.saving);
  await fx.check("(4) it saves at once (the storage has room) and the days control goes", !!v && !v.confirm && v.controls[0].value === "space", JSON.stringify(v?.controls.map((c) => c.value)));
  await fx.check("(4) the words say what it does, with no guard note", !!v && v.about.length === 1 && /^Until space runs low\. Recordings stay as long as there is room\. Once the storage is 85% full, the oldest are removed first, until it is below that again\. Recordings you keep are never removed\.$/.test(v.about[0]), JSON.stringify(v?.about));
  await toSection();
  await fx.shot("space");
  await choose("For a set time");
  v = await until((now) => now.confirm);
  await fx.check("(4) going back to a set time asks first (it can remove what 'until space runs low' kept)", v?.confirm?.ask === "Remove recordings older than 30 days?", v?.confirm?.ask);
  await button("Remove older recordings");
  v = await until((now) => now.controls.length === 2 && !now.saving && !now.confirm);
  await fx.check("(4) back on a set time, at the age it had", !!v && v.controls[0].value === "time" && days(v) === "30", JSON.stringify(v?.controls.map((c) => c.value)));

  // ---- (5) a failing save, and someone who may not change it -------------------------------------------------------------------
  v = await openSettings({ retentionfail: "1" });
  await choose("60 days");
  v = await until((now) => now.problem);
  await fx.check("(5) a failing save says why and that nothing was changed, and the old choice stays", v?.problem === "BirdNET-Go did not keep the change. Nothing was changed." && days(v) === "30" && !v.saving && v.controls.every((c) => !c.disabled), `${v?.problem} / ${days(v)}`);
  await toSection();
  await fx.shot("error");
  v = await openSettings({ admin: "0" });
  await fx.check("(5) a non-administrator sees the numbers and the choice, can't change it, and is told so", v.summary === "4.2 GB of 30 GB used · 14% full" && v.controls.every((c) => c.disabled) && v.notes.includes("Only a Home Assistant administrator can change this."), JSON.stringify([v.controls.map((c) => c.disabled), v.notes]));

  // ---- (6) nearly full -----------------------------------------------------------------------------------------------------------
  v = await openSettings({ recordings: "full" });
  await toSection();
  v = await fx.ev(read);
  await fx.check("(6) 92% full: the meter is in the warning colour and says so", v.summary === "27.6 GB of 30 GB used · 92% full" && v.meter?.near === true && v.meter.width === "92%", JSON.stringify([v.summary, v.meter]));
  await fx.check("(6) under a time limit the warning says Kestrel switches by itself, and replaces the general note", v.warning === "The storage is 92% full. Kestrel switches to “Until space runs low” as soon as it next checks." && v.about.length === 1, `${v.warning} / ${v.about.length} notes`);
  await fx.shot("full");
  await choose("60 days");
  v = await until((now) => now.problem);
  await fx.check("(6) a time limit is refused with the integration's sentence, and nothing changed", v?.problem === "The recording storage is 92% full, so a time limit can't be set right now. Choose Until space runs low first, then a time limit once there is room. Nothing was changed." && days(v) === "30", v?.problem);
  await choose("Until space runs low");
  v = await until((now) => now.confirm);
  await fx.check("(6) 'Until space runs low' asks first, because the storage is already past its limit", /^Remove the oldest recordings\?$/.test(v?.confirm?.ask ?? "") && /^The storage is 92% full\. BirdNET-Go starts within 15 minutes and removes the oldest recordings until it is below 85%\./.test(v.confirm.about), JSON.stringify([v?.confirm?.ask, v?.confirm?.about]));
  await button("Remove oldest recordings");
  v = await until((now) => now.controls.length === 1 && !now.saving);
  await fx.check("(6) saved: the warning now says the oldest go first and kept ones stay", v?.controls[0].value === "space" && v.warning === "The storage is 92% full. BirdNET-Go removes the oldest recordings first, but never ones you've kept.", `${v?.controls[0].value} / ${v?.warning}`);

  // ---- (7) other settings, and trouble ------------------------------------------------------------------------------------------
  for (const [setting, lead] of [["off", "Nothing is removed."], ["other", "Custom."]]) {
    v = await openSettings({ recordings: setting });
    await fx.check(`(7) recordings=${setting}: neither way is marked, no days control, and the words say so`, v.controls.length === 1 && v.controls[0].value === "" && v.about[0].startsWith(`${lead} `), JSON.stringify([v.controls.map((c) => c.value), v.about[0]]));
    if (setting === "off") { await toSection(); await fx.shot("off"); }
  }
  v = await openSettings({ recordings: "unknown" });
  await fx.check("(7) space that can't be read: one quiet line, no meter, the choice still works", v.unknown === "Kestrel can't tell how much storage the recordings use right now." && !v.summary && !v.meter && v.controls.length === 2 && v.controls.every((c) => !c.disabled), JSON.stringify([v.unknown, v.meter]));
  v = await openSettings({ recordings: "fail" });
  await fx.check("(7) BirdNET-Go not answering: an error that says so, with a way to retry", v.state?.kind === "error" && v.state.heading === "Couldn't read the recording settings" && v.state.message === "Kestrel couldn't reach BirdNET-Go." && v.controls.length === 0, JSON.stringify(v.state));
  await toSection();
  await fx.shot("unreachable");
});
