/* Copied from lucent-ha dev/ha-frame.ts (MIT, same owner) and trimmed for the Kestrel harness. */
/** `<ha-frame>`: Home Assistant's chrome around a panel (home-assistant-main + ha-drawer + ha-sidebar of 2026.9).
 *
 * The rules are Home Assistant's own (src/layouts/home-assistant-main.ts):
 *   - sidebar mode is "narrow" when `narrow` (the viewport is 870px or less) or the user's setting is `always_hidden`;
 *     then the sidebar is a modal drawer (a top-layer <dialog>, 256px, scrim, closes on Escape/scrim/navigation);
 *   - the drawer is also used in kiosk mode (`hass.kioskMode`) and when the Companion app draws its own sidebar
 *     (`auth.external.config.hasSidebar`: then `hass-toggle-menu` sends `sidebar/show` to the app instead);
 *   - otherwise the sidebar is docked: `position: fixed`, z-index 6, 256px wide when `dockedSidebar === "docked"`
 *     and 56px (icons only) when it is `auto`, and the panel area is padded by the same width;
 *   - `hass-toggle-menu` {open?}: drawer mode toggles the drawer (`open ?? !open`); docked mode fires `hass-dock-sidebar`
 *     to switch between docked and auto;
 *   - the content safe-area insets are set for the panel: the docked sidebar absorbs the left inset, the drawer does not.
 * The panel is a light-DOM child (slotted), so `document.querySelector` finds the specimens. The frame holds no state of
 * Home Assistant's: `hass` and `narrow` come in as properties, `hass-dock-sidebar` goes out as an event. */
import { LitElement, css, html, type PropertyValues, type TemplateResult } from "lit";
import type { HomeAssistant } from "lucent-ha";
import { MDI_PATHS } from "./mdi-subset.ts";
import { PANEL_PREFIX, haNavigate } from "./panel.ts";

interface SidebarItem {
  label: string;
  icon: string;
  /** Where a click navigates; absent = decoration only. */
  path?: string;
}

const PANELS: SidebarItem[] = [
  { label: "Overview", icon: "view-dashboard", path: "/lovelace/0" },
  { label: "Map", icon: "map", path: "/map" },
  { label: "Logbook", icon: "file-document", path: "/logbook" },
  { label: "History", icon: "chart-timeline", path: "/history" },
  { label: "Energy", icon: "lightning-bolt", path: "/energy" },
  { label: "Media", icon: "play", path: "/media-browser" },
  { label: "To-do lists", icon: "check-all", path: "/todo" },
  { label: "Cameras", icon: "cctv", path: `${PANEL_PREFIX}/live` },
];
const FOOTER: SidebarItem[] = [
  { label: "Developer tools", icon: "console", path: "/developer-tools" },
  { label: "Settings", icon: "cog", path: "/config" },
  { label: "Notifications", icon: "bell" },
  { label: "Nitin", icon: "account-circle", path: "/profile" },
];

const icon = (name: string): TemplateResult => html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d=${MDI_PATHS[name] ?? ""}></path></svg>`;

export class HaFrame extends LitElement {
  static properties = {
    hass: { attribute: false },
    narrow: { type: Boolean },
    path: { state: true },
    drawerOpen: { state: true },
  };
  declare hass: HomeAssistant | undefined;
  declare narrow: boolean;
  declare path: string;
  declare drawerOpen: boolean;

  constructor() {
    super();
    this.narrow = false;
    this.path = location.pathname;
    this.drawerOpen = false;
  }

  /** Home Assistant's `_sidebarNarrow`: the sidebar is a drawer because of the width or the user's setting. */
  private get sidebarNarrow(): boolean {
    return this.narrow || this.hass?.dockedSidebar === "always_hidden";
  }

  private get externalSidebar(): boolean {
    return this.hass?.auth?.external?.config?.hasSidebar === true;
  }

  /** The sidebar is a modal drawer. */
  get modal(): boolean {
    return this.sidebarNarrow || this.externalSidebar || this.hass?.kioskMode === true;
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.addEventListener("hass-toggle-menu", this.onToggleMenu);
    window.addEventListener("location-changed", this.onLocation);
    window.addEventListener("popstate", this.onLocation);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.removeEventListener("hass-toggle-menu", this.onToggleMenu);
    window.removeEventListener("location-changed", this.onLocation);
    window.removeEventListener("popstate", this.onLocation);
  }

  /** Opens or closes the drawer (what `hass-toggle-menu` does in drawer mode). */
  setDrawer(open: boolean): void {
    this.drawerOpen = open;
  }

  private onToggleMenu = (event: Event): void => {
    const open = (event as CustomEvent<{ open?: boolean } | undefined>).detail?.open;
    if (this.externalSidebar) {
      this.hass?.auth?.external?.fireMessage?.({ type: "sidebar/show" });
    } else if (this.sidebarNarrow || this.hass?.kioskMode) {
      this.drawerOpen = open ?? !this.drawerOpen;
    } else {
      const dock = open ? "docked" : open === false ? "auto" : this.hass?.dockedSidebar === "auto" ? "docked" : "auto";
      this.dispatchEvent(new CustomEvent("hass-dock-sidebar", { detail: { dock }, bubbles: true, composed: true }));
    }
  };

  /** A route change closes the drawer (when the width or setting made the sidebar a drawer), like Home Assistant's `willUpdate(route)`. */
  private onLocation = (): void => {
    this.path = location.pathname;
    if (this.sidebarNarrow) this.drawerOpen = false;
  };

  protected willUpdate(changed: PropertyValues<this>): void {
    // Home Assistant sets these two on home-assistant-main; the styles below key off them.
    this.toggleAttribute("expanded", this.hass?.dockedSidebar === "docked");
    this.toggleAttribute("modal", this.modal);
    if ((changed.has("hass") || changed.has("narrow")) && !this.modal) this.drawerOpen = false;
  }

  protected updated(): void {
    const dialog = this.renderRoot.querySelector("dialog");
    if (!dialog) return;
    if (this.drawerOpen && !dialog.open) dialog.showModal();
    else if (!this.drawerOpen && dialog.open) dialog.close();
  }

  private renderSidebar(expanded: boolean): TemplateResult {
    const item = (entry: SidebarItem): TemplateResult => html`
      <a class="item ${entry.path === this.path || (entry.path === `${PANEL_PREFIX}/live` && this.path.startsWith(`${PANEL_PREFIX}/`)) ? "selected" : ""}" href=${entry.path ?? "#"} aria-label=${entry.label}
        @click=${(click: Event) => { click.preventDefault(); if (entry.path) haNavigate(entry.path); }}>
        ${icon(entry.icon)}<span class="label">${entry.label}</span>
      </a>`;
    return html`
      <nav class="sidebar ${expanded ? "expanded" : ""}" aria-label="Sidebar">
        <div class="menu">
          <button type="button" class="menu-button" aria-label="Sidebar toggle" @click=${() => this.dispatchEvent(new CustomEvent("hass-toggle-menu", { bubbles: true, composed: true }))}>${icon("menu")}</button>
          <span class="title">Home Assistant</span>
        </div>
        <div class="items">${PANELS.map(item)}</div>
        <div class="footer">${FOOTER.map(item)}</div>
      </nav>`;
  }

  protected render(): TemplateResult {
    if (this.modal) {
      return html`
        <slot></slot>
        <dialog class="drawer" aria-label="Sidebar" @close=${() => { this.drawerOpen = false; }} @click=${(click: Event) => { if (click.target === click.currentTarget) this.drawerOpen = false; }}>
          ${this.renderSidebar(true)}
        </dialog>`;
    }
    return html`
      <div class="layout">
        <div class="sidebar-shell">${this.renderSidebar(this.hass?.dockedSidebar === "docked")}</div>
        <div class="app-content"><slot></slot></div>
      </div>`;
  }

  static styles = css`
    :host {
      display: block;
      height: 100%;
      color: var(--primary-text-color);
      -webkit-tap-highlight-color: rgba(0, 0, 0, 0);
      --ha-sidebar-width: calc(56px + var(--safe-area-inset-left, 0px));
      --ha-top-app-bar-width: calc(100% - var(--ha-sidebar-width));
      --safe-area-content-inset-left: 0px;
      --safe-area-content-inset-right: var(--safe-area-inset-right);
    }
    :host([expanded]) { --ha-sidebar-width: calc(256px + var(--safe-area-inset-left, 0px)); }
    :host([modal]) {
      --ha-sidebar-width: unset;
      --ha-top-app-bar-width: 100%;
      --safe-area-content-inset-left: var(--safe-area-inset-left);
    }
    .layout { height: 100%; }
    .sidebar-shell {
      position: fixed;
      inset-block: 0;
      inset-inline-start: 0;
      width: var(--ha-sidebar-width);
      box-sizing: border-box;
      border-inline-end: 1px solid var(--divider-color, rgba(0, 0, 0, 0.12));
      transition: width var(--ha-animation-duration-normal, 250ms) ease;
      z-index: 6;
      background: var(--sidebar-background-color, var(--card-background-color));
      overflow: hidden;
    }
    .app-content {
      box-sizing: border-box;
      min-width: 0;
      width: 100%;
      height: 100%;
      padding-inline-start: var(--ha-sidebar-width);
      transition: padding-inline-start var(--ha-animation-duration-normal, 250ms) ease;
    }
    dialog.drawer {
      margin: 0;
      padding: 0;
      border: 0;
      width: 256px;
      max-width: 100vw;
      height: 100%;
      max-height: none;
      inset-block: 0;
      inset-inline: 0 auto;
      overflow: hidden;
      background: var(--sidebar-background-color, var(--card-background-color));
      color: var(--primary-text-color);
      box-shadow: var(--ha-box-shadow-l);
      transform: translateX(-100%);
      transition: transform var(--ha-animation-duration-normal, 250ms) ease, overlay var(--ha-animation-duration-normal, 250ms) allow-discrete, display var(--ha-animation-duration-normal, 250ms) allow-discrete;
    }
    :host(:dir(rtl)) dialog.drawer { inset-inline: auto 0; transform: translateX(100%); }
    dialog.drawer[open] { transform: none; }
    @starting-style {
      dialog.drawer[open] { transform: translateX(-100%); }
      :host(:dir(rtl)) dialog.drawer[open] { transform: translateX(100%); }
    }
    dialog.drawer::backdrop {
      background: var(--mdc-dialog-scrim-color, rgba(0, 0, 0, 0.32));
      opacity: 0;
      transition: opacity var(--ha-animation-duration-normal, 250ms) ease, overlay var(--ha-animation-duration-normal, 250ms) allow-discrete, display var(--ha-animation-duration-normal, 250ms) allow-discrete;
    }
    dialog.drawer[open]::backdrop { opacity: 1; }
    @starting-style { dialog.drawer[open]::backdrop { opacity: 0; } }

    .sidebar {
      display: flex;
      flex-direction: column;
      box-sizing: border-box;
      height: 100%;
      padding: var(--safe-area-inset-top, 0px) 0 var(--safe-area-inset-bottom, 0px) var(--safe-area-inset-left, 0px);
      color: var(--sidebar-text-color, var(--primary-text-color));
      font-family: var(--ha-font-family-body);
      font-size: var(--ha-font-size-m);
    }
    .menu { display: flex; align-items: center; flex: none; height: var(--header-height, 56px); padding-inline: 4px; gap: 4px; border-bottom: 1px solid var(--divider-color); box-sizing: content-box; }
    .title { display: none; font-size: var(--ha-font-size-xl); font-weight: var(--ha-font-weight-normal); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .menu-button { display: inline-grid; place-items: center; flex: none; width: 48px; height: 48px; padding: 0; border: 0; border-radius: 50%; background: none; color: var(--sidebar-icon-color); cursor: pointer; }
    .menu-button svg { width: 24px; height: 24px; fill: currentColor; }
    .menu-button:hover { background: color-mix(in srgb, currentColor 12%, transparent); }
    .items { flex: 1; overflow: hidden auto; padding-block: 4px; }
    .footer { flex: none; padding-block: 4px; border-top: 1px solid var(--divider-color); }
    .item { display: flex; align-items: center; gap: 12px; height: 48px; margin: 2px 8px; padding-inline: 12px; border-radius: 28px; color: var(--sidebar-text-color); text-decoration: none; font-weight: var(--ha-font-weight-medium); white-space: nowrap; overflow: hidden; }
    .item svg { flex: none; width: 24px; height: 24px; fill: var(--sidebar-icon-color); }
    .item:hover { background: color-mix(in srgb, var(--sidebar-text-color) 8%, transparent); }
    .item.selected { background: var(--sidebar-selected-background-color, color-mix(in srgb, var(--primary-color) 14%, transparent)); color: var(--sidebar-selected-text-color); }
    .item.selected svg { fill: var(--sidebar-selected-icon-color); }
    .label { display: none; overflow: hidden; text-overflow: ellipsis; }
    .sidebar.expanded .label, .sidebar.expanded .title { display: block; }
    .sidebar:not(.expanded) .item { justify-content: center; padding-inline: 0; margin-inline: 4px; }
    .sidebar:not(.expanded) .menu { justify-content: center; }
    @media (prefers-reduced-motion: reduce) { .sidebar-shell, .app-content { transition: none; } }
  `;
}
