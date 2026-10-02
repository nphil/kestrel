"""Zone logic ported from the NVR plugin (zones.ts / polygon.ts). Polygons are lists of [x, y] in 0..1."""
from __future__ import annotations


def _seg_intersect(p1, p2, p3, p4) -> bool:
    (e, t), (i, n), (s, r), (o, a) = p1, p2, p3, p4
    c = (a - r) * (i - e) - (o - s) * (n - t)
    if c == 0:
        return False
    l = ((o - s) * (t - r) - (a - r) * (e - s)) / c
    d = ((i - e) * (t - r) - (n - t) * (e - s)) / c
    return 0 <= l <= 1 and 0 <= d <= 1


def point_in_poly(pt, poly) -> bool:
    e, t = pt
    inside = False
    j = len(poly) - 1
    for i in range(len(poly)):
        o, a = poly[i]
        c, l = poly[j]
        if (a > t) != (l > t) and e < (c - o) * (t - a) / (l - a) + o:
            inside = not inside
        j = i
    return inside


def rect_corners(b):
    x, y, w, h = b
    return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]


def intersects(poly, box) -> bool:
    """Sc: polygon touches the (normalised) box."""
    corners = rect_corners(box)
    for t in range(len(poly)):
        n = (t + 1) % len(poly)
        for e in range(4):
            tt = (e + 1) % 4
            if _seg_intersect(poly[t], poly[n], corners[e], corners[tt]):
                return True
    return point_in_poly(poly[0], corners) or point_in_poly(corners[0], poly)


def contains_box(poly, box) -> bool:
    """bc: all four corners inside the polygon."""
    return all(point_in_poly(c, poly) for c in rect_corners(box))


def normalise_box(b, dims):
    return [b[0] / dims[0], b[1] / dims[1], b[2] / dims[0], b[3] / dims[1]]


def evaluate(zones, dims, box):
    """Pc: None (no zone applied) / False / True. zones: dicts with path, type ('Contain'|'Intersect'), exclusion."""
    s = normalise_box(box, dims)
    r = None
    for z in zones:
        path = z.get("path")
        if not path or len(path) < 3:
            continue
        if r and not z.get("exclusion"):
            continue
        if not z.get("exclusion") and r is None:
            r = False
        hit = contains_box(path, s) if z.get("type") == "Contain" else intersects(path, s)
        if hit:
            if z.get("exclusion"):
                r = False
                break
            r = True
    return r


DEFAULT_MOTION_BAND = [[0, .1], [1, .1], [1, .9], [0, .9]]


def object_zone_pass(zones, cls, dims, box) -> bool:
    """Retention check for a detection of class `cls` (NVR kc()): zones = object-detection zones of the camera."""
    if not zones:
        return True
    has_inclusion = any(not z.get("exclusion") for z in zones)
    applicable = [z for z in zones if not z.get("classes") or cls in z["classes"]]
    d = evaluate(applicable, dims, box)
    if d is not None:
        return bool(d)
    return not has_inclusion
