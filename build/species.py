"""Pick the classes the wildlife model keeps.

The EVA-02 iNat21 model knows 10,000 species worldwide. A camera in one yard only
ever sees a few hundred of them, and every extra class is another chance to pick a
look-alike from the wrong continent. This keeps the birds and mammals that
iNaturalist has research-grade sightings of near home, plus domestic cats and
dogs (iNaturalist does not count pets as wild sightings, but they are the most
common animals on a house's cameras).

Output: species/<name>.json -- [{"index": <iNat21 class id>, "label": <common
name>, "scientific": ..., "group": "Birds"|"Mammals", "local_obs": n}, ...],
sorted by class id. The export step reads it to cut the model's head down.
"""
from __future__ import annotations

import argparse
import json
import time
import urllib.request
from pathlib import Path

INAT_API = "https://api.inaturalist.org/v1/observations/species_counts"
TAXA = {"Birds": 3, "Mammals": 40151}
ALWAYS_KEEP = ("Felis catus", "Canis familiaris")
USER_AGENT = "wildlife-classifier/1.0 (personal home camera project)"


def species_counts(lat: float, lng: float, radius_km: int, taxon_id: int) -> list[dict]:
    results: list[dict] = []
    page = 1
    while True:
        url = (f"{INAT_API}?lat={lat}&lng={lng}&radius={radius_km}&taxon_id={taxon_id}"
               f"&quality_grade=research&per_page=500&page={page}")
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        body = json.load(urllib.request.urlopen(req, timeout=60))
        results += body["results"]
        if not body["results"] or len(results) >= body["total_results"]:
            return results
        page += 1
        time.sleep(1.5)  # iNaturalist asks for <= 1 request/second


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--lat", type=float, required=True)
    ap.add_argument("--lng", type=float, required=True)
    ap.add_argument("--radius-km", type=int, default=50)
    ap.add_argument("--min-obs", type=int, default=3,
                    help="drop species with fewer research-grade sightings than this (rarities)")
    ap.add_argument("--categories", type=Path, default=Path("data/inat21_categories.json"))
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args()

    categories = {c["name"]: c for c in json.loads(args.categories.read_text())}
    keep: dict[int, dict] = {}
    for group, taxon_id in TAXA.items():
        for row in species_counts(args.lat, args.lng, args.radius_km, taxon_id):
            cat = categories.get(row["taxon"]["name"])
            if cat is None or row["count"] < args.min_obs:
                continue
            keep[cat["id"]] = {"index": cat["id"], "label": cat["common_name"], "scientific": cat["name"],
                               "group": group, "local_obs": row["count"]}
    for name in ALWAYS_KEEP:
        cat = categories[name]
        keep.setdefault(cat["id"], {"index": cat["id"], "label": cat["common_name"], "scientific": name,
                                    "group": "Mammals", "local_obs": 0})

    rows = sorted(keep.values(), key=lambda r: r["index"])
    labels = [r["label"] for r in rows]
    dupes = {l for l in labels if labels.count(l) > 1}
    for r in rows:  # two species sharing a common name would be indistinguishable in Scrypted
        if r["label"] in dupes:
            r["label"] = f"{r['label']} ({r['scientific']})"

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(rows, indent=1) + "\n")
    by_group = {g: sum(1 for r in rows if r["group"] == g) for g in TAXA}
    print(f"wrote {args.out}: {len(rows)} classes {by_group}")


if __name__ == "__main__":
    main()
