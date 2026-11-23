import { css } from "lit";
import { LuAudioPlayer } from "lucent-ha";

// The toolkit lays its "Cleaned" mark (24 px) and its "Original" button (a whole touch target tall) out as unrelated things on separate
// rows, which on a phone reads as a tall pill stranded under a small chip. Here the mark and the button are one row of equal 32 px pills
// (the button keeps a 44 px hit area), and the caption follows them, wrapping onto its own line when the row is full.
export class KestrelAudioPlayer extends LuAudioPlayer {
  static override styles = [...LuAudioPlayer.styles, css`
    :host { display: flex; flex-wrap: wrap; align-items: center; gap: var(--lu-space-1) var(--lu-space-2); }
    audio, .fallback { flex: 1 0 100%; }
    .notes { display: contents; }
    .mark { order: 1; min-height: 32px; padding: 0 var(--lu-space-3); }
    .toggle { order: 2; position: relative; min-height: 32px; margin: 0; }
    .toggle::after { content: ""; position: absolute; inset: -6px 0; }
    .notes > :not(.mark) { order: 3; min-width: 0; }
  `];
}
