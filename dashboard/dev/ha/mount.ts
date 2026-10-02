/* The mini Home Assistant around Kestrel's panel: frame (docked sidebar or drawer), `ha-panel-custom`, themes and `hass`.
 * Assembled the way lucent-ha's dev/harness.ts does it (MIT, same owner), without the specimen machinery. */
import type { HomeAssistant } from "lucent-ha";
import { HaFrame } from "./frame.ts";
import { MockHa } from "./mock-hass.ts";
import { HaPanelCustom } from "./panel.ts";
import { HaCard, HaIcon, HaSvgIcon } from "./standins.ts";
import { THEME_NAMES, applyTheme, installHaDefaults, isThemeName, type ThemeName } from "./theme.ts";

/** Home Assistant's `narrow`: the viewport is 870px wide or less (src/layouts/home-assistant-main.ts). */
const NARROW_QUERY = "(max-width: 870px)";

/** What `ha-panel-custom` and the page chrome look like (the harness's own CSS; Home Assistant's theme variables only). */
const CSS = `
html, body { margin: 0; height: 100%; }
body { color: var(--primary-text-color); font-family: var(--ha-font-family-body, system-ui, sans-serif); }
ha-panel-custom {
  background-color: var(--primary-background-color);
  min-height: 100%;
  padding-top: var(--safe-area-inset-top);
  padding-bottom: var(--safe-area-inset-bottom);
  padding-left: var(--safe-area-content-inset-left, var(--safe-area-inset-left));
  padding-right: var(--safe-area-content-inset-right, var(--safe-area-inset-right));
}
ha-panel-custom[data-handle-safe-area] { padding: 0; }
.hx-elsewhere { padding: 32px 16px; display: grid; gap: 12px; justify-items: start; font-family: var(--ha-font-family-body); color: var(--primary-text-color); }
.hx-elsewhere p { margin: 0; }
.hx-elsewhere button { font: inherit; }
`;

export type DockedSidebar = NonNullable<HomeAssistant["dockedSidebar"]>;

export interface MountOptions {
  theme: ThemeName;
  sidebar: DockedSidebar;
  kiosk: boolean;
  /** Safe-area insets in px: top, right, bottom, left (what a notched phone reports through `env()`). */
  safe?: [number, number, number, number];
  /** Runs once the mock exists and BEFORE the panel is created: register websocket handlers here (the panel asks the moment it connects). */
  setup?: (mock: MockHa) => void;
  /** Creates the panel element; called again each time the URL comes back to the panel. */
  create: () => HTMLElement;
}

export interface MiniHa {
  readonly mock: MockHa;
  readonly frame: HaFrame;
  readonly host: HaPanelCustom;
  readonly theme: ThemeName;
  setTheme(name: ThemeName): void;
  setSidebar(mode: DockedSidebar): void;
  setKiosk(enable: boolean): void;
  disconnect(): void;
  reconnect(): void;
}

function defineOnce(tag: string, constructor: CustomElementConstructor): void {
  if (!customElements.get(tag)) customElements.define(tag, constructor);
}

/** The theme the harness page asked for (`?theme=`), flat-light when it did not. */
export function themeFromQuery(wanted: string | null): ThemeName {
  if (wanted && !isThemeName(wanted)) throw new Error(`unknown ?theme=${wanted}; use ${THEME_NAMES.join(", ")}`);
  return isThemeName(wanted) ? wanted : "flat-light";
}

export function mountHa(options: MountOptions): MiniHa {
  installHaDefaults();
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.append(style);
  let theme = options.theme;
  applyTheme(theme);
  if (options.safe) {
    const [top, right, bottom, left] = options.safe;
    const root = document.documentElement.style;
    root.setProperty("--app-safe-area-inset-top", `${top}px`);
    root.setProperty("--app-safe-area-inset-right", `${right}px`);
    root.setProperty("--app-safe-area-inset-bottom", `${bottom}px`);
    root.setProperty("--app-safe-area-inset-left", `${left}px`);
  }

  defineOnce("ha-svg-icon", HaSvgIcon);
  defineOnce("ha-icon", HaIcon);
  defineOnce("ha-card", HaCard);
  defineOnce("ha-panel-custom", HaPanelCustom);
  defineOnce("ha-frame", HaFrame);

  const mock = new MockHa({ dockedSidebar: options.sidebar, kioskMode: options.kiosk, theme });
  options.setup?.(mock);
  const frame = document.createElement("ha-frame") as HaFrame;
  const host = document.createElement("ha-panel-custom") as HaPanelCustom;
  frame.append(host);
  host.create = options.create;
  const narrowQuery = matchMedia(NARROW_QUERY);
  const push = (): void => {
    frame.hass = host.hass = mock.hass;
    frame.narrow = host.narrow = narrowQuery.matches;
    host.refresh();
  };
  // What the `home-assistant` root element does with these events (src/state/sidebar-mixin.ts).
  mock.subscribe(push);
  narrowQuery.addEventListener("change", push);
  frame.addEventListener("hass-dock-sidebar", (event) => mock.update({ dockedSidebar: (event as CustomEvent<{ dock: DockedSidebar }>).detail.dock }));
  window.addEventListener("hass-kiosk-mode", (event) => mock.update({ kioskMode: (event as CustomEvent<{ enable: boolean }>).detail.enable }));
  // Home Assistant re-renders its panel area on every navigation; a panel left behind is destroyed, one opened again is created anew.
  for (const name of ["location-changed", "popstate"]) window.addEventListener(name, () => host.refresh());
  push();
  document.body.append(frame);

  return {
    mock,
    frame,
    host,
    get theme() {
      return theme;
    },
    setTheme(name) {
      if (!isThemeName(name)) throw new Error(`unknown theme ${String(name)}; use ${THEME_NAMES.join(", ")}`);
      theme = name;
      applyTheme(name);
      mock.setTheme(name);
    },
    setSidebar: (mode) => mock.update({ dockedSidebar: mode }),
    setKiosk: (enable) => window.dispatchEvent(new CustomEvent("hass-kiosk-mode", { detail: { enable } })),
    disconnect: () => mock.disconnect(),
    reconnect: () => mock.reconnect(),
  };
}
