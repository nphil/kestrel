"""Build the local/seasonal prior: how common each species is around Atlanta, week by week.

Merlin only shows birds that are likely at your place *and date*. This builds the same
kind of table for Kestrel: for every species near home, how common it is in each of the
year's 48 "quarter-months" (days 1-7, 8-14, 15-21 and 22-end of each month -- the exact
columns of an eBird bar chart, so eBird data can drop straight into the same file).

Default source (no login, no key): iNaturalist research-grade observations in Fulton and
DeKalb counties, GA, 2016-2025, from the same API species.py already uses. Per species
we ask iNaturalist for a day-by-day histogram, fold it into the 48 quarter-months, and
divide by everything seen in the same group (all birds, all mammals, ...) in that
quarter-month, so a wet week with more photographers does not look like "more birds".
iNaturalist is photo-based: showy daytime birds are over-counted, secretive and night
birds under-counted. Treat the numbers as "how likely is this species to be around",
not a census.

Optional source: eBird bar-chart TSVs (--ebird-tsv, one per county). eBird login and the
bar-chart page sit behind a bot check this script does not try to get around -- download
the TSVs by hand from ebird.org/barchart (US-GA-121 and US-GA-089) and pass them in.
When given they replace the iNaturalist numbers for birds (checklist frequency, merged
across counties weighted by sample size); everything else still comes from iNaturalist.

Output: species/atlanta-weekly.json
  {"version", "generated", "source", "region", "years", "binning",
   "effort": {group: [48 obs counts]},          # how much data each quarter-month has
   "species": {<scientific name>: {
        "common": ..., "group": "Birds"|"Mammals"|"Amphibians"|"Reptiles",
        "obs": total observations behind it,
        "share": [48],       # fraction of the group's observations this species makes up
        "commonness": [48]   # 0..1 rank among the species present that quarter-month;
                             # 0 = not seen then, ~1 = among the most common
        ["always": true]     # domestic cat/dog: present all year, no prior to learn
   }}}
Bin index = (month - 1) * 4 + min((day - 1) // 7, 3); index 0 is Jan 1-7.

    python3 build/seasonal.py                       # from classifier/ ; ~10 min the first time
    python3 build/seasonal.py --ebird-tsv a.tsv b.tsv

Responses are cached under data/inat-weekly-cache so a rerun (or a retry after a rate
limit) only asks for what is missing.
"""
from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

INAT_API = "https://api.inaturalist.org/v1"
USER_AGENT = "wildlife-classifier/1.0 (personal home camera project)"
# iNaturalist place ids: Fulton County GA, DeKalb County GA (eBird: US-GA-121, US-GA-089).
PLACES = "690,686"
GROUPS = {"Birds": 3, "Mammals": 40151, "Amphibians": 20978, "Reptiles": 26036}
ALWAYS = {"Felis catus": "Mammals", "Canis familiaris": "Mammals"}
BINS = 48
REQUEST_GAP = 1.1  # iNaturalist asks for <= 1 request/second

HERE = Path(__file__).resolve().parent
CLASSIFIER = HERE.parent


def bin_of(month: int, day: int) -> int:
    return (month - 1) * 4 + min((day - 1) // 7, 3)


class Inat:
    def __init__(self, cache_dir: Path):
        self.cache_dir = cache_dir
        cache_dir.mkdir(parents=True, exist_ok=True)
        self.last = 0.0

    def get(self, path: str, **params) -> dict:
        query = urllib.parse.urlencode(sorted(params.items()))
        url = f"{INAT_API}/{path}?{query}"
        cache = self.cache_dir / (hashlib.sha1(url.encode()).hexdigest()[:20] + ".json")
        if cache.exists():
            return json.loads(cache.read_text())
        for attempt in range(6):
            wait = REQUEST_GAP - (time.monotonic() - self.last)
            if wait > 0:
                time.sleep(wait)
            self.last = time.monotonic()
            try:
                req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
                body = json.load(urllib.request.urlopen(req, timeout=60))
                cache.write_text(json.dumps(body))
                return body
            except urllib.error.HTTPError as e:
                if e.code not in (429, 500, 502, 503, 504) or attempt == 5:
                    raise
                time.sleep(15 * (attempt + 1))
            except urllib.error.URLError:
                if attempt == 5:
                    raise
                time.sleep(5 * (attempt + 1))
        raise RuntimeError("unreachable")

    def common(self, **extra) -> dict:
        return dict(place_id=PLACES, quality_grade="research", captive="false", **extra)

    def species_counts(self, taxon_id: int, d1: str, d2: str) -> list[dict]:
        rows: list[dict] = []
        page = 1
        while True:
            body = self.get("observations/species_counts", **self.common(
                taxon_id=taxon_id, d1=d1, d2=d2, per_page=500, page=page))
            rows += body["results"]
            if not body["results"] or len(rows) >= body["total_results"]:
                return rows
            page += 1

    def day_histogram(self, taxon_id: int, d1: str, d2: str) -> list[int]:
        """Observations per quarter-month, summed over every year in d1..d2."""
        body = self.get("observations/histogram", **self.common(
            taxon_id=taxon_id, d1=d1, d2=d2, interval="day", date_field="observed"))
        bins = [0] * BINS
        for day, count in body["results"]["day"].items():
            y, m, d = day.split("-")
            bins[bin_of(int(m), int(d))] += count
        return bins

    def lookup_taxon(self, scientific: str) -> dict | None:
        body = self.get("taxa", q=scientific, rank="species", per_page=5)
        for t in body["results"]:
            if t["name"].lower() == scientific.lower():
                return t
        return None


def smooth(values: list[float]) -> list[float]:
    """[1,2,1]/4 kernel around the year: one lucky or missing week should not decide a prior."""
    n = len(values)
    return [(values[i - 1] + 2 * values[i] + values[(i + 1) % n]) / 4 for i in range(n)]


def commonness_table(shares: dict[str, list[float]]) -> dict[str, list[float]]:
    """Per quarter-month, each present species' rank among the present species (0 for absent)."""
    out = {name: [0.0] * BINS for name in shares}
    for b in range(BINS):
        present = sorted((s[b], name) for name, s in shares.items() if s[b] > 0)
        # Tied shares get the same (highest) rank so equal species read equally common.
        i = 0
        while i < len(present):
            j = i
            while j + 1 < len(present) and present[j + 1][0] == present[i][0]:
                j += 1
            for k in range(i, j + 1):
                out[present[k][1]][b] = (j + 1) / len(present)
            i = j + 1
    return out


def read_ebird_tsv(path: Path) -> tuple[list[float], dict[str, tuple[str, list[float]]]]:
    """-> (sample size per quarter-month, {scientific name: (common name, frequency 0..1)}).

    eBird's bar-chart TSV: a 'Sample Size:' row with 48 numbers, then one row per species
    with the name and 48 frequencies. The name cell reads either 'Common Name (Genus species)'
    or 'Common Name<TAB>Genus species', so the scientific name is whatever binomial trails it.
    """
    sample: list[float] = []
    species: dict[str, tuple[str, list[float]]] = {}
    for raw in path.read_text(encoding="utf-8-sig").splitlines():
        cells = raw.rstrip("\n").split("\t")
        if cells[0].strip().lower().startswith("sample size"):
            sample = [float(c) for c in cells[1:] if c.strip()][:BINS]
            continue
        try:
            freq = [float(c) for c in cells[-BINS:]]
        except ValueError:
            continue  # title, month-header and blank lines
        label = " ".join(c.strip() for c in cells[:-BINS] if c.strip())
        m = re.search(r"\(?([A-Z][a-z]+ [a-z-]+)\)?\s*$", label)
        if not m:
            continue
        sci = m.group(1)
        species[sci] = (label[:m.start()].strip().rstrip("(").strip() or sci, freq)
    if len(sample) != BINS:
        raise SystemExit(f"{path}: no 48-column 'Sample Size:' row found")
    return sample, species


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--first-year", type=int, default=2016)
    ap.add_argument("--last-year", type=int, default=datetime.date.today().year - 1,
                    help="last full year (a half-finished year would skew the seasons)")
    ap.add_argument("--min-obs", type=int, default=3,
                    help="drop species with fewer research-grade sightings than this")
    ap.add_argument("--atlanta", type=Path, default=CLASSIFIER / "species/atlanta.json",
                    help="classifier classes; these are always kept")
    ap.add_argument("--ebird-tsv", type=Path, nargs="*", default=[],
                    help="eBird bar-chart TSVs (one per county) to use for birds")
    ap.add_argument("--cache-dir", type=Path, default=CLASSIFIER / "data/inat-weekly-cache")
    ap.add_argument("--out", type=Path, default=CLASSIFIER / "species/atlanta-weekly.json")
    args = ap.parse_args()

    d1, d2 = f"{args.first_year}-01-01", f"{args.last_year}-12-31"
    inat = Inat(args.cache_dir)
    local = {r["scientific"]: r for r in json.loads(args.atlanta.read_text())}

    # 1. Which species, and their iNaturalist taxon ids.
    taxa: dict[str, dict] = {}  # scientific -> {id, common, group, obs}
    for group, taxon_id in GROUPS.items():
        for row in inat.species_counts(taxon_id, d1, d2):
            t = row["taxon"]
            if t.get("rank") != "species":
                continue
            sci = t["name"]
            if row["count"] >= args.min_obs or sci in local:
                taxa[sci] = {"id": t["id"], "group": group, "obs": row["count"],
                             "common": t.get("preferred_common_name") or local.get(sci, {}).get("label") or sci}
    for sci, row in local.items():
        if sci in taxa or sci in ALWAYS:
            continue
        t = inat.lookup_taxon(sci)
        if t is None:
            raise SystemExit(f"{sci}: not found on iNaturalist; fix the name in {args.atlanta}")
        taxa[sci] = {"id": t["id"], "group": row["group"], "obs": 0, "common": row.get("label") or sci}
    print(f"{len(taxa)} species to chart")

    # 2. Effort per group per quarter-month, then each species' histogram.
    effort = {g: inat.day_histogram(tid, d1, d2) for g, tid in GROUPS.items()}
    counts: dict[str, list[int]] = {}
    for i, (sci, t) in enumerate(sorted(taxa.items()), 1):
        counts[sci] = inat.day_histogram(t["id"], d1, d2)
        if i % 50 == 0:
            print(f"  {i}/{len(taxa)} histograms")

    # 3. Shares: smoothed species count / smoothed group effort.
    smooth_effort = {g: smooth([float(x) for x in e]) for g, e in effort.items()}
    shares: dict[str, list[float]] = {}
    for sci, c in counts.items():
        eff = smooth_effort[taxa[sci]["group"]]
        shares[sci] = [n / e if e else 0.0 for n, e in zip(smooth([float(x) for x in c]), eff)]

    # 4. eBird, if supplied: bird shares become checklist frequency merged by sample size.
    source = f"iNaturalist research-grade observations, {args.first_year}-{args.last_year}"
    if args.ebird_tsv:
        files = [read_ebird_tsv(p) for p in args.ebird_tsv]
        total = [sum(f[0][b] for f in files) for b in range(BINS)]
        merged: dict[str, tuple[str, list[float]]] = {}
        for sample, sp in files:
            for sci, (common, freq) in sp.items():
                have = merged.setdefault(sci, (common, [0.0] * BINS))[1]
                for b in range(BINS):
                    have[b] += freq[b] * sample[b] / total[b] if total[b] else 0.0
        matched = 0
        for sci, (common, freq) in merged.items():
            if sci in shares and taxa[sci]["group"] == "Birds":
                shares[sci] = smooth(freq)
                matched += 1
        for sci in shares:  # birds eBird has never seen here are not 'present'
            if taxa[sci]["group"] == "Birds" and sci not in merged:
                shares[sci] = [0.0] * BINS
        effort["Birds"] = [int(x) for x in total]
        source = (f"eBird bar-chart frequency ({len(files)} county file(s), weighted by sample size) "
                  f"for birds; {source} for the rest")
        print(f"eBird: {matched} birds matched of {len(merged)} in the TSV(s)")

    # 5. Commonness is ranked inside each group so mammals are not compared with birds.
    commonness: dict[str, list[float]] = {}
    for group in GROUPS:
        commonness.update(commonness_table({s: v for s, v in shares.items() if taxa[s]["group"] == group}))

    species: dict[str, dict] = {}
    for sci in sorted(taxa):
        t = taxa[sci]
        species[sci] = {"common": t["common"], "group": t["group"], "obs": sum(counts[sci]),
                        "share": [round(x, 6) for x in shares[sci]],
                        "commonness": [round(x, 3) for x in commonness[sci]]}
    for sci, group in ALWAYS.items():
        if sci in local:
            species[sci] = {"common": local[sci].get("label") or sci, "group": group, "obs": 0,
                            "share": [0.0] * BINS, "commonness": [1.0] * BINS, "always": True}

    out = {"version": 1, "generated": datetime.date.today().isoformat(), "source": source,
           "region": {"name": "Fulton + DeKalb counties, Georgia (Atlanta)",
                      "inatPlaceIds": PLACES.split(","), "ebird": ["US-GA-121", "US-GA-089"]},
           "years": [args.first_year, args.last_year],
           "binning": "48 quarter-months: index = (month-1)*4 + min((day-1)//7, 3); 0 = Jan 1-7",
           "effort": effort, "species": species}
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(out, separators=(",", ":")) + "\n")
    print(f"wrote {args.out}: {len(species)} species, {args.out.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
