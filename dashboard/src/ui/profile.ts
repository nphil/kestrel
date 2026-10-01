import type { ReactiveController, ReactiveControllerHost } from "lit";

/** The Lucent device profiles that make sense inside a Home Assistant panel (LANGUAGE.md section 7). */
export type LuProfile = "phone" | "tablet" | "desktop" | "smart" | "ha";

/** Height under which a panel is "short": a phone held sideways, or a wall display. */
export const SHORT_HEIGHT = 540;

/** The profile comes from the panel's own size and how it is operated, never from the viewport width
 * (Home Assistant's sidebar takes 56-256 px of it) and never from the user agent.
 *
 * - smart: touch only, wide and short (a wall display read at arm's length, e.g. 960x480)
 * - phone: narrow, or touch held sideways with almost no height
 * - tablet: any other touch-only panel
 * - desktop: hover + fine pointer and a roomy panel
 * - ha: everything else (the container-first Home Assistant profile) */
export function resolveProfile(width: number, height: number, touchOnly: boolean): LuProfile {
  if (touchOnly && width >= 900 && height <= SHORT_HEIGHT) return "smart";
  if (width < 600 || (touchOnly && height < 480)) return "phone";
  if (touchOnly) return "tablet";
  return width >= 900 ? "desktop" : "ha";
}

/** Keeps `data-lu-profile`, `data-lu-short` and `data-lu-touch` on the host current, so the token layer can
 * switch type, target and margin sizes by profile, and re-renders the host when they change. */
export class PanelProfile implements ReactiveController {
  width = 0;
  height = 0;
  profile: LuProfile = "ha";
  short = false;
  touchOnly = false;

  private readonly _host: ReactiveControllerHost & HTMLElement;
  private readonly _touch: MediaQueryList | null = typeof matchMedia === "function" ? matchMedia("(hover: none) and (pointer: coarse)") : null;
  private _observer?: ResizeObserver;

  constructor(host: ReactiveControllerHost & HTMLElement) {
    this._host = host;
    host.addController(this);
  }

  hostConnected(): void {
    if (typeof ResizeObserver !== "undefined") {
      this._observer = new ResizeObserver((entries) => this._apply(entries[0]?.contentRect.width ?? this._host.clientWidth));
      this._observer.observe(this._host);
    }
    window.addEventListener("resize", this._onChange);
    window.visualViewport?.addEventListener("resize", this._onChange);
    this._touch?.addEventListener("change", this._onChange);
    this._apply(this._host.clientWidth);
  }

  hostDisconnected(): void {
    this._observer?.disconnect();
    this._observer = undefined;
    window.removeEventListener("resize", this._onChange);
    window.visualViewport?.removeEventListener("resize", this._onChange);
    this._touch?.removeEventListener("change", this._onChange);
  }

  private _onChange = (): void => { this._apply(this._host.clientWidth); };

  private _apply(measured: number): void {
    const width = Math.round(measured);
    if (width <= 0) return;
    const height = Math.round(window.visualViewport?.height ?? window.innerHeight);
    const touchOnly = this._touch?.matches ?? false;
    const profile = resolveProfile(width, height, touchOnly);
    const short = height <= SHORT_HEIGHT;
    const changed = Math.abs(width - this.width) > 1 || height !== this.height || profile !== this.profile || short !== this.short || touchOnly !== this.touchOnly;
    if (!changed) return;
    this.width = width;
    this.height = height;
    this.profile = profile;
    this.short = short;
    this.touchOnly = touchOnly;
    this._host.setAttribute("data-lu-profile", profile);
    this._host.toggleAttribute("data-lu-short", short);
    this._host.toggleAttribute("data-lu-touch", touchOnly);
    this._host.requestUpdate();
  }
}
