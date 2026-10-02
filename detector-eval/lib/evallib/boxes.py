"""Box math ported 1:1 from the NVR plugin (box-math.ts). Boxes are [x, y, w, h]."""
from __future__ import annotations
import math
from typing import Callable, Optional

Box = list


def area(b) -> float:
    return b[2] * b[3]


def inter(a, b) -> Optional[Box]:
    """Qa: intersection rectangle, or None. Touching edges count as intersecting."""
    x = max(a[0], b[0])
    y = max(a[1], b[1])
    w = min(a[0] + a[2], b[0] + b[2]) - x
    h = min(a[1] + a[3], b[1] + b[3]) - y
    if w < 0 or h < 0:
        return None
    return [x, y, w, h]


def union(a, b) -> Box:
    """Ka: bounding box of both."""
    x = min(a[0], b[0])
    y = min(a[1], b[1])
    return [x, y, max(a[0] + a[2], b[0] + b[2]) - x, max(a[1] + a[3], b[1] + b[3]) - y]


def _has_point(e, p) -> bool:
    return p[0] >= e[0] and p[1] >= e[1] and p[0] <= e[0] + e[2] and p[1] <= e[1] + e[3]


def contains(e, t) -> bool:
    """ec: box e contains box t (top-left and bottom-right corners inside)."""
    return _has_point(e, [t[0], t[1]]) and _has_point(e, [t[0] + t[2], t[1] + t[3]])


def _resize_center(e, w, h) -> Box:
    return [e[0] + e[2] / 2 - w / 2, e[1] + e[3] / 2 - h / 2, w, h]


def scale(e, f) -> Box:
    """nc: scale about the centre."""
    return _resize_center(e, e[2] * f, e[3] * f)


def at_least(e, wh) -> Box:
    """sc: grow to at least wh[0] x wh[1] about the centre."""
    return _resize_center(e, max(e[2], wh[0]), max(e[3], wh[1]))


def fit_aspect(e, aspect, dims) -> Optional[Box]:
    """cc: the box of the given aspect (w/h) around e's centre, big enough to hold e, clamped inside dims=[W,H].
    Returns None when it cannot fit."""
    cx = (2 * e[0] + e[2]) / 2
    cy = (2 * e[1] + e[3]) / 2
    if e[2] / e[3] > aspect:
        o = e[2]
        a = o / aspect
        if a > dims[1]:
            a = dims[1]
            o = a * aspect
    else:
        a = e[3]
        o = a * aspect
        if o > dims[0]:
            o = dims[0]
            a = o / aspect
    o = math.floor(o)
    a = math.floor(a)
    c = math.floor(cx - o / 2)
    if c < 0:
        c = 0
    r = c + o
    if r > dims[0]:
        r = dims[0]
        c = r - o
        if c < 0:
            return None
    d = math.floor(cy - a / 2)
    if d < 0:
        d = 0
    u = d + a
    if u > dims[1]:
        u = dims[1]
        d = u - a
        if d < 0:
            return None
    return [c, d, o, a]


def iou(a, b) -> float:
    i = inter(a, b)
    if not i:
        return 0.0
    ia = area(i)
    ua = area(a) + area(b) - ia
    return ia / ua if ua > 0 else 0.0


def _default_merge(a):
    def f(existing):
        if inter(existing, a):
            return union(a, existing)
        return None
    return f


class Bucketizer:
    """Za: keeps a set of boxes, merging a new box into an existing one when merge(existing) says so."""

    def __init__(self, new_t: Optional[Callable] = None, merge_t: Optional[Callable] = None):
        self.new_t = new_t
        self.merge_t = merge_t
        self.boxes: dict = {}  # tuple(box) -> value

    def add_box(self, e, merge: Optional[Callable] = None):
        e = list(e)
        if merge is None:
            merge = _default_merge(e)
        for key, val in list(self.boxes.items()):
            existing = list(key)
            if contains(existing, e):
                return val
            m = merge(existing)
            if m is not None:
                del self.boxes[key]
                t = self.add_box(m)
                if self.merge_t:
                    self.merge_t(t, val, m, e)
                return t
        v = self.new_t(e) if self.new_t else None
        self.boxes[tuple(e)] = v
        return v

    def keys(self):
        return [list(k) for k in self.boxes.keys()]
