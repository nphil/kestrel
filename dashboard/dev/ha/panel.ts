/* Copied from lucent-ha dev/ha-panel.ts (MIT, same owner) and pointed at Kestrel's address (/kestrel). */
/** `<ha-panel-custom>`: the element Home Assistant appends a custom panel into (src/panels/custom/ha-panel-custom.ts).
 *
 * Reproduced: it renders into its own light DOM; it pads the panel by the safe-area insets unless the panel config says
 * `handle_safe_area`; its background is `--primary-background-color`; the panel gets `hass`, `narrow`, `route` and `panel`
 * as properties; a panel that is left is destroyed and a new element is created when it is opened again; and
 * `navigate(path, { replace, data })` (the internal API the toolkit's `navigate()` uses) does `pushState`/`replaceState`
 * with the `from` bookkeeping Home Assistant adds, then fires `location-changed` on `window`. */
import type { HaRoute, HomeAssistant } from "lucent-ha";

export interface NavigateOptions {
  replace?: boolean;
  data?: Record<string, unknown>;
}

/** The URL Kestrel's panel lives at (`panel_custom` url_path). `/kestrel/live` = `{ prefix: "/kestrel", path: "/live" }`. */
export const PANEL_PREFIX = "/kestrel";

const currentPath = (): string => location.pathname + location.search + location.hash;

/** Home Assistant's `navigate` (src/common/navigate.ts) minus the dialog and unsaved-changes guards. */
export function haNavigate(path: string, options: NavigateOptions = {}): void {
  const replace = options.replace ?? false;
  const from: unknown = replace ? (history.state as { from?: unknown } | null)?.from : currentPath();
  const state = from === undefined ? (options.data ?? null) : { ...options.data, from };
  if (replace) history.replaceState(state, "", path);
  else history.pushState(state, "", path);
  window.dispatchEvent(new CustomEvent("location-changed", { detail: { replace }, bubbles: true, composed: true }));
}

/** The panel route for the current URL, or undefined when the URL belongs to another Home Assistant panel. */
export function currentRoute(): HaRoute | undefined {
  const { pathname } = location;
  if (pathname === PANEL_PREFIX) return { prefix: PANEL_PREFIX, path: "" };
  return pathname.startsWith(`${PANEL_PREFIX}/`) ? { prefix: PANEL_PREFIX, path: pathname.slice(PANEL_PREFIX.length) } : undefined;
}

export class HaPanelCustom extends HTMLElement {
  hass?: HomeAssistant;
  narrow = false;
  /** What `route` carries inside the panel; for another Home Assistant panel's URL it is the placeholder's. */
  route: HaRoute = { prefix: PANEL_PREFIX, path: "" };
  /** Creates the panel element (the specimen page or a scenario). */
  create?: () => HTMLElement;
  /** The panel element currently mounted, if any. */
  panel?: HTMLElement;
  /** `handle_safe_area` of the panel config: true = the panel deals with the insets itself, so the container does not pad. */
  handleSafeArea = false;

  /** HA's own function, exposed on the element: the toolkit calls `parentElement.navigate(...)`. */
  readonly navigate = (path: string, options?: NavigateOptions): void => haNavigate(path, options);

  connectedCallback(): void {
    this.style.display = "block";
    this.style.boxSizing = "border-box";
    this.refresh();
  }

  /** Mounts, unmounts or updates the panel after `hass`, `narrow` or the URL changed. */
  refresh(): void {
    const route = currentRoute();
    this.toggleAttribute("data-handle-safe-area", this.handleSafeArea);
    if (!route) {
      this.panel?.remove();
      this.panel = undefined;
      this.showElsewhere();
      return;
    }
    this.querySelector(".hx-elsewhere")?.remove();
    this.route = route;
    if (!this.panel && this.create) {
      this.panel = this.create();
      this.append(this.panel);
    }
    if (this.panel) Object.assign(this.panel, { hass: this.hass, narrow: this.narrow, route, panel: { title: "Cameras", url_path: "kestrel", config: {} } });
  }

  private showElsewhere(): void {
    if (this.querySelector(".hx-elsewhere")) return;
    const placeholder = document.createElement("div");
    placeholder.className = "hx-elsewhere";
    const heading = document.createElement("p");
    heading.textContent = `Home Assistant would show another panel here (${location.pathname}). The Kestrel panel element has been destroyed, as Home Assistant does.`;
    const back = document.createElement("button");
    back.type = "button";
    back.textContent = "Open the Cameras panel";
    back.addEventListener("click", () => haNavigate(`${PANEL_PREFIX}/live`));
    placeholder.append(heading, back);
    this.append(placeholder);
  }
}
