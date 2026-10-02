import numpy as np, matplotlib
matplotlib.use('Agg'); import matplotlib.pyplot as plt
import dsp
VMIN, VMAX = -95.0, -25.0

def spec_data(y):
    f, t, Z = dsp._stft(y)
    return f, t, 20 * np.log10(np.abs(Z) + 1e-10)

def draw(ax, y, title=None, vmin=VMIN, vmax=VMAX):
    f, t, S = spec_data(y)
    ax.pcolormesh(t, f, S, vmin=vmin, vmax=vmax, cmap='magma', shading='auto', rasterized=True)
    ax.set_yscale('function', functions=(np.sqrt, np.square)); ax.set_ylim(80, 8000)
    ax.set_yticks([250, 500, 1000, 2000, 4000, 8000]); ax.set_yticklabels(['.25', '.5', '1', '2', '4', '8k'], fontsize=7)
    ax.minorticks_off()
    ax.tick_params(axis='x', labelsize=7)
    if title: ax.set_title(title, fontsize=8, loc='left', pad=2)
