/* Copied from lucent-ha dev/ha-theme.ts (MIT, same owner) and trimmed for the Kestrel harness. */
/** Home Assistant's theme application, replayed on <html> for the harness.
 *
 * What Home Assistant does (src/state/themes-mixin.ts + src/common/dom/apply_themes_on_element.ts):
 *   1. The page ships a stylesheet with every default variable (`html { --primary-color: ... }`)      -> installHaDefaults()
 *   2. A theme is applied as INLINE custom properties on <html>, in this order: the default dark
 *      variables (dark mode only), the theme's own variables, the theme's variables for the mode;
 *      together with Home Assistant's "derived" defaults, plus `--rgb-<name>` for every hex colour
 *      that has no `rgb-<name>` of its own. Variables of the previous theme that the new one does not
 *      set are removed.                                                                              -> applyTheme()
 *   3. <html> gets the theme's `primary-background-color` as its background.
 * The theme data is real: Neumorphism (flat) and Frosted Glass (glass) as served by this Home Assistant's
 * `frontend/get_themes` (dev/fixtures/themes.json); the defaults come from the frontend source
 * (dev/fixtures/ha-defaults.json, refreshed with dev/tools/vendor-ha-defaults.mjs). */
import defaults from "../fixtures/ha-defaults.json";
import fixture from "../fixtures/themes.json";

export const THEME_NAMES = ["flat-light", "flat-dark", "glass-light", "glass-dark"] as const;
export type ThemeName = (typeof THEME_NAMES)[number];

type Variables = Record<string, string>;
type RawTheme = Record<string, unknown> & { modes?: Partial<Record<"light" | "dark", Variables>> };

interface EmulatedTheme {
  label: string;
  /** The Home Assistant theme this emulation is built from, and which of its modes. */
  theme: string;
  dark: boolean;
  /** The `:host { ... }` variable block card-mod puts on every card, or null (flat themes have none). */
  cardHost: string | null;
  /** A local stand-in for the theme's remote wallpaper, or null (flat themes paint no wallpaper). */
  wallpaper: string | null;
}

/** Home Assistant's `hass.themes.themes`: the raw theme objects by name. */
export const HA_THEMES = fixture.themes as unknown as Record<string, RawTheme>;
const EMULATED = fixture.emulated as unknown as Record<ThemeName, EmulatedTheme>;
const DARK_VARIABLES = defaults.darkVars as Variables;
const DERIVED_VARIABLES = defaults.derivedVars as Variables;

export function isThemeName(value: string | null | undefined): value is ThemeName {
  return (THEME_NAMES as readonly string[]).includes(value ?? "");
}

export interface AppliedTheme {
  name: ThemeName;
  label: string;
  /** Home Assistant's theme name (what `hass.selectedTheme.theme` carries). */
  haTheme: string;
  dark: boolean;
}

export function describeTheme(name: ThemeName): AppliedTheme {
  const { label, theme, dark } = EMULATED[name];
  return { name, label, haTheme: theme, dark };
}

/** Step 1: Home Assistant's default variables as a page stylesheet (once). */
export function installHaDefaults(): void {
  if (document.getElementById("ha-default-theme")) return;
  const style = document.createElement("style");
  style.id = "ha-default-theme";
  style.textContent = defaults.lightCss;
  document.head.append(style);
}

/** Custom properties the previous theme set inline on <html>, so the next one can remove what it does not set. */
const setByTheme = new Set<string>();

/** `#rgb` / `#rrggbb` / `#rrggbbaa` -> "r,g,b" like Home Assistant's hex2rgb (alpha ignored); undefined when it is not a hex colour. */
function hexToRgb(value: string): string | undefined {
  const digits = value.slice(1);
  const full = digits.length <= 4 ? [...digits].map((digit) => digit + digit).join("") : digits;
  if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(full)) return undefined;
  return [0, 2, 4].map((at) => parseInt(full.slice(at, at + 2), 16)).join(",");
}

/** Step 2: Home Assistant's `applyThemesOnElement` for <html> with a custom theme. */
function applyThemeVariables(root: HTMLElement, themeName: string, dark: boolean): void {
  const raw: RawTheme = HA_THEMES[themeName] ?? {};
  const { modes, ...base } = raw;
  const rules: Variables = dark ? { ...DARK_VARIABLES } : {};
  Object.assign(rules, base, modes?.[dark ? "dark" : "light"]);
  const combined = { ...DERIVED_VARIABLES, ...rules };
  const next = new Map<string, string>();
  for (const [key, entry] of Object.entries(combined)) {
    const value = String(entry);
    next.set(`--${key}`, value);
    if (value.startsWith("#") && combined[`rgb-${key}`] === undefined) {
      const rgb = hexToRgb(value);
      if (rgb) next.set(`--rgb-${key}`, rgb);
    }
  }
  for (const name of setByTheme) if (!next.has(name)) root.style.removeProperty(name);
  setByTheme.clear();
  for (const [name, value] of next) {
    root.style.setProperty(name, value);
    setByTheme.add(name);
  }
}

/** Switches the page to an emulated theme without a reload. Everything the toolkit reads (`--primary-color`, `--ha-card-*`, ...)
 * changes on <html>, so every `--lu-*` token follows. */
export function applyTheme(name: ThemeName): AppliedTheme {
  const emulated = EMULATED[name];
  const root = document.documentElement;
  applyThemeVariables(root, emulated.theme, emulated.dark);
  if (emulated.wallpaper) root.style.setProperty("--lovelace-background", emulated.wallpaper);
  // Not Home Assistant's doing (it leaves this to the OS): pinned so native controls, scrollbars and dialogs match the theme in screenshots.
  root.style.colorScheme = emulated.dark ? "dark" : "light";
  root.style.backgroundColor = getComputedStyle(root).getPropertyValue("--primary-background-color");
  syncCardContext(emulated.cardHost);
  return describeTheme(name);
}

/** card-mod puts a `:host { --ha-card-background: ... }` block on every Lovelace card; the harness gives every `ha-card` stand-in the same variables. */
function syncCardContext(cardHost: string | null): void {
  let style = document.getElementById("hx-card-context");
  if (!style) {
    style = document.createElement("style");
    style.id = "hx-card-context";
    document.head.append(style);
  }
  style.textContent = cardHost ? cardHost.replace(/^:host/, "ha-card") : "";
}
