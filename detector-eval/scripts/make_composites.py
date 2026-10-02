#!/usr/bin/env python3
"""Composite generator: paste ONE real animal cut-out (data/cutouts/) into a real empty camera frame.

The pasted animal appears only in the test frame (default t02.jpg); ref.jpg and all other frames stay clean.
Size, placement and look follow scripts/composite_config.json (see its _doc): regions per camera, perspective
sizes, bucket coverage (<32, 32-64, 64-128, 128-256, >=256 px longest side of the animal in the SAVED image).

  python scripts/make_composites.py --cams 88,103,104,106 --per-scene 1 --seed 1
  python scripts/make_composites.py --cams 106 --live106 --live-n 60 --seed 2
  python scripts/make_composites.py --cams 103 --preview          # draws the placement regions on a frame

Re-running with the same seed + inputs reproduces the same composites (existing ones are overwritten).
Output: data/composites/<id>.jpg and data/composites/index.jsonl (one line per composite).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
CFG_PATH = Path(__file__).with_name("composite_config.json")
LAT, LON = 33.75, -84.39  # Atlanta


# ---------------------------------------------------------------- helpers
def rng_for(*parts) -> np.random.Generator:
    h = hashlib.sha256("|".join(map(str, parts)).encode()).digest()
    return np.random.default_rng(int.from_bytes(h[:8], "little"))


def sun_times(epoch_ms: int):
    """(sunrise, sunset) epoch seconds UTC for the local date of epoch_ms (NOAA low-precision formula)."""
    t = epoch_ms / 1000.0
    d = datetime.fromtimestamp(t - 4 * 3600, timezone.utc)  # local date (EDT/EST approximated by -4h; fine for +-1h)
    n = d.timetuple().tm_yday
    g = 2 * math.pi / 365 * (n - 1)
    eqt = 229.18 * (0.000075 + 0.001868 * math.cos(g) - 0.032077 * math.sin(g) - 0.014615 * math.cos(2 * g) - 0.040849 * math.sin(2 * g))
    decl = 0.006918 - 0.399912 * math.cos(g) + 0.070257 * math.sin(g) - 0.006758 * math.cos(2 * g) + 0.000907 * math.sin(2 * g)
    lat = math.radians(LAT)
    ha = math.degrees(math.acos(math.cos(math.radians(90.833)) / (math.cos(lat) * math.cos(decl)) - math.tan(lat) * math.tan(decl)))
    day0 = datetime(d.year, d.month, d.day, tzinfo=timezone.utc).timestamp()
    rise = day0 + (720 - 4 * (LON + ha) - eqt) * 60
    sett = day0 + (720 - 4 * (LON - ha) - eqt) * 60
    return rise, sett


def period_of(epoch_ms: int) -> str:
    rise, sett = sun_times(epoch_ms)
    t = epoch_ms / 1000.0
    if rise + 1800 <= t <= sett - 2400:
        return "day"
    if rise - 1800 <= t < rise + 1800 or sett - 2400 < t <= sett + 1800:
        return "dusk"
    return "night"


def is_ir(img_bgr: np.ndarray) -> bool:
    hsv = cv2.cvtColor(cv2.resize(img_bgr, (160, 90), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2HSV)
    return float(hsv[..., 1].mean()) < 22.0  # 0-255 scale


def bucket_of(px: float, cfg) -> str:
    b = cfg["buckets"]
    for i, (lo, hi) in enumerate(b):
        if px < hi or i == len(b) - 1:
            return cfg["bucket_names"][i]
    return cfg["bucket_names"][-1]


def luma(rgb):
    return rgb[..., 0] * 0.299 + rgb[..., 1] * 0.587 + rgb[..., 2] * 0.114


def measure_noise(gray: np.ndarray) -> float:
    """sigma of the sensor/codec noise in flat areas of the frame (16x16 blocks, flattest 15 %)."""
    g = gray.astype(np.float32)
    res = g - cv2.GaussianBlur(g, (0, 0), 1.2)
    sm = cv2.GaussianBlur(g, (0, 0), 3)
    h, w = g.shape
    bh, bw = h // 16, w // 16
    res_b = res[:bh * 16, :bw * 16].reshape(bh, 16, bw, 16)
    sm_b = sm[:bh * 16, :bw * 16].reshape(bh, 16, bw, 16)
    flat = sm_b.std(axis=(1, 3)).ravel()
    rs = res_b.std(axis=(1, 3)).ravel()
    idx = np.argsort(flat)[: max(8, int(0.15 * flat.size))]
    return float(np.median(rs[idx]))


def poly_scan(poly, y):
    """x-intervals of polygon at scanline y."""
    xs = []
    n = len(poly)
    for i in range(n):
        (x0, y0), (x1, y1) = poly[i], poly[(i + 1) % n]
        if (y0 <= y < y1) or (y1 <= y < y0):
            xs.append(x0 + (y - y0) / (y1 - y0) * (x1 - x0))
    xs.sort()
    return [(xs[i], xs[i + 1]) for i in range(0, len(xs) - 1, 2)]


# ---------------------------------------------------------------- placement
class Library:
    def __init__(self, cfg):
        self.cfg = cfg
        self.rows = [json.loads(l) for l in (DATA / "cutouts" / "index.jsonl").read_text().splitlines() if l.strip()]
        self.uses = {r["id"]: 0 for r in self.rows}
        self._img = {}

    def load(self, cid):
        if cid not in self._img:
            im = cv2.imread(str(DATA / "cutouts" / f"{cid}.png"), cv2.IMREAD_UNCHANGED)
            self._img[cid] = cv2.cvtColor(im, cv2.COLOR_BGRA2RGBA)
            if len(self._img) > 60:
                self._img.pop(next(iter(self._img)))
        return self._img[cid]


def u_at(reg, y_norm):
    ys = [p[1] for p in reg["poly"]]
    y0, y1 = min(ys), max(ys)
    t = 0.0 if y1 == y0 else (y_norm - y0) / (y1 - y0)
    return reg["u_top"] + (reg["u_bot"] - reg["u_top"]) * min(max(t, 0), 1)


def y_for_u(reg, u):
    ys = [p[1] for p in reg["poly"]]
    y0, y1 = min(ys), max(ys)
    if reg["u_bot"] == reg["u_top"]:
        return None
    t = (u - reg["u_top"]) / (reg["u_bot"] - reg["u_top"])
    return y0 + min(max(t, 0), 1) * (y1 - y0)


def choose(cfg, cam_cfg, lib: Library, bucket_i, group, size_px, W, H, rng, only_region=None):
    """pick (cutout, region, anchor) consistent with size/perspective. returns None if infeasible."""
    slack = cfg["slack"]
    cands = []
    for c in lib.rows:
        if c["group"] != group:
            continue
        flying = c.get("pose", "std") == "fly"
        cm = cfg["body_cm"].get(c["species"])
        if cm is None:
            continue
        need_u = size_px * 50.0 / cm
        for reg in cam_cfg["regions"]:
            if only_region and reg["name"] != only_region:
                continue
            w = reg["weights"].get(group, 0.0)
            if w <= 0 or flying != (reg["kind"] == "air"):
                continue
            if reg.get("max_cm") and cm > reg["max_cm"]:
                continue
            if size_px > reg.get("max_px", 1e9) or size_px < reg.get("min_px", 0):
                continue
            if reg["kind"] == "ground" and group == "bird" and c["species"] in cfg["not_on_ground"]:
                continue
            umin, umax = sorted((reg["u_top"], reg["u_bot"]))
            if need_u < umin / slack or need_u > umax * slack:
                continue
            cands.append((c, reg, w / (1.0 + lib.uses[c["id"]]) * (c["quality"] / 3.0)))
    if not cands:
        return None
    wts = np.array([x[2] for x in cands]); wts /= wts.sum()
    for _ in range(30):
        c, reg, _w = cands[rng.choice(len(cands), p=wts)]
        cm = cfg["body_cm"][c["species"]]
        need_u = size_px * 50.0 / cm
        yn = y_for_u(reg, need_u)
        ys = [p[1] for p in reg["poly"]]
        if yn is None:
            yn = rng.uniform(min(ys), max(ys))
        else:  # +-12 % jitter in u = jitter in y, clamped to polygon
            span = (max(ys) - min(ys))
            yn = float(np.clip(yn + rng.normal(0, 0.12 * span), min(ys) + 1e-4, max(ys) - 1e-4))
        iv = poly_scan(reg["poly"], yn)
        if not iv:
            continue
        a, b = iv[rng.integers(len(iv))]
        xn = rng.uniform(a, b)
        ax, ay = xn * W, yn * H
        half = size_px * 0.5
        if reg["kind"] == "perch":  # a perched animal stays on its ledge: keep the whole body over the interval
            lo_x, hi_x = a * W + half, b * W - half
            ax = rng.uniform(lo_x, hi_x) if hi_x > lo_x else (a + b) * 0.5 * W
        ax = float(np.clip(ax, half + 2, W - half - 2))
        # keep inside frame vertically (anchor = feet): top = ay - h >= 2
        if ay > H - 2 or ay - size_px < 2 * 0 - size_px * 0.6:
            continue
        bad = False
        for ex in cam_cfg.get("exclude", []):
            if ax + half > ex[0] * W and ax - half < ex[2] * W and ay > ex[1] * H and ay - size_px < ex[3] * H:
                bad = True
        if bad:
            continue
        return c, reg, ax, ay
    return None


# ---------------------------------------------------------------- rendering
def resize_premult(rgba: np.ndarray, tw: int, th: int):
    rgb = rgba[..., :3].astype(np.float32)
    a = rgba[..., 3].astype(np.float32) / 255.0
    pm = rgb * a[..., None]
    interp = cv2.INTER_AREA if tw < rgba.shape[1] else cv2.INTER_CUBIC
    pm = cv2.resize(pm, (tw, th), interpolation=interp)
    a = cv2.resize(a, (tw, th), interpolation=interp)
    a = np.clip(a, 0, 1)
    rgb = np.where(a[..., None] > 1e-3, pm / np.maximum(a[..., None], 1e-3), 0.0)
    return np.clip(rgb, 0, 255), a


def bars_mask(base_rgb: np.ndarray, box_norm, ir: bool):
    """thin dark/bright vertical bars (deck balusters) in the box of the real frame -> float mask 0..1."""
    H, W = base_rgb.shape[:2]
    x0, y0, x1, y1 = int(box_norm[0] * W), int(box_norm[1] * H), int(box_norm[2] * W), int(box_norm[3] * H)
    g = luma(base_rgb[y0:y1, x0:x1]).astype(np.float32)
    med = cv2.blur(g, (61, 1))
    # balusters are darker and warmer (brown) than the lawn behind; use colour when available
    rgb = base_rgb[y0:y1, x0:x1].astype(np.float32)
    medrgb = cv2.blur(rgb, (61, 1))
    d = (medrgb - rgb).sum(axis=2) / 3.0  # positive where the pixel is darker than its row neighbourhood
    m = (d > 14).astype(np.uint8)
    if not ir:
        warm = (rgb[..., 0] - rgb[..., 2] > 12).astype(np.uint8)
        m = m & warm | ((d > 30).astype(np.uint8) & warm)
    # keep only long vertical runs
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (3, 45)))
    m = cv2.dilate(m, np.ones((3, 3), np.uint8))
    out = np.zeros((H, W), np.float32)
    out[y0:y1, x0:x1] = cv2.GaussianBlur(m.astype(np.float32), (0, 0), 0.8)
    return out


def render(base_rgb, cut_rgba, S, ax, ay, flip, period, ir, reg, look, noise_sigma, rng, occ_mask=None, tweak=None, u_local=100.0):
    """returns (out_rgb float, box[x,y,w,h] of alpha>0.5, info dict) or None."""
    H, W = base_rgb.shape[:2]
    if flip:
        cut_rgba = cut_rgba[:, ::-1]
    ch, cw = cut_rgba.shape[:2]
    f = S / max(cw, ch)
    tw, th = max(3, int(round(cw * f))), max(3, int(round(ch * f)))
    rgb, a = resize_premult(np.ascontiguousarray(cut_rgba), tw, th)
    # --- edge clean-up: erode a touch (kills photo-background fringe) then feather
    er = float(np.clip(S / 160.0, 0.0, 1.6))
    if er > 0.3:
        a = np.clip((cv2.GaussianBlur(a, (0, 0), er * 0.8) - 0.5 * er * 0.35) / (1 - 0.5 * er * 0.35), 0, 1) if er < 0.6 else \
            cv2.erode(a, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)), iterations=1 if er < 1.2 else 2)
    feather = float(np.clip(0.5 + S / 250.0, 0.6, 1.3))
    a = cv2.GaussianBlur(a, (0, 0), feather)
    # --- placement (feet = bottom centre)
    x0, y0 = int(round(ax - tw / 2)), int(round(ay - th))
    x0 = int(np.clip(x0, 0, W - tw)); y0 = int(max(y0, 0)); 
    if y0 + th > H:
        y0 = H - th
    # --- local background statistics
    pad = int(max(8, 0.35 * S))
    X0, Y0, X1, Y1 = max(x0 - pad, 0), max(y0 - pad, 0), min(x0 + tw + pad, W), min(y0 + th + pad, H)
    patch = base_rgb[Y0:Y1, X0:X1]
    inner = np.zeros(patch.shape[:2], bool)
    inner[y0 - Y0:y0 - Y0 + th, x0 - X0:x0 - X0 + tw] = True
    ring = patch[~inner] if (~inner).sum() > 20 else patch.reshape(-1, 3)
    bg_rgb = ring.mean(axis=0)
    bg_lum = float(luma(bg_rgb))
    # --- photometric match
    w_ = a / max(a.sum(), 1e-6)
    cut_lum = float((luma(rgb) * w_).sum())
    gain = (max(bg_lum, 8.0) / max(cut_lum, 8.0)) ** 0.5 * rng.uniform(0.88, 1.12)
    # the animal must not end up far brighter than the place it stands on (washed-out look) nor vanish
    gain = min(gain, max(bg_lum, 8.0) * 1.15 / max(cut_lum, 8.0))
    gain = max(gain, max(bg_lum, 8.0) * 0.35 / max(cut_lum, 8.0))
    if tweak and "gain" in tweak:
        gain = tweak["gain"]
    gain = float(np.clip(gain, 0.35, 2.6))
    rgb = rgb * gain
    mean_rgb = (rgb * w_[..., None]).sum(axis=(0, 1))
    if ir:
        g = luma(rgb)
        g = (g - g.mean()) * 1.15 + g.mean()
        # IR: animals reflect the illuminator, usually brighter than the ambient background nearby
        cur = float((g * w_).sum())
        # ...and the closer the animal (bigger u), the more IR light it gets: dark mulch must not make it invisible
        target = max(max(bg_lum, 12.0) * rng.uniform(0.9, 1.7), min(170.0, 32.0 + 0.4 * u_local) * rng.uniform(0.8, 1.15))
        g = g * (min(target, 235.0) / max(cur, 1.0))
        g = 240.0 * np.tanh(g / 240.0)  # soft shoulder: no blown-out white blob
        tint = bg_rgb / max(bg_lum, 1.0)
        rgb = g[..., None] * (0.5 * tint + 0.5)
    else:
        gl = luma(rgb)[..., None]
        # photos are punchier than a surveillance sensor; and a dim / washed-out scene has little colour to share
        mx, mn = ring.max(axis=1), ring.min(axis=1)
        bg_sat = float(np.mean((mx - mn) / np.maximum(mx, 1.0)))
        rgb = gl + (rgb - gl) * rng.uniform(0.78, 0.92) * float(np.clip(bg_sat / 0.28, 0.3, 1.0))
        cast = (bg_rgb / max(bg_lum, 1.0))
        cast = cast / max(cast.mean(), 1e-3)
        rgb = rgb * (cast ** 0.55)
    # ambient occlusion: the underside is a little darker than the back
    yy = np.linspace(0, 1, th, dtype=np.float32)[:, None, None]
    rgb = rgb * (1 - 0.14 * np.clip((yy - 0.6) / 0.4, 0, 1))
    # haze for far animals: lose contrast towards the local background
    haze = float(np.clip(0.28 * (1 - math.log(max(S, 10) / 10) / math.log(60)), 0, 0.28))
    rgb = rgb * (1 - haze) + bg_rgb * haze
    rgb = np.clip(rgb, 0, 255)
    # --- layer in full-frame coordinates (small canvas around the animal)
    m = 3 * int(math.ceil(look["blur_sigma"] * 2)) + 2
    cx0, cy0 = max(x0 - m - int(0.35 * tw), 0), max(y0 - m, 0)
    cx1, cy1 = min(x0 + tw + m + int(0.35 * tw), W), min(y0 + th + m + int(0.3 * th) + 4, H)
    cw_, ch_ = cx1 - cx0, cy1 - cy0
    layer = np.zeros((ch_, cw_, 3), np.float32); la = np.zeros((ch_, cw_), np.float32)
    layer[y0 - cy0:y0 - cy0 + th, x0 - cx0:x0 - cx0 + tw] = rgb * a[..., None]
    la[y0 - cy0:y0 - cy0 + th, x0 - cx0:x0 - cx0 + tw] = a
    # --- soften like the camera (animal + alpha, premultiplied)
    sigma = look["blur_sigma"] * rng.uniform(0.85, 1.2) + (0.35 if period == "night" else 0.0)
    mblur = 0.0
    if rng.random() < (0.08 if period == "day" else 0.35):
        mblur = float(np.clip(S * rng.uniform(0.01, 0.025), 0, 9))  # slight horizontal smear (long exposure)
    if mblur >= 1.5:
        k = int(mblur) | 1
        kern = np.zeros((1, k), np.float32); kern[0, :] = 1.0 / k
        layer = cv2.filter2D(layer, -1, kern); la = cv2.filter2D(la, -1, kern)
    layer = cv2.GaussianBlur(layer, (0, 0), sigma); la = cv2.GaussianBlur(la, (0, 0), sigma)
    # --- contact shadow (ground animals)
    out = base_rgb.copy()
    shadow_op = 0.0
    if reg["kind"] == "ground" and not (tweak and tweak.get("no_shadow")):
        shadow_op = float(rng.uniform(0.22, 0.38) if (period == "day" and not ir) else rng.uniform(0.12, 0.22))
        # soft elliptical contact shadow under the feet; width follows the lower body, no hard rectangle
        low = (a[int(th * 0.45):] > 0.35)
        body_w = float(np.clip(low.any(axis=0).sum(), 1, tw)) if low.size else tw
        sw = int(max(6, body_w * 1.15))
        sh_h = int(max(3, min(th * 0.16, sw * 0.22)))
        pad_ = int(max(3, sh_h))
        sil = np.zeros((sh_h + 2 * pad_, sw + 2 * pad_), np.float32)
        cv2.ellipse(sil, (sil.shape[1] // 2, sil.shape[0] // 2), (sw // 2, max(1, sh_h // 2)), 0, 0, 360, 1.0, -1)
        sil = cv2.GaussianBlur(sil, (0, 0), max(0.8, 0.35 * sh_h))
        sw_, sh_ = sil.shape[1], sil.shape[0]
        cxm = x0 + tw // 2 + int(rng.uniform(-0.1, 0.1) * tw)
        sx = cxm - sw_ // 2
        sy = y0 + th - sh_ // 2
        sx0, sy0 = max(sx, 0), max(sy, 0)
        sx1, sy1 = min(sx + sw_, W), min(sy + sh_, H)
        if sx1 > sx0 and sy1 > sy0:
            sub = sil[sy0 - sy:sy1 - sy, sx0 - sx:sx1 - sx]
            out[sy0:sy1, sx0:sx1] *= (1 - shadow_op * sub)[..., None]
    # --- composite
    a_eff = la
    if occ_mask is not None:
        a_eff = la * (1 - occ_mask[cy0:cy1, cx0:cx1])
        layer = layer * (1 - occ_mask[cy0:cy1, cx0:cx1])[..., None]
    reg_out = out[cy0:cy1, cx0:cx1]
    reg_out[:] = reg_out * (1 - a_eff)[..., None] + layer
    # --- sensor / codec noise on the animal (the real background already carries its own)
    ns = noise_sigma * look.get("noise_gain", 1.0) * rng.uniform(0.8, 1.1)
    nz = rng.normal(0, 1, (ch_, cw_)).astype(np.float32) * ns
    nz = cv2.GaussianBlur(nz, (0, 0), 0.6) * 1.6  # codec noise is spatially correlated
    chroma = rng.normal(0, 1, (ch_, cw_, 3)).astype(np.float32) * ns * (0.0 if ir else 0.35)
    reg_out += (nz[..., None] + chroma) * np.clip(a_eff * 1.5, 0, 1)[..., None]
    # --- JPEG patch re-encode at the camera's quality, blended only around the animal
    w_mask = cv2.GaussianBlur(cv2.dilate((a_eff > 0.02).astype(np.uint8), np.ones((5, 5), np.uint8)).astype(np.float32), (0, 0), 2.0)
    px0, py0 = cx0 // 16 * 16, cy0 // 16 * 16
    px1, py1 = min(-(-cx1 // 16) * 16, W), min(-(-cy1 // 16) * 16, H)
    pr = np.clip(out[py0:py1, px0:px1], 0, 255).astype(np.uint8)
    q = int(np.clip(look["jpeg_q"] + rng.integers(-6, 7), 30, 95))
    ok, enc = cv2.imencode(".jpg", cv2.cvtColor(pr, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, q])
    dec = cv2.cvtColor(cv2.imdecode(enc, cv2.IMREAD_COLOR), cv2.COLOR_BGR2RGB).astype(np.float32)
    wfull = np.zeros(pr.shape[:2], np.float32)
    wfull[cy0 - py0:cy1 - py0, cx0 - px0:cx1 - px0] = w_mask
    out[py0:py1, px0:px1] = out[py0:py1, px0:px1] * (1 - wfull[..., None]) + dec * wfull[..., None]
    # --- ground truth box (alpha>0.5, after blur + occlusion)
    full_a = np.zeros((H, W), np.float32); full_a[cy0:cy1, cx0:cx1] = a_eff
    ys, xs = np.where(full_a > 0.5)
    if xs.size < 6:
        return None
    box = [int(xs.min()), int(ys.min()), int(xs.max() - xs.min() + 1), int(ys.max() - ys.min() + 1)]
    vis_frac = float((a_eff > 0.5).sum() / max((la > 0.5).sum(), 1))
    info = {"jpeg_q": q, "blur_sigma": round(float(sigma), 2), "motion_blur_px": round(mblur, 1), "noise_sigma": round(float(ns), 2),
            "gain": round(gain, 2), "haze": round(haze, 2), "shadow": round(shadow_op, 2), "flip": bool(flip),
            "bg_lum": round(bg_lum, 1), "visible_frac": round(vis_frac, 2), "gray": bool(ir)}
    return np.clip(out, 0, 255), box, info


# ---------------------------------------------------------------- scene sources
def scene_sources(args, cams):
    """yield dicts: cam, scene_id, source, base_path, ref_path, epoch_ms, period, ir, tags"""
    out = []
    idx_files = sorted((DATA / "scenes").glob("index*.jsonl"))
    if idx_files and not args.live_only and not args.image:
        seen = set()
        for line in "\n".join(f.read_text() for f in idx_files).splitlines():
            if not line.strip():
                continue
            try:
                s = json.loads(line)
            except json.JSONDecodeError:
                continue
            if s["camera"] not in cams or s["scene_id"] in seen or s.get("animal_present"):
                continue
            seen.add(s["scene_id"])
            d = DATA / "scenes" / s["camera"] / s["scene_id"]
            base = d / f"{args.base}.jpg"
            if not base.exists():
                continue
            out.append({"cam": s["camera"], "scene_id": s["scene_id"], "source": s.get("source", "nvr"), "base": base,
                        "ref": d / "ref.jpg", "epoch_ms": s["epoch_ms"], "period": s["period"], "ir": bool(s["ir"]),
                        "tags": s.get("tags", [])})
    for spec in args.image:  # ad hoc frames: CAM=path/to/frame.jpg (ref = the same frame)
        cam, _, path = spec.partition("=")
        p = Path(path)
        im = cv2.imread(str(p))
        ts = int(p.stat().st_mtime * 1000)
        out.append({"cam": cam, "scene_id": f"{cam}_adhoc_{p.stem}", "source": "adhoc", "base": p, "ref": p, "epoch_ms": ts,
                    "period": args.period or period_of(ts), "ir": is_ir(im), "tags": ["adhoc"]})
    if args.live106 and "106" in cams:
        files = sorted((DATA / "live" / "106").glob("*/*.jpg"), key=lambda p: int(p.stem))
        files = files[: max(0, len(files))]
        # skip the newest file (may still be written)
        files = files[:-1]
        rng = rng_for("live106", args.seed)
        picks = list(range(1, len(files)))
        rng.shuffle(picks)
        for i in sorted(picks[: args.live_n]):
            p = files[i]
            ts = int(p.stem)
            prev = files[i - 1]
            ref = prev if 3000 <= ts - int(prev.stem) <= 120000 else p
            im = cv2.imread(str(p))
            if im is None:
                continue
            out.append({"cam": "106", "scene_id": f"106_live_{ts}", "source": "live", "base": p, "ref": ref, "epoch_ms": ts,
                        "period": period_of(ts), "ir": is_ir(im), "tags": ["live"]})
    return out


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--cams", default="88,103,104,106")
    ap.add_argument("--per-scene", type=int, default=1)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--base", default="t02", help="test frame that receives the animal (t00..t04)")
    ap.add_argument("--live106", action="store_true", help="also use live 106 frames from data/live/106/")
    ap.add_argument("--live-only", action="store_true", help="only live 106 frames, ignore data/scenes")
    ap.add_argument("--live-n", type=int, default=40, help="how many live 106 frames to use")
    ap.add_argument("--image", action="append", default=[], help="ad hoc frame CAM=path (testing)")
    ap.add_argument("--period", choices=["day", "dusk", "night"], help="override period for --image frames")
    ap.add_argument("--region", help="debug: only this region name")
    ap.add_argument("--periods", help="only scenes of these periods, e.g. night,dusk")
    ap.add_argument("--ir", choices=["yes", "no"], help="only IR (gray night vision) or only colour scenes")
    ap.add_argument("--max-scenes", type=int, default=0, help="limit scenes per camera (0 = all)")
    ap.add_argument("--group", choices=["both", "bird", "mammal"], default="both")
    ap.add_argument("--out", default=str(DATA / "composites"))
    ap.add_argument("--preview", action="store_true", help="draw the placement regions on a frame per camera and exit")
    ap.add_argument("--append", action="store_true", help="keep existing index.jsonl lines (default: rewrite)")
    args = ap.parse_args()

    cfg = json.loads(CFG_PATH.read_text())
    cams = [c.strip() for c in args.cams.split(",") if c.strip()]
    outdir = Path(args.out); outdir.mkdir(parents=True, exist_ok=True)
    sources = scene_sources(args, cams)
    if args.periods:
        sources = [s for s in sources if s["period"] in args.periods.split(",")]
    if args.ir:
        sources = [s for s in sources if s["ir"] == (args.ir == "yes")]
    if args.max_scenes:
        cnt = {}
        keep = []
        for s in sources:
            cnt[s["cam"]] = cnt.get(s["cam"], 0) + 1
            if cnt[s["cam"]] <= args.max_scenes:
                keep.append(s)
        sources = keep

    if args.preview:
        for cam in cams:
            ss = [s for s in sources if s["cam"] == cam]
            probe = DATA / "probe" / f"{cam}_main.jpg"
            src = ss[0]["base"] if ss else probe
            im = cv2.imread(str(src)); H, W = im.shape[:2]
            for reg in cfg["cameras"][cam]["regions"]:
                pts = np.array([[p[0] * W, p[1] * H] for p in reg["poly"]], np.int32)
                cv2.polylines(im, [pts], True, (0, 0, 255) if reg["kind"] == "ground" else (255, 128, 0), max(2, W // 640))
                cv2.putText(im, reg["name"], tuple(pts[0]), cv2.FONT_HERSHEY_SIMPLEX, W / 1500, (255, 255, 0), max(1, W // 900))
            for ex in cfg["cameras"][cam].get("exclude", []):
                cv2.rectangle(im, (int(ex[0] * W), int(ex[1] * H)), (int(ex[2] * W), int(ex[3] * H)), (255, 0, 255), 2)
            cv2.imwrite(f"/tmp/preview_{cam}.jpg", im)
            print("preview", cam, src)
        return

    lib = Library(cfg)
    if not lib.rows:
        sys.exit("no cut-outs in data/cutouts/index.jsonl")
    index_path = outdir / "index.jsonl"
    rows = []
    if args.append and index_path.exists():
        rows = [json.loads(l) for l in index_path.read_text().splitlines() if l.strip()]
    done_ids = {r["id"] for r in rows}
    n_bucket = {}
    # balanced (bucket, group) schedule per camera
    combos = [(b, g) for b in range(5) for g in (["bird", "mammal"] if args.group == "both" else [args.group])]
    n_made = 0
    for si, s in enumerate(sources):
        cam_cfg = cfg["cameras"].get(s["cam"])
        if not cam_cfg or not cam_cfg["regions"]:
            print(f"skip {s['scene_id']}: no regions for camera {s['cam']}")
            continue
        bgr = cv2.imread(str(s["base"]))
        if bgr is None:
            continue
        base = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB).astype(np.float32)
        H, W = base.shape[:2]
        noise_sigma = measure_noise(luma(base))
        for k in range(args.per_scene):
            cid = f"{s['scene_id']}_c{k:02d}"
            rng = rng_for("comp", args.seed, cid)
            # least used (bucket, group) combination for this camera first; random tie break
            order = sorted(combos, key=lambda bg: (n_bucket.get((s["cam"], bg), 0) / cfg.get("bucket_weights", [1] * 5)[bg[0]], rng.random()))
            result = None
            for bi, group in order:
                lo, hi = cfg["buckets"][bi]
                hi = min(hi, 0.8 * min(W, H)) if bi == 4 else hi
                size_px = float(math.exp(rng.uniform(math.log(lo), math.log(hi))))
                pick = choose(cfg, cam_cfg, lib, bi, group, size_px, W, H, rng, args.region)
                if pick is None:
                    continue
                c, reg, ax, ay = pick
                occ = None
                if reg.get("occlude") == "bars":
                    occ = bars_mask(base, reg["bars_box"], s["ir"])
                res = render(base, lib.load(c["id"]), size_px, ax, ay, rng.random() < 0.5, s["period"], s["ir"], reg,
                             cam_cfg["camera_look"], noise_sigma, rng, occ,
                             u_local=size_px * 50.0 / cfg["body_cm"][c["species"]])
                if res is None or res[2]["visible_frac"] < 0.45:
                    continue
                result = (bi, group, c, reg, size_px, res)
                break
            if result is None:
                print(f"no feasible composite for {cid}")
                continue
            bi, group, c, reg, size_px, (out, box, info) = result
            n_bucket[(s["cam"], (bi, group))] = n_bucket.get((s["cam"], (bi, group)), 0) + 1
            lib.uses[c["id"]] += 1
            outp = outdir / f"{cid}.jpg"
            cv2.imwrite(str(outp), cv2.cvtColor(out.astype(np.uint8), cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 93])
            sz = max(box[2], box[3])
            row = {"id": cid, "camera": s["cam"], "scene": s["scene_id"], "base": s["base"].name, "base_path": str(s["base"]),
                   "ref": str(s["ref"]), "period": s["period"], "ir": s["ir"], "species": c["species"], "group": c["group"],
                   "box": box, "size_px": sz, "size_bucket": bucket_of(sz, cfg), "target_bucket": cfg["bucket_names"][bi],
                   "cutout": c["id"], "pose": c.get("pose", "std"), "region": reg["name"], "size": [W, H], "source": s["source"],
                   "degrade": {**info, "noise_measured": round(noise_sigma, 2)}, "seed": args.seed}
            rows = [r for r in rows if r["id"] != cid] + [row]
            n_made += 1
            if n_made % 20 == 0:
                index_path.write_text("".join(json.dumps(r) + "\n" for r in rows))  # keep the index current mid-run
                print(f"{n_made} composites", flush=True)
    index_path.write_text("".join(json.dumps(r) + "\n" for r in rows))
    from collections import Counter
    print(f"wrote {n_made} composites ({len(rows)} in index)")
    print("by size bucket:", dict(Counter(r["size_bucket"] for r in rows)))
    print("by camera:", dict(Counter(r["camera"] for r in rows)), "by group:", dict(Counter(r["group"] for r in rows)))


if __name__ == "__main__":
    main()
