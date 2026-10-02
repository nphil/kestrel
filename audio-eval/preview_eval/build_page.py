"""Generate /tmp/bsnd/site/index.html (static, phone-friendly, Lucent tokens + Rose Pine palette). Scratch code."""
import json
import pathlib
import statistics

ROOT = pathlib.Path("/tmp/bsnd")
SITE = ROOT / "site"
DL = pathlib.Path("/data/agent/managed-skills/design-language")
tokens = (DL / "languages/lucent/tokens.css").read_text()
palette = (DL / "palettes/rose-pine/palette.css").read_text()
fonts = (ROOT / "site-src/fonts.css").read_text()
data = json.loads((SITE / "data.json").read_text())
rows = json.loads((ROOT / "results/seg_metrics.json").read_text())
picks = json.loads((ROOT / "results/seg_picks.json").read_text())
tim = json.loads((ROOT / "results/seg_timing.json").read_text())
prox = json.loads((ROOT / "proxmox-cpu-timing.json").read_text())

GROUPS = {
    "Great Horned Owl": "low", "Barred Owl": "low", "Eastern Screech-Owl": "low", "Coyote": "low", "American Bullfrog": "low",
    "Spring Peeper": "small", "Eastern Chipmunk": "small", "Eastern Gray Squirrel": "small",
}
for c in data:
    c["group"] = GROUPS.get(c["species"], "bird")
order = {"low": 0, "small": 1, "bird": 2}
data.sort(key=lambda c: (order[c["group"]], c["species"], c["name"]))

LEG = {
    "A": ("Whole clip, just louder", "All 15 seconds as the camera heard them, only made louder. The shaded part is the moment Perch matched; the purple curve is how sure Perch was."),
    "B": ("Matched moment, just louder", "Only the moment Perch matched, trimmed and made loud enough to hear. Nothing is removed, so this is the safe fallback."),
    "C": ("Hiss reduction", "The steady background hiss is turned down. The strength is the strongest one that Perch still agrees leaves the animal intact."),
    "D": ("AI separation", "Google's bird-separation AI splits the moment into tracks. The animal's track stays and the others are turned down as far as Perch allows."),
    "E": ("AI + hiss, maximum clean-up", "AI separation plus a hiss pass. The cleanest background, but it usually costs the animal some of its sound."),
}

by = {}
for r in rows:
    by.setdefault(r["name"], {})[r["cand"]] = r
names = [c["name"] for c in data]
N = len(names)
perch_orig = statistics.mean(by[n]["orig"]["perch_raw_level"] for n in names)
seg_len = statistics.mean(c["s1"] - c["s0"] for c in data)
gpu4 = tim["gpu4_summary"]["steady_wall_median_s"]
gpu8 = tim["gpu8_summary"]["steady_wall_median_s"]
gate_cpu = statistics.median(v["G07"] for v in tim["cpu"].values() if "G07" in v)
cpu16 = prox["settings"]["a"]["median_wall_s"] * seg_len / 15
cpu4 = prox["settings"]["c"]["median_wall_s"] * seg_len / 15


def show(letter):
    out = []
    for n in names:
        p = picks[n]
        cid = p[letter]
        out.append((by[n][cid], bool(p[f"{letter}_ok"])))
    return out


def tr(letter, perch, dropped, supp, time_txt, where):
    return (f"<tr><th scope='row'><span class='badge'>{letter}</span> {LEG[letter][0]}</th><td>{perch}</td><td>{dropped}</td><td>{supp}</td><td>{time_txt}</td><td>{where}</td></tr>")


tbl = [tr("A", "\u2014", "\u2014", "0 dB", "instant", "anywhere"),
       tr("B", f"{perch_orig:.2f} (reference)", "\u2014", "0 dB", "instant", "anywhere")]
cell = {}
for letter, time_txt, where in (
    ("C", f"{gate_cpu:.2f} s on one CPU core", "anywhere, the HA VM is fine"),
    ("D", f"{gpu4:.2f} s on the P40 (+0.7 GB), or about {cpu16:.0f}\u2013{cpu4:.0f} s on a CPU*", "GPU on demand, or a CPU box"),
    ("E", f"{gpu4 + gate_cpu:.2f} s on the P40, or about {cpu16 + gate_cpu:.0f}\u2013{cpu4 + gate_cpu:.0f} s on a CPU*", "GPU on demand, or a CPU box"),
):
    s_ = show(letter)
    perch = statistics.mean(r["perch_raw_level"] for r, _ in s_)
    dropped = sum(1 for _, ok in s_ if not ok)
    supp = statistics.mean(r["quiet_suppression_db"] for r, _ in s_)
    cell[letter] = (perch, dropped, supp)
    tbl.append(tr(letter, f"{perch:.2f}", f"{dropped} of {N}", f"\u2212{supp:.0f} dB", time_txt, where))

proc = [n for n in names if picks[n]["auto_letter"] != "B"]
auto_perch = statistics.mean((by[n][picks[n]["auto"]] if picks[n]["auto"] != "orig" else by[n]["orig"])["perch_raw_level"] for n in names)
auto_supp = statistics.mean(by[n][picks[n]["auto"]]["quiet_suppression_db"] for n in proc) if proc else 0.0
tbl.append(
    f"<tr><th scope='row'><span class='badge'>\u2605</span> Automatic pick</th><td>{auto_perch:.2f}</td><td>0 of {N}</td>"
    f"<td>\u2212{auto_supp:.0f} dB on the {len(proc)} clips it cleaned; the other {N - len(proc)} stay as B</td>"
    f"<td>one clean-up try + about 0.9 s per Perch check (on a CPU)</td><td>GPU on demand + a Perch check</td></tr>"
)

TEMPLATE = (ROOT / "site-src/template.html").read_text()
html = (TEMPLATE
        .replace("/*__FONTS__*/", fonts)
        .replace("/*__PALETTE__*/", palette)
        .replace("/*__TOKENS__*/", tokens)
        .replace("__DATA__", json.dumps(data, separators=(",", ":")))
        .replace("__LEGEND__", json.dumps({k: {"name": v[0], "desc": v[1]} for k, v in LEG.items()}))
        .replace("__TABLE__", "\n".join(tbl))
        .replace("__RAWPERCH__", f"{perch_orig:.2f}")
        .replace("__NCLIPS__", str(N)))
html = html.replace("</details>\n</div>", f"<p class='note'>* CPU time estimated from a measured 15 s clip on the Proxmox Ryzen (about 9 s with 16 threads, 11 s with 4), scaled to the average preview length of {seg_len:.1f} s. P40 times are FP32 (TensorFlow's default, the right precision for a P40), measured with the model held to 1.5 GB of GPU memory. The star row is what an automatic checker would send: it tries the settings in C, D and E and keeps the cleanest one that Perch still scores as high as the untouched moment, both at the original volume and at the loud preview volume, and only if it gains at least 3 dB of clarity.</p></details>\n</div>", 1)
(SITE / "index.html").write_text(html, encoding="utf-8")
print("wrote index.html", len(html) // 1024, "KB;", N, "clips; table cells", {k: tuple(round(x, 2) for x in v) for k, v in cell.items()})
