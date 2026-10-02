"""Throwaway parity check: feed the evaluation's own inputs (segments, TF MixIT tracks, source choices, Perch numbers) through
the service's DSP / normalisation / candidate / selection code and compare with the evaluation's stored candidates and picks."""
import json, sys
import numpy as np
sys.path.insert(0, '/data/home/kestrel-audio')
from kestrel_audio import dsp
from kestrel_audio.candidates import gate_variants, separated_variants
from kestrel_audio.codec import SR
from kestrel_audio.loudness import fade, loudness_clean, normalize
from kestrel_audio.verify import Candidate, Reference, SourceChoice, choose

R = '/data/home/Kestrel/audio-eval/data/preview-eval/results/'; W = '/data/home/Kestrel/audio-eval/data/preview-eval/work/'
segs = json.load(open(R + 'segments.json')); sel = json.load(open(R + 'seg_selection.json'))
rows = json.load(open(R + 'seg_metrics.json')); picks = json.load(open(R + 'seg_picks.json'))
by = {}
for r in rows: by.setdefault(r['name'], {})[r['cand']] = r
worst_final = 0.0; worst_contrast = 0.0; worst_supp = 0.0; n_cands = 0; mism = []
agree = 0
for n, e in segs.items():
    raw = np.load(W + f'raw22k/{n}.npy').astype(np.float32)
    i0, i1 = int(round(e['seg_start'] * SR)), int(round(e['seg_end'] * SR))
    x = raw[i0:i1]; scale = e['seg_scale']; xs = (x * scale).astype(np.float32)
    b_final, b_norm = normalize(fade(xs, SR, 75.0), SR)
    ev_b = np.load(W + f'seg_cand/{n}__orig__final.npy')
    worst_final = max(worst_final, float(np.abs(b_final - ev_b).max()))
    f, loud, quiet = dsp.frame_sets(b_final)
    ref_contrast = dsp.contrast_db(b_final)
    _, base_quiet = dsp.level_in_sets(x, loud, quiet)
    variants = gate_variants(xs, dsp.clip_noise_psd(raw * scale))
    for k, tag, fold in ((4, 'a', 'seg_src4'), (8, 'b', 'seg_src8')):
        tr = np.stack([np.load(W + f'{fold}/{n}__s{j}.npy') for j in range(k)])
        s = sel[n][tag]
        variants.update(separated_variants(k, tr, SourceChoice(s['top'], tuple(s['passing']), '')))
    cands, native_t, loud_t = [], {}, {}
    for cid, v in variants.items():
        pre = fade(v, SR, 75.0); final, info = normalize(pre, SR); native = pre / scale
        c = Candidate(cid, dsp.contrast_db(final), base_quiet - dsp.level_in_sets(native, loud, quiet)[1], loudness_clean(info))
        cands.append(c); n_cands += 1
        m = by[n][cid]
        worst_final = max(worst_final, float(np.abs(final - np.load(W + f'seg_cand/{n}__{cid}__final.npy')).max()))
        worst_contrast = max(worst_contrast, abs(c.contrast_db - m['contrast_hi_db']))
        worst_supp = max(worst_supp, abs(c.suppression_db - m['quiet_suppression_db']))
        native_t[cid], loud_t[cid] = m['perch_raw_level'], m['perch_final']
    o = by[n]['orig']
    ref = Reference(o['perch_raw_level'], o['perch_final'], dsp.contrast_db(b_final))
    dec = choose(cands, ref, lambda b: {c.id: native_t[c.id] for c in b}, lambda b: {c.id: loud_t[c.id] for c in b})
    mine = dec.choice.candidate.id if dec.choice else 'orig'
    want = picks[n]['auto']
    agree += (mine == want)
    if mine != want: mism.append((n, mine, want))
print(f'candidates compared: {n_cands} over 27 clips')
print(f'max |final audio diff|  : {worst_final:.2e}')
print(f'max |clarity diff|      : {worst_contrast:.2e} dB')
print(f'max |background cut diff|: {worst_supp:.2e} dB')
print(f'picks identical to the evaluation (given the evaluation\'s own Perch numbers): {agree}/27')
for m in mism: print('  differs:', m)
