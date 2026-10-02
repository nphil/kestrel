"""DSP candidates (stationary spectral gating / decision-directed Wiener / mask refinement) and clarity metrics."""
from __future__ import annotations

import numpy as np
from scipy.ndimage import binary_closing, binary_dilation, median_filter, uniform_filter1d
from scipy.signal import istft, stft
from scipy.special import exp1

SR = 22050
NFFT = 1024
HOP = 256
LOW_HZ = 300.0


def _stft(x, nfft=NFFT, hop=HOP):
    f, t, Z = stft(x.astype(np.float64), SR, window="hann", nperseg=nfft, noverlap=nfft - hop, boundary="zeros", padded=True)
    return f, t, Z


def _istft(Z, n, nfft=NFFT, hop=HOP):
    _, y = istft(Z, SR, window="hann", nperseg=nfft, noverlap=nfft - hop, boundary=True)
    y = y[:n]
    if len(y) < n:
        y = np.pad(y, (0, n - len(y)))
    return y.astype(np.float32)


def noise_psd(P: np.ndarray, pct: float = 20.0) -> np.ndarray:
    """Per-bin noise power from a low percentile over time. For complex-Gaussian (exponential-power) stationary noise,
    the p-th percentile equals -ln(1-p) times the mean, so divide that out. Robust to calls covering < (100-pct)% of a bin's frames."""
    lam = np.percentile(P, pct, axis=1) / (-np.log(1.0 - pct / 100.0))
    lam = np.maximum(lam, 1e-20)
    return uniform_filter1d(lam, size=3, mode="nearest")


# --------------------------------------------------------------------------- candidate B: stationary gating variants

def quiet_noise_clip(x: np.ndarray, block_s: float = 0.5, n_blocks: int = 4) -> np.ndarray:
    """Concatenate the clip's own quietest contiguous blocks (>= 300 Hz energy) as the noise-only sample."""
    f, t, Z = _stft(x)
    band = f >= LOW_HZ
    e = (np.abs(Z[band]) ** 2).sum(axis=0)
    bl = int(block_s * SR / HOP)
    starts = np.arange(0, max(1, len(e) - bl), bl)
    scores = [(e[s:s + bl].mean(), s) for s in starts]
    scores.sort()
    picks = sorted(s for _, s in scores[:n_blocks])
    segs = [x[s * HOP: s * HOP + bl * HOP] for s in picks]
    return np.concatenate(segs) if segs else x


def gate_noisereduce(x: np.ndarray, prop_decrease: float, n_std: float = 1.5, f_smooth_hz: int = 500, t_smooth_ms: int = 50) -> np.ndarray:
    import noisereduce as nr
    y_noise = quiet_noise_clip(x)
    y = nr.reduce_noise(y=x.astype(np.float32), sr=SR, y_noise=y_noise.astype(np.float32), stationary=True,
                        prop_decrease=prop_decrease, n_std_thresh_stationary=n_std,
                        freq_mask_smooth_hz=f_smooth_hz, time_mask_smooth_ms=t_smooth_ms, n_fft=NFFT, hop_length=HOP)
    return np.asarray(y, dtype=np.float32)


def wiener_dd(x: np.ndarray, floor_db: float = -15.0, alpha: float = 0.98, xi_min_db: float = -25.0, gain: str = "lsa", lam: np.ndarray | None = None) -> np.ndarray:
    """Decision-directed (Ephraim-Malah) MMSE-LSA / Wiener suppression with a per-bin stationary noise PSD and a gain floor.
    The DD a-priori SNR estimate is what keeps residual noise smooth instead of leaving isolated 'musical' peaks."""
    n = len(x)
    f, t, Y = _stft(x)
    P = np.abs(Y) ** 2
    if lam is None:
        lam = noise_psd(P)
    gamma = P / lam[:, None]
    nb, nt = P.shape
    G = np.ones_like(P)
    prev = np.ones(nb)  # previous |S_hat|^2 / lam
    xi_min = 10 ** (xi_min_db / 10)
    for k in range(nt):
        xi = alpha * prev + (1 - alpha) * np.maximum(gamma[:, k] - 1.0, 0.0)
        xi = np.maximum(xi, xi_min)
        g = xi / (1.0 + xi)
        if gain == "lsa":
            v = np.maximum(g * gamma[:, k], 1e-8)
            g = g * np.exp(0.5 * exp1(v))
        g = np.minimum(g, 1.0)
        prev = (g ** 2) * gamma[:, k]
        G[:, k] = g
    G = np.maximum(G, 10 ** (floor_db / 20))
    # light smoothing of the gain across frequency to avoid isolated bins
    G = uniform_filter1d(G, size=3, axis=0, mode="nearest")
    return _istft(Y * G, n)


def mask_refine(x: np.ndarray, sources: np.ndarray, sel: int, power: float = 2.0, floor_db: float = -25.0) -> np.ndarray:
    """Ratio mask built from the separated sources applied to the ORIGINAL mixture STFT (keeps the original's timbre/phase;
    removes the separator's own artefacts). sources: (K, n) in the same amplitude units as x."""
    n = len(x)
    _, _, Y = _stft(x)
    mags = np.stack([np.abs(_stft(s)[2]) ** power for s in sources])
    m = mags[sel] / (mags.sum(axis=0) + 1e-20)
    m = np.maximum(m, 10 ** (floor_db / 20))
    return _istft(Y * m, n)


# --------------------------------------------------------------------------- metrics

def frame_sets(x: np.ndarray, loud_pct: float = 90.0, quiet_pct: float = 30.0):
    """Candidate-independent frame sets taken from the loudness-only clip: the loudest 10% frames (>=300 Hz energy; these are the
    animal sounds) and the quietest 30% (background only). Real clips often hold several animals at once (peepers, insects, the
    target), so 'any animal activity' is what the loud set measures; the Perch confidence column is what ties a result to the target."""
    f, t, Z = _stft(x)
    P = np.abs(Z) ** 2
    e = band_ms_db(P, f, LOW_HZ, 11000.0)
    return f, e >= np.percentile(e, loud_pct), e <= np.percentile(e, quiet_pct)


def band_ms_db(P: np.ndarray, f: np.ndarray, lo: float, hi: float) -> np.ndarray:
    sel = (f >= lo) & (f <= hi)
    ms = 0.5 * P[sel].sum(axis=0)   # scipy 'spectrum' scaling: |Y| = sinusoid amplitude, so mean-square = 0.5*sum|Y|^2
    return 10 * np.log10(ms + 1e-20)


def clarity_metrics(x: np.ndarray, loud: np.ndarray, quiet: np.ndarray) -> dict:
    """Measured on any (normalised or raw) signal x using fixed frame sets taken from the loudness-only candidate."""
    f, t, Z = _stft(x)
    P = np.abs(Z) ** 2
    nt = P.shape[1]
    ld = np.pad(loud, (0, max(0, nt - len(loud))))[:nt]
    qt = np.pad(quiet, (0, max(0, nt - len(quiet))))[:nt]
    out: dict = {}
    for tag, lo in (("full", 0.0), ("hi", LOW_HZ)):
        e_db = band_ms_db(P, f, lo, 11000.0)
        out[f"contrast_{tag}_db"] = float(np.percentile(e_db, 95) - np.percentile(e_db, 20))
        call = 10 * np.log10(np.mean(10 ** (e_db[ld] / 10)) + 1e-30)
        noise = 10 * np.log10(np.mean(10 ** (e_db[qt] / 10)) + 1e-30)
        out[f"loud_level_{tag}_db"] = float(call)
        out[f"quiet_level_{tag}_db"] = float(noise)
        out[f"loud_vs_quiet_{tag}_db"] = float(call - noise)
    # musical-noise indicator: P99/median of the STFT magnitudes in the quiet frames, 300 Hz-8 kHz (stationary Gaussian noise ~ 8.2 dB)
    sel = (f >= LOW_HZ) & (f <= 8000)
    mag = np.abs(Z[sel][:, qt]).ravel() + 1e-12
    out["noise_peakiness_db"] = float(20 * np.log10(np.percentile(mag, 99) / np.median(mag)))
    return out
