import {
  ReconnectController, TabHistory, clearSwr, findScroller, goBack, mutateSwr, navigate, showMenuButton, showToast, swr, toggleHaMenu,
  type LuAppShell, type LuDestination, type LuNavigateDetail, type LuRoot, type LuViewEventDetail, type LuViewStack, type ToastOptions,
} from "lucent-ha";
import { LitElement, html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { keyed } from "lit/directives/keyed.js";
import { repeat } from "lit/directives/repeat.js";
import { api, asVisit, cameraArray, cameraPicture, extractLabels, isNotFound, routePath, routeView, speciesArray, speciesFromLocation, speciesPhoto, speciesPicture, speciesReferencePhoto, visitAudio, visitAudioOriginal, visitClip, visitIdFromLocation, visitPage, visitSnapshot } from "../api.ts";
import { ago, clamp, dateTime, formatMiB, sentence, timestamp, when } from "../format.ts";
import { RETRY_MS, isSigned, signatureRejected } from "../recovery.ts";
import { PANEL_CSS } from "../styles/panel.ts";
import type { AudioInfo, Camera, CameraDetection, Health, HomeAssistant, KestrelCardConfig, KestrelPush, Settings, Species, Visit, VisitSuggestion } from "../types.ts";
import { heardHero } from "../ui/heard-hero.ts";
import { forgetStableUrls, keptLink, sameMedia } from "../urls.ts";
import { GROUP_LABEL, KIND, asKind, evidenceCount, evidenceWord, recordingNotes } from "../vocab.ts";
import { filterCounts, lastActivity, matchesFilter, recentSighting, rememberFilter, rememberedFilter, type SpeciesFilter } from "../wildlife.ts";
import "../ui/live-picture.ts";
import "./kestrel-live-player.ts";
import { forgetSheetCache, forgetVisit } from "./kestrel-species-sheet.ts";
import type { KestrelLivePlayer } from "./kestrel-live-player.ts";
import type { KestrelSpeciesSheet } from "./kestrel-species-sheet.ts";

/** Views that stay in the page once shown, hidden while away, so coming back costs a repaint, not a rebuild. */
type CachedView = "live" | "wildlife" | "insights";
type View = CachedView | "visit";
type PendingUndo = { visitId: string; before?: Visit | null };
interface Route { view: View; visitId: string | null; species: string | null }

const TABS = [
  { id: "live", label: "Live", icon: "mdi:cctv" },
  { id: "wildlife", label: "Wildlife", icon: "mdi:paw" },
  { id: "insights", label: "AI check-up", icon: "mdi:heart-pulse" },
] as const satisfies readonly { id: CachedView; label: string; icon: string }[];
const NO_DESTINATIONS: readonly LuDestination[] = [];
/** How long Live keeps streaming after another view is opened: long enough for the new view to paint first. */
const LIVE_GRACE_MS = 250;
const SCRYPTED_URL = "https://192.168.1.69:10443";
/** The last cameras and species, kept in memory and (for 6 hours, as long as their signed links are good for) in storage,
 * so the panel paints real content at once, also when Home Assistant has re-created it. Change the name when the shape changes. */
const CAMERAS_KEY = "kestrel/cameras/v1";
const SPECIES_KEY = "kestrel/species/v1";
const STORE = { maxAgeMs: 30_000, persist: { maxAgeMs: 6 * 3_600_000 } } as const;
const USER_KEY = "kestrel.user";
/** The Live picture asks for fresh links at most this often when one is refused. */
const EXPIRED_REFRESH_MS = 60_000;
/** A picture that fails to load is checked against the server at most this often. */
const MEDIA_CHECK_MS = 30_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, ms));

export class KestrelCameras extends LitElement {
  static properties = {
    hass: { attribute: false },
    narrow: { type: Boolean },
    _config: { state: true },
    _view: { state: true },
    _mounted: { state: true },
    _visitId: { state: true },
    _cameras: { state: true },
    _visit: { state: true },
    _species: { state: true },
    _review: { state: true },
    _health: { state: true },
    _settings: { state: true },
    _error: { state: true },
    _loading: { state: true },
    _selectedCamera: { state: true },
    _selectedSpecies: { state: true },
    _sheetSpecies: { state: true },
    _speciesFilter: { state: true },
    _labels: { state: true },
    _pickerOpen: { state: true },
    _pickerMounted: { state: true },
    _search: { state: true },
    _saving: { state: true },
    _progress: { state: true },
    _helpOpen: { state: true },
    _helpMounted: { state: true },
    _visitGone: { state: true },
    _callVisit: { state: true },
    _livePaused: { state: true },
    _tick: { state: true },
    _speciesVisible: { state: true },
    _audioLoading: { state: true },
    _audioUrl: { state: true },
    _visitReferencePhoto: { state: true },
    _visitReferencePhotoFailed: { state: true },
    _heardConfirmed: { state: true },
    _epoch: { state: true },
  };

  declare _config: KestrelCardConfig;
  declare _view: View;
  /** The views that have been opened and are kept alive (the view stack keeps at most four). */
  declare _mounted: View[];
  declare _visitId: string | null;
  declare _cameras: Camera[];
  declare _visit: Visit | null;
  declare _species: Species[];
  declare _review: Visit[];
  declare _health: Health | null;
  declare _settings: Settings | null;
  declare _error: string;
  declare _loading: boolean;
  declare _selectedCamera: string | null;
  /** The species the ADDRESS names (`?s=`): the single source of truth for whether its sheet is open. */
  declare _selectedSpecies: string | null;
  /** Whose sheet is drawn. Kept until the sheet has finished closing, so it does not blank mid-exit. */
  declare _sheetSpecies: string;
  declare _speciesFilter: SpeciesFilter;
  declare _labels: string[];
  declare _pickerOpen: boolean;
  declare _pickerMounted: boolean;
  declare _search: string;
  declare _saving: boolean;
  declare _progress: number;
  declare _helpOpen: boolean;
  declare _helpMounted: boolean;
  /** The id of a visit the server no longer has (merged into another or removed), and the camera it was from. */
  declare _visitGone: { id: string; camera: { id: string; name: string } | null } | null;
  /** Live is out of sight and its streams have been stopped (after a short grace, so flipping tabs doesn't restart them). */
  declare _livePaused: boolean;
  /** The sound recorded near the open sighting, once its player has been asked for. */
  declare _callVisit: Visit | null;
  /** Bumped every half minute so "3 min ago" stays true while nothing else happens. */
  declare _tick: number;
  declare _speciesVisible: number;
  declare _audioLoading: string | null;
  declare _audioUrl: string | null;
  declare _visitReferencePhoto: string | null;
  declare _visitReferencePhotoFailed: boolean;
  declare _heardConfirmed: boolean;
  /** Counts the times every signed link was thrown away; audio players start over with it. */
  declare _epoch: number;
  declare narrow: boolean;

  private _hass?: HomeAssistant;
  private _connection?: HomeAssistant["connection"];
  private _unsubscribe?: () => Promise<void>;
  private _subscriptionVersion = 0;
  /** How many times the connection has come back; a subscription made before the last time is gone with the old connection. */
  private _reconnects = 0;
  private _subscribedAt = 0;
  private _generation = 0;
  private _clipTimer?: number;
  /** "connected" | "grace" | "lost": for ten seconds after a drop the last data stays and a quiet strip says so. */
  private readonly _link = new ReconnectController(this, { getHass: () => this._hass });
  private _linkSeen = this._link.state;
  private _tabs?: TabHistory;
  private _destinations: LuDestination[] = [];
  private _visitSeeds = new Map<string, Visit>();
  private _mountedSet = new Set<View>();
  private _frozen = new Map<CachedView, TemplateResult>();
  private _frozenLivePaused = false;
  private _livePauseTimer?: number;
  private _clockTimer?: number;
  private _failedReferenceImages = new Set<string>();
  private static _nvrComponentsPromise: Promise<void> | undefined;
  private _pendingUndo: PendingUndo | null = null;
  private _routeKey = "";
  private _storesOpened = false;
  /** Between connectedCallback and disconnectedCallback. Not `isConnected`: that is already true while the element is still being upgraded, before connectedCallback has run. */
  private _started = false;
  private _recoverRun = 0;
  private _lastPictureRefresh = 0;
  private _lastMediaCheck = 0;
  private _camerasSignature = "";
  private _speciesSignature = "";

  constructor() {
    super();
    this._config = { type: "custom:kestrel-cameras", view: "live" };
    this._view = "live";
    this._mounted = [];
    this._visitId = null;
    this._cameras = [];
    this._visit = null;
    this._species = [];
    this._review = [];
    this._health = null;
    this._settings = null;
    this._error = "";
    this._loading = true;
    this._selectedCamera = null;
    this._selectedSpecies = null;
    this._sheetSpecies = "";
    this._speciesFilter = rememberedFilter();
    this._labels = [];
    this._pickerOpen = false;
    this._pickerMounted = false;
    this._search = "";
    this._saving = false;
    this._progress = 0;
    this._helpOpen = false;
    this._helpMounted = false;
    this._visitGone = null;
    this._livePaused = false;
    this._callVisit = null;
    this._tick = 0;
    this._speciesVisible = 24;
    this._audioLoading = null;
    this._audioUrl = null;
    this._visitReferencePhoto = null;
    this._visitReferencePhotoFailed = false;
    this._heardConfirmed = false;
    this._epoch = 0;
    this.narrow = false;
  }

  get hass(): HomeAssistant { return this._hass as HomeAssistant; }
  set hass(value: HomeAssistant) {
    const previous = this._hass;
    this._hass = value;
    // Home Assistant hands over a new `hass` for every change in the house: the children that need it get it directly, and the
    // panel itself only renders again when something it draws changed (see `shouldUpdate`).
    for (const child of this.renderRoot?.querySelectorAll<LuAppShell | KestrelLivePlayer | KestrelSpeciesSheet>("kestrel-lu-app-shell, kestrel-live-player, kestrel-species-sheet") ?? []) child.hass = value;
    this.requestUpdate("hass", previous);
    // The reconnect watch follows the connection; it is told when the connection object changes, because the panel may not render for this.
    if (value?.connection !== previous?.connection) this._link.hostUpdate();
    if (this._started) this._ensureConnection();
  }

  setConfig(config: KestrelCardConfig): void {
    this._config = { ...config, view: config.view ?? "live" };
    this._syncRoute(false);
    this.requestUpdate();
    if (this._started) void this._loadForView();
  }

  getCardSize(): number { return 8; }
  static getStubConfig(): KestrelCardConfig { return { type: "custom:kestrel-cameras", view: "live" }; }

  private get _isPanel(): boolean { return this.localName === "kestrel-panel"; }

  connectedCallback(): void {
    super.connectedCallback();
    this._generation++;
    this._started = true;
    window.addEventListener("location-changed", this._onLocationChanged);
    window.addEventListener("popstate", this._onLocationChanged);
    this.addEventListener("lu-image-error", this._onMediaError);
    this._syncRoute(false);
    this._tabs = new TabHistory({ defaultId: "live", initialId: this._view === "visit" ? "live" : this._view });
    this._clockTimer = window.setInterval(() => { if (document.visibilityState === "visible" && this._view !== "visit") this._tick++; }, 30_000);
    this._ensureConnection();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this._started = false;
    this._generation++;
    this._recoverRun++;
    window.removeEventListener("location-changed", this._onLocationChanged);
    window.removeEventListener("popstate", this._onLocationChanged);
    this.removeEventListener("lu-image-error", this._onMediaError);
    this._tabs?.dispose();
    this._tabs = undefined;
    window.clearTimeout(this._livePauseTimer);
    window.clearInterval(this._clockTimer);
    this._clearClipTimer();
    void this._stopSubscription();
  }

  protected shouldUpdate(changed: PropertyValues<this>): boolean {
    // The connection's own event asks for an update together with the `hass` that says it dropped, and Lit merges the two: the update then
    // looks like "only hass changed". The link state is checked first for that reason.
    if (this._link.state !== this._linkSeen) return true;
    if (changed.size === 0) return true;
    return [...changed.keys()].some((key) => key !== "hass");
  }

  protected willUpdate(): void {
    if (this._hass && !this._storesOpened) this._openStores();
    // The connection came back: whatever is on screen may be old now, and after a restart its pictures and recordings are refused.
    const link = this._link.state;
    if (link === "connected" && this._linkSeen !== "connected") {
      this._reconnects += 1;
      void this._recover();
    }
    this._linkSeen = link;
  }

  // ---- what is remembered ------------------------------------------------------------------------------------------------------

  /** Registers the cameras and species with the shared cache; its saved copy (if any) is what the first render shows. */
  private _openStores(): void {
    this._storesOpened = true;
    this._checkIdentity();
    const cameras = this._cameraStore();
    const species = this._speciesStore();
    if (cameras.data?.length) { this._camerasSignature = JSON.stringify(cameras.data.slice(0, 32)); this._cameras = cameras.data.slice(0, 32); }
    if (species.data?.length) { this._speciesSignature = JSON.stringify(species.data.slice(0, 500)); this._species = species.data.slice(0, 500); }
  }

  /** Saved copies belong to whoever was signed in when they were made. */
  private _checkIdentity(): void {
    const id = this._hass?.user?.id;
    if (!id) return;
    try {
      const known = window.localStorage.getItem(USER_KEY);
      if (known !== null && known !== id) clearSwr();
      if (known !== id) window.localStorage.setItem(USER_KEY, id);
    } catch { /* storage blocked: nothing is saved either */ }
  }

  private _cameraStore() {
    return swr<Camera[]>(CAMERAS_KEY, async () => cameraArray(await api.cameras(this._requireHass())), STORE);
  }

  private _speciesStore() {
    return swr<Species[]>(SPECIES_KEY, async () => speciesArray(await api.species(this._requireHass())), STORE);
  }

  private _requireHass(): HomeAssistant {
    if (!this._hass) throw new Error("Home Assistant is not connected.");
    return this._hass;
  }

  /** Asks the server for the cameras (sharing a request that is already running) and resolves with the answer. */
  private async _fetchCameras(): Promise<Camera[]> {
    const handle = this._cameraStore();
    const snapshot = await (handle.pending ?? handle.revalidate());
    if (snapshot.error !== undefined || snapshot.data === undefined) throw snapshot.error ?? new Error("No cameras");
    return snapshot.data;
  }

  private async _fetchSpecies(): Promise<Species[]> {
    const handle = this._speciesStore();
    const snapshot = await (handle.pending ?? handle.revalidate());
    if (snapshot.error !== undefined || snapshot.data === undefined) throw snapshot.error ?? new Error("No species");
    return snapshot.data;
  }

  // ---- the address -------------------------------------------------------------------------------------------------------------

  private _liveIsPaused(): boolean { return this._livePaused && this._view !== "live"; }

  /** A picture link the server no longer accepts: the signing key changed. Ask for everything again (links are signed afresh), at most once a minute. */
  private _onPictureExpired = (): void => {
    const now = Date.now();
    if (now - this._lastPictureRefresh < EXPIRED_REFRESH_MS) return;
    this._lastPictureRefresh = now;
    void this._recover(true);
  };

  /** A picture failed for good. When its link is a signed one, ask the server whether the signature is what failed. */
  private _onMediaError = (event: Event): void => {
    const src = (event as CustomEvent<{ src?: string }>).detail?.src;
    if (!isSigned(src)) return;
    const now = Date.now();
    if (now - this._lastMediaCheck < MEDIA_CHECK_MS) return;
    this._lastMediaCheck = now;
    void signatureRejected(src).then((rejected) => { if (rejected) void this._recover(true); });
  };

  private _onViewShown = (event: CustomEvent<LuViewEventDetail>): void => {
    if (event.detail.id !== "live") return;
    window.clearTimeout(this._livePauseTimer);
    this._livePaused = false;
  };

  private _onViewHidden = (event: CustomEvent<LuViewEventDetail>): void => {
    if (event.detail.id !== "live") return;
    window.clearTimeout(this._livePauseTimer);
    this._livePauseTimer = window.setTimeout(() => { this._livePaused = true; }, LIVE_GRACE_MS);
  };

  private _onViewEvict = (event: CustomEvent<LuViewEventDetail>): void => {
    const id = event.detail.id as View;
    this._mounted = this._mounted.filter((view) => view !== id);
    this._mountedSet.delete(id);
    if (id !== "visit") this._frozen.delete(id);
  };

  private _isActive(generation = this._generation): boolean {
    return this.isConnected && generation === this._generation;
  }

  private _ensureConnection(): void {
    if (!this._hass || !this._started) return;
    const connection = this._hass.connection;
    if (this._connection === connection) return;
    void this._stopSubscription();
    this._connection = connection;
    void this._subscribe().catch(() => {
      if (this.isConnected) this._setError("Live updates are unavailable. Try refreshing this view.");
    });
    void this._loadForView();
    void this._checkKeptLinks();
  }

  /** Home Assistant re-creates the panel when you come back to it, and the page (with the links it kept) lives on. If Home Assistant restarted
   * in between, those links are dead and would be handed out again for hours, so the first thing a new panel does is ask the server about one. */
  private async _checkKeptLinks(): Promise<void> {
    const link = keptLink();
    if (link && (await signatureRejected(link)) === true && this._started) void this._recover(true);
  }

  /** Subscribes to Kestrel's push events. The panel does this itself after a reconnect (`resubscribe: false`), because right after
   * Home Assistant starts the integration may not be loaded yet and a subscription the library renewed on its own would just fail. */
  private async _subscribe(): Promise<void> {
    const connection = this._hass?.connection;
    if (!connection || !this.isConnected) return;
    const version = ++this._subscriptionVersion;
    const previous = this._unsubscribe;
    this._unsubscribe = undefined;
    // A subscription made before the last reconnect died with the old connection; one made since is still there and is replaced, not doubled.
    if (previous && this._subscribedAt === this._reconnects) void previous().catch(() => undefined);
    const unsubscribe = await connection.subscribeMessage<KestrelPush>((message) => this._onPush(message), { type: "kestrel/subscribe" }, { resubscribe: false });
    if (!this.isConnected || version !== this._subscriptionVersion || this._connection !== connection) {
      void unsubscribe();
      return;
    }
    this._unsubscribe = unsubscribe;
    this._subscribedAt = this._reconnects;
  }

  private async _stopSubscription(): Promise<void> {
    this._subscriptionVersion++;
    const stop = this._unsubscribe;
    this._unsubscribe = undefined;
    this._connection = undefined;
    // A subscription made before the last reconnect died with the old connection; asking to end it could end somebody else's.
    if (stop && this._subscribedAt === this._reconnects) {
      try { await stop(); } catch { /* subscription already ended */ }
    }
  }

  private _readRoute(): Route {
    const view = (routeView(this._config) ?? "live") as View;
    return { view, visitId: visitIdFromLocation(), species: view === "wildlife" ? speciesFromLocation() : null };
  }

  private _syncRoute(load = true): void {
    this._applyRoute(this._readRoute(), load);
  }

  /** Makes `route` the page. Taps call this themselves, so the page changes in the very frame of the tap; the address reports the same
   * change a moment later (`location-changed`, `popstate`) and nothing happens then. */
  private _applyRoute(route: Route, load = true): void {
    const { view, visitId, species } = route;
    const key = `${view}:${visitId ?? ""}:${species ?? ""}`;
    if (key === this._routeKey) return;
    this._routeKey = key;
    this._destinations = TABS.map((tab) => ({ ...tab, href: routePath(tab.id) }));
    const oldView = this._view;
    const oldVisitId = this._visitId;
    // A detail page reuses one view for different visits: the next visit starts at the top, not where the last one was left.
    if (view === "visit" && visitId !== oldVisitId) {
      this._stack()?.forgetScroll("visit");
      if (oldView === "visit") findScroller(this).scrollTo(0); // the page is already showing: the next visit starts at the top as well
    }
    // New views go after the ones already rendered, so nothing above the one you are on can move.
    if (!this._mountedSet.has(view)) { this._mountedSet.add(view); this._mounted = [...this._mounted, view]; }
    this._view = view;
    this._visitId = visitId;
    this._selectedSpecies = species;
    if (species) this._sheetSpecies = species;
    if (view !== oldView) {
      // Opening a visit from a focused camera and coming Back lands on that camera again; moving between tabs starts at the grid.
      if (view !== "visit" && oldView !== "visit") this._selectedCamera = null;
      this._audioUrl = null;
      this._visitReferencePhoto = null;
      this._visitReferencePhotoFailed = false;
    }
    if (visitId !== oldVisitId) {
      // A visit opened from a list already has its picture and clip; show them while the full record loads.
      this._visit = visitId ? this._visitSeeds.get(visitId) ?? null : null;
      this._audioUrl = this._visit ? visitAudio(this._visit) : null;
      this._heardConfirmed = false;
      this._callVisit = null;
      this._visitGone = null;
      this._visitReferencePhoto = null;
      this._visitReferencePhotoFailed = false;
    }
    if (load && (view !== oldView || visitId !== oldVisitId)) void this._loadForView();
  }

  private _onLocationChanged = (): void => { this._syncRoute(true); };

  private _stack(): LuViewStack | null {
    return this.renderRoot?.querySelector<LuViewStack>("kestrel-lu-view-stack") ?? null;
  }

  private _shell(): LuAppShell | null {
    return this.renderRoot?.querySelector<LuAppShell>("kestrel-lu-app-shell") ?? null;
  }

  /** The element that knows the panel's width and device profile: the shell of a panel, the root of a card. */
  private _scaffold(): LuAppShell | LuRoot | null {
    return this._shell() ?? this.renderRoot?.querySelector<LuRoot>("kestrel-lu-root") ?? null;
  }

  private _onPush(message: KestrelPush): void {
    const event = message?.event;
    if (!event) return;
    if (event.type === "camera") {
      // The event carries the whole camera list and is only sent when something changed, so use it as is.
      const cameras = cameraArray(event.data);
      if (cameras.length && typeof cameras[0]?.name === "string") { mutateSwr<Camera[]>(CAMERAS_KEY, () => cameras); this._setCameras(cameras); }
      else if (this._view === "live") void this._loadCameras();
      if (this._view === "insights") void this._loadHealth();
      return;
    }
    if (event.type === "visit_deleted") {
      const data = event.data as Record<string, unknown> | null;
      const id = data && (data.id ?? data.visit_id);
      this._onVisitDeleted(id === undefined || id === null ? "" : String(id));
      return;
    }
    if (event.type === "visit_new" || event.type === "visit_updated") {
      if (this._view === "visit" && this._visitId) {
        const data = event.data as Record<string, unknown> | null;
        const eventId = data && (data.id ?? data.visit_id);
        if (!eventId || String(eventId) === this._visitId) void this._loadVisit(this._visitId);
      } else if (this._view === "wildlife") {
        void this._loadSpecies();
        void this.renderRoot.querySelector<KestrelSpeciesSheet>("kestrel-species-sheet")?.refresh();
      } else if (this._view === "insights") {
        void this._loadReview();
      }
    }
  }

  /** A visit was merged into another or removed: take it out of everything that shows it. */
  private _onVisitDeleted(id: string): void {
    if (!id) { if (this._view === "wildlife") void this._loadSpecies(); return; }
    this._visitSeeds.delete(id);
    forgetVisit(id);
    this._review = this._review.filter((visit) => visit.id !== id);
    if (this._cameras.some((camera) => camera.lastDetection?.visitId === id)) {
      const cameras = this._cameras.map((camera) => camera.lastDetection?.visitId === id ? { ...camera, lastDetection: null } : camera);
      mutateSwr<Camera[]>(CAMERAS_KEY, () => cameras);
      this._setCameras(cameras);
    }
    this.renderRoot.querySelector<KestrelSpeciesSheet>("kestrel-species-sheet")?.forget(id);
    if (this._view === "visit" && this._visitId === id) {
      const camera = this._visit?.camera;
      this._visitGone = { id, camera: camera ? { id: String(camera.id), name: camera.name } : null };
      this._visit = null;
      this._clearClipTimer();
    }
    if (this._view === "wildlife") void this._loadSpecies(); // the counts changed
  }

  private _setError(message: string): void {
    this._error = message;
    this.requestUpdate();
  }

  // ---- loading -----------------------------------------------------------------------------------------------------------------

  private async _loadForView(): Promise<void> {
    if (!this._hass || !this._started) return;
    this._error = "";
    const generation = this._generation;
    const view = this._view;
    // Only show a loading state when there is nothing to show yet; otherwise refresh behind what's on screen.
    this._loading = view === "live" ? !this._cameras.length : view === "wildlife" ? !this._species.length : view === "visit" ? !this._visit : !this._health && !this._review.length;
    try {
      await this._loadView(view, generation);
    } catch {
      if (this._isActive(generation)) this._setError(`Kestrel couldn't load ${view === "insights" ? "the check-up" : view === "visit" ? "this visit" : view === "wildlife" ? "wildlife records" : "the cameras"}. Check the connection and try again.`);
    } finally {
      if (this._isActive(generation)) this._loading = false;
    }
  }

  /** Loads what `view` shows. Rejects when the main request failed. */
  private async _loadView(view: View, generation: number): Promise<void> {
    if (view === "live") await this._loadCameras(generation);
    else if (view === "visit") {
      if (this._visitId) await this._loadVisit(this._visitId, generation);
      else this._visit = null;
    } else if (view === "wildlife") await this._loadWildlife(generation);
    else await this._loadInsights(generation);
  }

  private async _loadCameras(generation = this._generation): Promise<void> {
    if (!this._hass) return;
    this._ensureNvrComponents();
    const cameras = await this._fetchCameras();
    if (this._isActive(generation)) this._setCameras(cameras);
  }

  /** Replacing a list that hasn't changed would still re-render every tile, so an identical refresh is dropped. */
  private _setCameras(cameras: Camera[]): void {
    const next = cameras.slice(0, 32);
    const signature = JSON.stringify(next);
    if (signature === this._camerasSignature && this._cameras.length) return;
    this._camerasSignature = signature;
    this._cameras = next;
  }

  private _setSpecies(species: Species[]): void {
    const next = species.slice(0, 500);
    const signature = JSON.stringify(next);
    if (signature === this._speciesSignature && this._species.length) return;
    this._speciesSignature = signature;
    this._species = next;
  }

  private _ensureNvrComponents(): void {
    const hass = this._hass;
    if (KestrelCameras._nvrComponentsPromise || !hass) return;
    KestrelCameras._nvrComponentsPromise = (async () => {
      if (customElements.get("scrypted-nvr-camera")) return;
      try {
        const resources = await hass.callWS<Array<{ url: string; type: string }>>({ type: "lovelace/resources" });
        const resource = resources.find((item) => item.type === "module" && item.url.includes("/endpoint/@scrypted/nvr/assets/web-components.js"));
        // Dynamic import: the module URL is fetched at runtime from HA's Lovelace resource
        // registry (Scrypted's own server id is embedded in it), never known at build time.
        if (resource) await import(resource.url);
      } catch { /* live camera tiles fall back to their static placeholder */ }
    })();
  }

  private async _loadVisit(id: string, generation = this._generation): Promise<void> {
    if (!this._hass || !id) return;
    if (!this._visit) this._loading = true;
    let response: Visit;
    try { response = await api.visit(this._hass, id); }
    catch (error) {
      if (!isNotFound(error)) throw error;
      // Merged into another sighting or removed: an old notification can point at it. Not a failure.
      if (this._isActive(generation) && id === this._visitId) {
        const camera = this._visit?.camera;
        this._visitGone = { id, camera: camera ? { id: String(camera.id), name: camera.name } : null };
        this._visitSeeds.delete(id);
        this._visit = null;
        this._clearClipTimer();
      }
      return;
    }
    if (!this._isActive(generation) || id !== this._visitId) return;
    const visit = asVisit(response);
    if (!visit) throw new Error("Visit response was empty");
    this._visit = visit;
    this._audioUrl = visitAudio(visit);
    this._visitReferencePhoto = null;
    this._visitReferencePhotoFailed = false;
    if (visit.kind === "heard" && !visitSnapshot(visit) && this._hass) {
      try {
        const detail = await api.speciesDetail(this._hass, visit.species);
        if (this._isActive(generation) && id === this._visitId) this._visitReferencePhoto = speciesReferencePhoto(detail);
      } catch { /* fall back to the heard-only hero */ }
    }
    this._syncClipTimer();
  }

  private async _loadWildlife(generation = this._generation): Promise<void> {
    if (!this._hass) return;
    const [speciesResult, settingsResult, camerasResult] = await Promise.allSettled([this._fetchSpecies(), api.settings(this._hass), this._fetchCameras()]);
    if (!this._isActive(generation)) return;
    if (speciesResult.status === "fulfilled") this._setSpecies(speciesResult.value);
    if (settingsResult.status === "fulfilled" && JSON.stringify(settingsResult.value) !== JSON.stringify(this._settings)) this._settings = settingsResult.value;
    if (camerasResult.status === "fulfilled") this._setCameras(camerasResult.value);
    if (speciesResult.status === "rejected") throw speciesResult.reason;
  }

  private async _loadSpecies(): Promise<void> {
    if (!this._hass) return;
    try { this._setSpecies(await this._fetchSpecies()); }
    catch { /* keep the last good species list */ }
  }

  private async _loadInsights(generation = this._generation): Promise<void> {
    if (!this._hass) return;
    const results = await Promise.allSettled([api.health(this._hass), api.review(this._hass), this._fetchCameras()]);
    if (!this._isActive(generation)) return;
    const [health, review, cameras] = results;
    if (health.status === "fulfilled") this._health = health.value;
    if (review.status === "fulfilled") this._review = visitPage(review.value).items.slice(0, 24);
    if (cameras.status === "fulfilled") this._setCameras(cameras.value);
    if (health.status === "rejected" && review.status === "rejected") throw health.reason;
  }

  private async _loadReview(): Promise<void> {
    if (!this._hass) return;
    try { this._review = visitPage(await api.review(this._hass)).items.slice(0, 24); }
    catch { /* preserve the last good queue */ }
  }

  private async _loadHealth(): Promise<void> {
    if (!this._hass) return;
    try { this._health = await api.health(this._hass); }
    catch { /* preserve the last good health snapshot */ }
  }

  private async _loadLabels(): Promise<void> {
    if (!this._hass || this._labels.length) return;
    try { this._labels = extractLabels(await api.labels(this._hass)).slice(0, 500); }
    catch { this._say({ message: "Species search is unavailable. Try again shortly.", kind: "error", durationMs: 4500 }); }
  }

  // ---- after the connection came back --------------------------------------------------------------------------------------------

  /** Signed links on screen, to ask the server about: the ones of the page you are on first, cheap ones before pictures that are made on demand. */
  private _probeUrls(): string[] {
    const links: string[] = [];
    const add = (url: string | null | undefined): void => { if (isSigned(url) && !links.includes(url)) links.push(url); };
    const species = () => { for (const item of this._species) { add(speciesPhoto(item)); add(speciesPicture(item).url); } };
    if (this._view === "visit" && this._visit) { add(visitSnapshot(this._visit)); add(this._visitReferencePhoto); add(this._audioUrl); }
    if (this._view === "live") for (const camera of this._cameras) add(cameraPicture(camera));
    species();
    if (this._visit) add(visitSnapshot(this._visit));
    return links.slice(0, 3);
  }

  /** Every link kept from before is dead: forget them, so the next answers are taken as they come. */
  private _forgetSignedState(): void {
    forgetStableUrls();
    forgetSheetCache();
    this._visitSeeds.clear();
    this._failedReferenceImages = new Set();
    this._visitReferencePhotoFailed = false;
    this._callVisit = null;
    this._epoch += 1;
  }

  /** The connection came back, or a signed link was refused. Fetch everything that is on screen again. When the signing key changed
   * (Home Assistant restarted) every link held is dead, so those are thrown away first. Right after a start the Kestrel integration
   * may not be loaded yet and its commands fail for a few seconds: try again, a little later each time. */
  private async _recover(signaturesDead = false): Promise<void> {
    const run = ++this._recoverRun;
    let dead = signaturesDead;
    let checked = signaturesDead;
    for (let attempt = 0; ; attempt += 1) {
      if (run !== this._recoverRun || !this.isConnected || !this._hass) return;
      try {
        if (!checked) {
          let verdict: boolean | null = false;
          for (const link of this._probeUrls()) {
            verdict = await signatureRejected(link);
            if (verdict !== false) break;
          }
          if (verdict === null) throw new Error("Home Assistant is not answering yet");
          dead = verdict;
          checked = true;
        }
        if (dead) { this._forgetSignedState(); dead = false; checked = true; this._reloadSheets = true; }
        if (!this._unsubscribe || this._subscribedAt !== this._reconnects) await this._subscribe();
        const generation = this._generation;
        await this._loadView(this._view, generation);
        // The other lists feed names and pictures elsewhere: Live, Wildlife and the check-up fetch the cameras, only Wildlife fetches the species.
        if (this._view === "visit") await this._loadCameras(generation);
        if (this._view !== "wildlife") this._setSpecies(await this._fetchSpecies());
        const sheet = this.renderRoot.querySelector<KestrelSpeciesSheet>("kestrel-species-sheet");
        if (sheet && !(await (this._reloadSheets ? sheet.reload() : sheet.refresh()))) throw new Error("The species sheet could not be refreshed");
        this._reloadSheets = false;
        return;
      } catch {
        const wait = RETRY_MS[attempt];
        if (wait === undefined) {
          if (run === this._recoverRun) { this._setError("Kestrel couldn't refresh after the connection came back. Check the connection and try again."); }
          return;
        }
        await sleep(wait);
      }
    }
  }

  /** The species sheet starts over from its first page once every link it holds is dead. */
  private _reloadSheets = false;

  // ---- what the user does ------------------------------------------------------------------------------------------------------

  private _path(view: View, search = ""): string { return routePath(view, search); }

  /** The species sheet is the address (`?s=`): tapping a tile puts it there, Back takes it out again. */
  private _openSpecies(name: string): void {
    this._applyRoute({ view: "wildlife", visitId: null, species: name });
    navigate(this, this._path("wildlife", `?s=${encodeURIComponent(name)}`));
  }

  /** The sheet finished closing (button, Escape, scrim, swipe, or the address changed). When the address still names the species, take it out. */
  private _onSpeciesClose = (): void => {
    this._sheetSpecies = "";
    if (this._selectedSpecies) goBack(this, this._path("wildlife"));
  };

  private _onOpenVisit(event: Event): void {
    const { id, visit } = (event as CustomEvent<{ id: string; visit?: Visit }>).detail;
    if (visit) this._seedVisit(visit);
    this._openVisit(id);
  }

  private _onWarmVisit(event: Event): void { this._warmVisit((event as CustomEvent<{ id: string }>).detail.id); }

  private _seedVisit(visit: Visit): void {
    this._visitSeeds.delete(visit.id);
    this._visitSeeds.set(visit.id, visit);
    while (this._visitSeeds.size > 24) this._visitSeeds.delete(this._visitSeeds.keys().next().value as string);
  }

  /** Starts fetching a visit the moment it's pressed, so it opens already filled in. */
  private _warmVisit(id: string): void {
    const hass = this._hass;
    if (!hass || !id || this._visitSeeds.has(id)) return;
    void api.visit(hass, id).then((response) => {
      const visit = asVisit(response);
      if (visit && !this._visitSeeds.has(id)) this._seedVisit(visit);
    }).catch(() => undefined);
  }

  private _showAllSpecies(): void {
    this._speciesFilter = "all";
    rememberFilter("all");
  }

  private _onFilter(event: CustomEvent<{ value: string }>): void {
    const value = event.detail.value;
    const filter: SpeciesFilter = value === "seen" || value === "heard" ? value : "all";
    this._speciesFilter = filter;
    this._speciesVisible = 24;
    rememberFilter(filter);
  }

  private _openWrongPicker(): void {
    this._pickerMounted = true;
    this._pickerOpen = true;
    this._search = "";
    void this._loadLabels();
    if (!this._species.length) void this._loadSpecies();
  }

  private _onPickerClose = (): void => { this._pickerOpen = false; this._search = ""; };

  private _openHelp(): void { this._helpMounted = true; this._helpOpen = true; }
  private _onHelpClose = (): void => { this._helpOpen = false; };

  private async _correctVisit(species: string): Promise<void> {
    const current = this._visit;
    if (!this._hass || !current || this._saving) return;
    const before = { ...current, clip: { ...current.clip }, camera: { ...current.camera }, suggestions: [...current.suggestions] };
    this._pendingUndo = { visitId: current.id, before };
    this._visit = { ...current, species: species === "not_animal" ? "Not an animal" : species === "unknown" ? "Unidentified animal" : species, status: species === "not_animal" ? "not_animal" : species === "unknown" ? "unknown" : "corrected" };
    this._pickerOpen = false;
    this._saving = true;
    this._say({ message: species === "not_animal" ? "Marked as not an animal" : species === "unknown" ? "Marked as unsure" : `Changed to ${species}`, kind: "success", actionLabel: "Undo", onAction: () => void this._undoAction(), durationMs: 10_000 });
    try {
      const response = await api.correct(this._hass, current.id, species);
      const updated = asVisit(response);
      if (updated && this.isConnected && this._visitId === current.id) this._visit = updated;
    } catch {
      if (this.isConnected && this._visitId === current.id) this._visit = before;
      this._pendingUndo = null;
      this._say({ message: "The correction wasn't saved. Try again.", kind: "error", durationMs: 5000 });
    } finally { this._saving = false; }
  }

  private async _confirmVisit(visitId = this._visit?.id, alsoHeard = false): Promise<void> {
    if (!this._hass || !visitId || this._saving) return;
    const current = this._visit;
    const before = current?.id === visitId ? { ...current, clip: { ...current.clip }, camera: { ...current.camera }, suggestions: [...current.suggestions] } : null;
    this._pendingUndo = { visitId, before };
    if (before) this._visit = { ...before, status: "confirmed" };
    if (alsoHeard) this._heardConfirmed = true;
    this._saving = true;
    this._say({ message: alsoHeard ? "Heard visit confirmed" : "Visit confirmed", kind: "success", actionLabel: "Undo", onAction: () => void this._undoAction(), durationMs: 10_000 });
    try {
      const response = await api.confirm(this._hass, visitId, alsoHeard);
      const updated = asVisit(response);
      if (updated && this.isConnected && this._visitId === visitId) this._visit = updated;
    } catch {
      if (before && this.isConnected && this._visitId === visitId) this._visit = before;
      if (alsoHeard) this._heardConfirmed = false;
      this._pendingUndo = null;
      this._say({ message: "The confirmation wasn't saved. Try again.", kind: "error", durationMs: 5000 });
    } finally { this._saving = false; }
  }

  private async _undoAction(): Promise<void> {
    const pending = this._pendingUndo;
    if (!this._hass || !pending) return;
    this._saving = true;
    try {
      await api.undo(this._hass, pending.visitId);
      if (pending.before && this._visitId === pending.visitId) this._visit = pending.before;
      else if (this._visitId) {
        const refreshed = asVisit(await api.visit(this._hass, this._visitId));
        if (refreshed) this._visit = refreshed;
      }
      this._heardConfirmed = false;
      this._pendingUndo = null;
      this._say({ message: "Undone", durationMs: 3500 });
    } catch {
      this._say({ message: "Undo is no longer available. The visit may have updated.", kind: "error", durationMs: 5000 });
    } finally { this._saving = false; }
  }

  private async _toggleMute(species: Species): Promise<void> {
    if (!this._hass || !this._settings) return;
    const before = this._settings;
    const muted = before.mutedSpecies.includes(species.species);
    const next: Settings = { ...before, mutedSpecies: muted ? before.mutedSpecies.filter((name) => name !== species.species) : [...before.mutedSpecies, species.species] };
    this._settings = next;
    try {
      const response = await api.setSettings(this._hass, next);
      if (response && Array.isArray(response.mutedSpecies)) this._settings = response;
      this._say({ message: muted ? `${species.species} notifications restored` : `${species.species} notifications muted`, durationMs: 4000 });
    } catch {
      this._settings = before;
      this._say({ message: "Notification setting couldn't be saved.", kind: "error", durationMs: 5000 });
    }
  }

  private async _loadCallAudio(visitId: string): Promise<void> {
    if (!this._hass || this._audioLoading) return;
    this._audioLoading = visitId;
    try {
      const visit = asVisit(await api.visit(this._hass, visitId));
      const source = visit ? visitAudio(visit) : null;
      if (source) {
        if (this._visit?.heard?.visitId === visitId) { this._audioUrl = source; this._callVisit = visit; }
      } else this._say({ message: "No recording is available for this call.", durationMs: 4500 });
    } catch { this._say({ message: "The call recording couldn't be loaded.", kind: "error", durationMs: 4500 }); }
    finally { this._audioLoading = null; }
  }

  /** A small message at the bottom of the screen. Raised from the open sheet when there is one: everything outside a modal sheet is switched
   * off, so an Undo outside it could not be pressed. */
  private _say(toast: ToastOptions): void {
    const own = this.renderRoot?.querySelector("kestrel-lu-sheet[open]");
    const species = this.renderRoot?.querySelector("kestrel-species-sheet")?.shadowRoot?.querySelector("kestrel-lu-sheet[open]");
    showToast(own ?? species ?? this._scaffold() ?? this, toast);
  }

  private _syncClipTimer(): void {
    this._clearClipTimer();
    if (this._view !== "visit" || this._visit?.clip.state !== "pending") return;
    this._clipTimer = window.setInterval(() => { this._progress = this._clipProgress(); }, 1000);
    this._progress = this._clipProgress();
  }

  private _clearClipTimer(): void {
    if (this._clipTimer !== undefined) window.clearInterval(this._clipTimer);
    this._clipTimer = undefined;
  }

  private _clipProgress(): number {
    const visit = this._visit;
    if (!visit) return 0;
    const start = timestamp(visit.startedAt) ?? Date.now() - 45_000;
    const readyAt = timestamp(visit.clip.expectedReadyAt) ?? start + 45_000;
    const span = Math.max(1, readyAt - start);
    return clamp(((Date.now() - start) / span) * 95, 0, 95);
  }

  /** How wide the panel is, 0 before it has been measured. */
  private _panelWidth(): number { return this._scaffold()?.panelWidth ?? 0; }

  private _maxLive(): number { const width = this._panelWidth(); return width === 0 || width <= 680 ? 4 : 9; }

  /** Copy the tile's picture as the press starts, so the focused view can open on it instantly. The copy waits
   * for the pressed state to be painted first: feedback must never queue behind it. */
  private _prewarmTile = (event: Event): void => {
    if (event instanceof KeyboardEvent && event.key !== "Enter" && event.key !== " ") return;
    const player = (event.currentTarget as HTMLElement).querySelector<KestrelLivePlayer>("kestrel-live-player");
    if (player) this._afterPaint(() => player.capture());
  };

  /** Same for the way back: the focused picture becomes the tile's picture. */
  private _prewarmFocus = (event: Event): void => {
    if (event instanceof KeyboardEvent && event.key !== "Enter" && event.key !== " ") return;
    const player = this.renderRoot.querySelector<KestrelLivePlayer>("kestrel-live-player");
    if (player) this._afterPaint(() => player.capture());
  };

  private _afterPaint(task: () => void): void {
    window.requestAnimationFrame(() => { window.setTimeout(task, 0); });
  }

  /** A tab was chosen (tap, key or link): the page changes in this frame, the address follows. Tab changes replace the history entry. */
  private _goTab(id: CachedView): void {
    const path = this._path(id);
    const fromVisit = this._view === "visit";
    const tabs = this._tabs;
    this._applyRoute({ view: id, visitId: null, species: null });
    if (!tabs) navigate(this, path);
    // Tab history does not know about detail pages: choosing the tab a visit was opened from has to go back instead.
    else if (fromVisit && tabs.current === id) goBack(this, path);
    else tabs.select(id, path, this);
  }

  private _onNavigate = (event: CustomEvent<LuNavigateDetail>): void => {
    const id = event.detail.id;
    if (id === "live" || id === "wildlife" || id === "insights") this._goTab(id);
  };

  private _openCamera(id: string): void { this._selectedCamera = id; this._goTab("live"); }

  private _openVisit(id: string): void {
    this._applyRoute({ view: "visit", visitId: id, species: null });
    navigate(this, this._path("visit", `?v=${encodeURIComponent(id)}`));
  }

  /** Back from a visit returns to wherever it was opened from, with that page where it was left. */
  private _onBack = (): void => { goBack(this, this._path("live")); };

  private _statusKind(camera: Camera): "positive" | "warning" | "danger" {
    if (!camera.online) return "danger";
    return camera.health === "ok" ? "positive" : camera.health === "unstable" ? "warning" : "danger";
  }

  private _healthLabel(camera: Camera): string {
    if (!camera.online) return "Offline";
    const labels: Record<Camera["health"], string> = { ok: "Online", unstable: "Unstable", offline: "Offline" };
    return labels[camera.health] ?? "Offline";
  }

  private _healthChip(camera: Camera, className = "") {
    return html`<kestrel-lu-chip class=${className} overlay kind=${this._statusKind(camera)} label=${this._healthLabel(camera)}></kestrel-lu-chip>`;
  }

  private _cameraName(id: string | number): string {
    return this._cameras.find((camera) => String(camera.id) === String(id))?.name ?? `Camera ${id}`;
  }

  // ---- drawing: pieces ---------------------------------------------------------------------------------------------------------

  /** The camera's latest animal as a button: kind icon, species and when, opening that visit. */
  private _renderSighting(detection: CameraDetection) {
    const kind = asKind(detection.kind);
    const phrase = `${kind ? `${KIND[kind].verb} ` : ""}${when(detection.at)}`;
    return html`<kestrel-lu-chip interactive icon=${kind ? KIND[kind].icon : "mdi:paw"} @pointerdown=${() => this._warmVisit(detection.visitId)} @click=${() => this._openVisit(detection.visitId)}>${detection.species}<span slot="detail">${phrase}</span></kestrel-lu-chip>`;
  }

  private _renderCameraTile(camera: Camera, liveIds: Set<string>) {
    const sighting = recentSighting(camera);
    return html`<article class="camera-tile">
      <button class="camera-focus" type="button" aria-label=${`Focus ${camera.name}`} @pointerdown=${this._prewarmTile} @keydown=${this._prewarmTile} @click=${() => { this._selectedCamera = String(camera.id); }}>
        <div class="camera-picture">
          ${camera.nvrCardId === null
            ? html`<kestrel-live-picture class="camera-snapshot" .src=${cameraPicture(camera) ?? ""} .paused=${this._liveIsPaused()} alt=${`${camera.name} latest picture`} @kestrel-picture-expired=${this._onPictureExpired}></kestrel-live-picture><kestrel-lu-chip class="snapshot-chip" overlay label="Snapshot only"></kestrel-lu-chip>`
            : camera.online
              ? html`<kestrel-live-player .cameraId=${String(camera.id)} .nvrCardId=${camera.nvrCardId} .label=${camera.name} .live=${liveIds.has(String(camera.id))} .paused=${this._liveIsPaused()} .hass=${this._hass}></kestrel-live-player>`
              : html`<div class="stream-placeholder static"><ha-icon .icon=${"mdi:cctv-off"}></ha-icon><span>Camera offline</span></div>`}
          ${this._healthChip(camera, "camera-health")}
        </div>
        <strong class="camera-name">${camera.name}</strong>
      </button>
      <div class="camera-sighting">${sighting ? this._renderSighting(sighting) : html`<span class="muted">${camera.wildlife ? "Wildlife enabled" : "Camera"}</span>`}</div>
    </article>`;
  }

  private _renderFocused(selected: Camera) {
    const sighting = recentSighting(selected);
    const wide = this._panelWidth() > 680;
    return html`<section class="focused-camera">
      <div class="focused-heading">
        <kestrel-lu-button kind="quiet" icon="mdi:arrow-left" label="All cameras" @pointerdown=${this._prewarmFocus} @keydown=${this._prewarmFocus} @click=${() => { this._selectedCamera = null; }}></kestrel-lu-button>
        <h2>${selected.name}</h2>
        ${this._healthChip(selected)}
      </div>
      ${selected.nvrCardId === null
        ? html`<div class="focused-snapshot"><kestrel-live-picture class="snapshot-image" .src=${cameraPicture(selected) ?? ""} .paused=${this._liveIsPaused()} alt=${`${selected.name} latest picture`} wide @kestrel-picture-expired=${this._onPictureExpired}></kestrel-live-picture><kestrel-lu-chip class="snapshot-chip" overlay label="Snapshot only"></kestrel-lu-chip></div>`
        : selected.online
          ? html`<kestrel-live-player mode="focus" .cameraId=${String(selected.id)} .nvrCardId=${selected.nvrCardId} .label=${selected.name} .live=${true} .paused=${this._liveIsPaused()} .wide=${wide} .scryptedUrl=${SCRYPTED_URL} .hass=${this._hass}></kestrel-live-player>`
          : html`<kestrel-lu-state class="unsupported-stream" kind="empty" icon="mdi:cctv-off" heading="Camera is offline" message="The last camera health state is offline."><kestrel-lu-button slot="action" kind="secondary" label="Open in Scrypted" href=${SCRYPTED_URL} target="_blank"></kestrel-lu-button></kestrel-lu-state>`}
      <div class="camera-meta"><span>${selected.drops1h ?? 0} stream drops in the last hour</span>${sighting ? this._renderSighting(sighting) : html`<span class="muted">No sightings in the last 24 hours</span>`}</div>
    </section>`;
  }

  // ---- drawing: the views --------------------------------------------------------------------------------------------------------

  private _renderLive() {
    if (this._loading && !this._cameras.length) {
      return html`<div class="page"><h2 class="sr-only">Live cameras</h2><kestrel-lu-state kind="loading" variant="tiles" tile="camera" ratio="16/9" count="6" heading="Loading your cameras"></kestrel-lu-state></div>`;
    }
    if (!this._cameras.length) {
      return html`<div class="page"><h2 class="sr-only">Live cameras</h2><kestrel-lu-state kind="empty" icon="mdi:cctv-off" heading="No cameras are available" message="Kestrel hasn't received a camera list yet.">
        <kestrel-lu-button slot="action" kind="secondary" label="Refresh" @click=${() => this._loadForView()}></kestrel-lu-button>
      </kestrel-lu-state></div>`;
    }
    const selected = this._selectedCamera ? this._cameras.find((camera) => String(camera.id) === this._selectedCamera) : null;
    if (selected) return this._renderFocused(selected);
    const cameras = this._cameras.slice(0, 32);
    const liveIds = new Set(cameras.filter((camera) => camera.nvrCardId !== null && camera.online).map((camera) => String(camera.id)).slice(0, this._maxLive()));
    return html`<div class="page">
      <h2 class="sr-only">Live cameras</h2>
      <kestrel-lu-grid kind="camera">${repeat(cameras, (camera) => String(camera.id), (camera) => this._renderCameraTile(camera, liveIds))}</kestrel-lu-grid>
      ${cameras.every((camera) => camera.nvrCardId === null) ? html`<p class="muted all-unsupported">Live streams aren't enabled for these cameras. Open Scrypted to view them.</p>` : nothing}
    </div>`;
  }

  private _renderWildlife() {
    if (this._loading && !this._species.length) {
      return html`<div class="page"><h2 class="sr-only">Wildlife</h2><kestrel-lu-state kind="loading" variant="tiles" tile="species" count="12" heading="Loading your wildlife list"></kestrel-lu-state></div>`;
    }
    if (!this._species.length) {
      return html`<div class="page"><h2 class="sr-only">Wildlife</h2><kestrel-lu-state kind="empty" icon="mdi:paw-outline" heading="No wildlife visits yet" message="Identified birds and animals will appear here with their videos and recordings."></kestrel-lu-state></div>`;
    }
    const counts = filterCounts(this._species);
    const shown = this._species.filter((species) => matchesFilter(species, this._speciesFilter));
    const visible = shown.slice(0, this._speciesVisible);
    const options = [
      { value: "all", label: "All", icon: "mdi:paw", count: counts.all },
      { value: "seen", label: "On camera", icon: KIND.seen.icon, count: counts.seen },
      { value: "heard", label: KIND.heard.word, icon: KIND.heard.icon, count: counts.heard },
    ];
    const empty = this._speciesFilter === "seen";
    return html`<div class="page">
      <h2 class="sr-only">Wildlife</h2>
      <div class="toolbar"><kestrel-lu-segmented label="Show species" .value=${this._speciesFilter} .options=${options} @lu-change=${this._onFilter}></kestrel-lu-segmented></div>
      ${visible.length
        ? html`<kestrel-lu-grid kind="species" lazy>${repeat(visible, (species) => species.species, (species, index) => this._renderSpeciesTile(species, index))}</kestrel-lu-grid>
          ${this._speciesVisible < shown.length ? html`<div class="show-more"><kestrel-lu-button kind="secondary" label="Show more species" @click=${() => { this._speciesVisible = Math.min(this._speciesVisible + 24, shown.length); }}></kestrel-lu-button></div>` : nothing}`
        : html`<kestrel-lu-state kind="empty" icon=${empty ? KIND.seen.icon : KIND.heard.icon} heading=${empty ? "Nothing on camera yet" : "Nothing heard yet"} message=${empty ? "When a camera catches an animal, it shows up here with its video." : "Sounds picked up by BirdNET-Go show up here with their recordings."}>
            <kestrel-lu-button slot="action" kind="secondary" label="Show all species" @click=${this._showAllSpecies}></kestrel-lu-button>
          </kestrel-lu-state>`}
    </div>`;
  }

  private _renderSpeciesTile(species: Species, index: number) {
    const picture = speciesPicture(species);
    const activity = lastActivity(species);
    const camera = activity?.camera ? this._cameraName(activity.camera) : null;
    const when1 = activity ? (activity.kind ? `${KIND[activity.kind].verb} ${when(activity.at)}` : sentence(when(activity.at))) : null;
    const line = when1 ? `${when1}${camera ? ` · ${camera}` : ""}` : null;
    const evidence = (["seen", "heard"] as const).filter((kind) => species[kind]).map((kind) => ({ kind, count: kind === "seen" ? species.seenCount30d : species.heardCount30d }));
    const summary = evidence.map(({ kind, count }) => count ? evidenceCount(kind, count) : KIND[kind].verb).join(", ");
    return html`<button class="species-tile" type="button" aria-label=${`${species.species}. ${summary}${line ? `. ${line}` : ""}`} @click=${() => this._openSpecies(species.species)}>
      <div class="species-photo">
        <kestrel-lu-image .src=${picture.url ?? ""} ratio="1" priority=${index < 8 ? "high" : "auto"} alt=${species.species} @lu-image-error=${() => this._onReferenceImageError(species.species)}>${species.heard ? heardHero(KIND.heard.icon, "fallback") : nothing}</kestrel-lu-image>
        ${species.heard && !picture.url ? heardHero(KIND.heard.icon) : nothing}
        ${picture.isReference && !this._failedReferenceImages.has(species.species) ? html`<kestrel-lu-chip class="snapshot-chip" overlay label="Reference photo"></kestrel-lu-chip>` : nothing}
        <span class="badge-row" aria-hidden="true">${evidence.map(({ kind, count }) => html`<kestrel-lu-chip kind="evidence" overlay icon=${KIND[kind].icon} label=${KIND[kind].word} .count=${count ? Math.min(count, 999) : undefined}></kestrel-lu-chip>`)}</span>
      </div>
      <span class="species-name">${species.species}</span>
      ${line ? html`<span class="species-last">${activity?.kind ? html`<ha-icon .icon=${KIND[activity.kind].icon} aria-hidden="true"></ha-icon>` : nothing}<span>${line}</span></span>` : nothing}
      ${species.newThisYear ? html`<span class="species-new"><kestrel-lu-chip kind="info" icon="mdi:star-outline" label="New this year"></kestrel-lu-chip></span>` : nothing}
    </button>`;
  }

  private _onReferenceImageError(name: string): void {
    if (this._failedReferenceImages.has(name)) return;
    this._failedReferenceImages.add(name);
    this.requestUpdate("_failedReferenceImages", undefined);
  }

  private _onVisitReferenceImageError(): void { this._visitReferencePhotoFailed = true; }

  private _renderInsights() {
    if (this._loading && !this._health && !this._review.length) {
      return html`<div class="page"><h2 class="sr-only">AI check-up</h2><kestrel-lu-state kind="loading" variant="tiles" tile="custom" count="4" ratio="3/1" heading="Checking the wildlife system"></kestrel-lu-state></div>`;
    }
    const health = this._health;
    const noisy = (health?.cameras ?? []).filter((camera) => camera.emptyChecksToday > 0).sort((a, b) => (b.emptyChecksToday / Math.max(1, b.checksToday)) - (a.emptyChecksToday / Math.max(1, a.checksToday))).slice(0, 5);
    const storage = health ? health.storage.dbMB + health.storage.mediaMB : 0;
    const storagePercent = health?.storage.budgetMB ? clamp((storage / health.storage.budgetMB) * 100, 0, 100) : 0;
    const gpuPercent = health?.gpu.totalMiB ? clamp((health.gpu.usedMiB / health.gpu.totalMiB) * 100, 0, 100) : 0;
    return html`<section class="insights-view">
      <h2 class="sr-only">AI check-up</h2>
      <div class="toolbar"><p class="muted">A quick look at the wildlife system's health.</p><kestrel-lu-button kind="quiet" icon-only icon="mdi:refresh" label="Refresh check-up" @click=${() => this._loadForView()}></kestrel-lu-button></div>
      <section class="review-section sheet">
        <div class="card-head"><div><h3>Needs a look</h3><p class="muted">Visits that may need a correction.</p></div><kestrel-lu-chip kind=${this._review.length ? "info" : "neutral"} label=${`${this._review.length} to review`}></kestrel-lu-chip></div>
        ${this._review.length
          ? this._review.slice(0, 12).map((visit) => html`<kestrel-lu-row interactive chevron .heading=${visit.species || "Unidentified animal"} .detail=${`${visit.camera.name} · ${ago(visit.startedAt)}`} @pointerdown=${() => this._warmVisit(visit.id)} @click=${() => this._openVisit(visit.id)}>
              <kestrel-lu-image slot="leading" class="review-thumb" ratio="1" .src=${visitSnapshot(visit) ?? ""} alt=""></kestrel-lu-image>
            </kestrel-lu-row>`)
          : html`<p class="empty-inline">Nothing needs a review right now.</p>`}
      </section>
      <kestrel-lu-grid kind="custom" .min=${240}>
        <article class="health-tile tile"><div class="health-title"><ha-icon .icon=${"mdi:brain"}></ha-icon><span>Wildlife detector</span></div><strong>${health?.detector.name ?? "Not available"}</strong><p>${health ? (health.detector.avgMs === null ? health.detector.provider : `${health.detector.provider} · ${health.detector.avgMs} ms average`) : "Waiting for health data"}</p><small>${health?.detector.checksToday ?? 0} checks today</small></article>
        <article class="health-tile tile"><div class="health-title"><ha-icon .icon=${"mdi:expansion-card"}></ha-icon><span>GPU memory</span></div><strong>${health ? `${formatMiB(health.gpu.usedMiB)} / ${formatMiB(health.gpu.totalMiB)}` : "Not available"}</strong><div class="meter"><span style=${`width:${gpuPercent}%`}></span></div><small>${health?.gpu.util ?? 0}% GPU use</small></article>
        <article class="health-tile tile"><div class="health-title"><ha-icon .icon=${"mdi:database"}></ha-icon><span>Wildlife storage</span></div><strong>${health ? `${storage.toFixed(1)} / ${health.storage.budgetMB} MB` : "Not available"}</strong><div class="meter"><span style=${`width:${storagePercent}%`}></span></div><small>${health ? `${health.storage.dbMB.toFixed(1)} MB database · ${health.storage.mediaMB.toFixed(1)} MB photos and clips` : "Waiting for health data"}</small></article>
        <article class="health-tile tile"><div class="health-title"><ha-icon .icon=${"mdi:check-decagram"}></ha-icon><span>Corrections</span></div><strong>${health?.corrections.sinceRetrain ?? 0}</strong><p>since the last model retrain</p><small>${health?.corrections.total ?? 0} all-time corrections</small></article>
        <article class="health-tile tile"><div class="health-title"><ha-icon .icon=${"mdi:microphone"}></ha-icon><span>BirdNET sound detector</span></div><strong class=${health?.birdnet ? (health.birdnet.online ? "healthy" : "unhealthy") : ""}>${health?.birdnet ? (health.birdnet.online ? "Online" : "Offline") : "Not set up yet"}</strong><p>${health?.birdnet?.lastHeardAt ? `Last heard ${ago(health.birdnet.lastHeardAt)}` : "No recent sound detections"}</p>${health?.birdnetLink ? html`<kestrel-lu-button kind="quiet" label="Open in BirdNET-Go" href=${health.birdnetLink} target="_blank"></kestrel-lu-button>` : nothing}</article>
      </kestrel-lu-grid>
      <section class="noisy-section sheet"><div class="card-head"><div><h3>Quiet camera checks</h3><p class="muted">Checks with no animal detection today.</p></div></div>${noisy.length ? html`<ul class="simple-list">${noisy.map((camera) => html`<li><span>${this._cameraName(camera.id)}</span><strong>${camera.emptyChecksToday} of ${camera.checksToday} checks</strong></li>`)}</ul>` : html`<p class="empty-inline">No empty checks reported today.</p>`}</section>
    </section>`;
  }

  private _renderVisit() {
    const visit = this._visit;
    if (!this._visitId) {
      return html`<div class="page"><kestrel-lu-state kind="empty" icon="mdi:timeline-clock-outline" heading="No visit selected" message="Open a visit from a camera card or from the wildlife list to see its picture and clip.">
        <div class="action-row" slot="action"><kestrel-lu-button kind="primary" label="See wildlife" @click=${() => this._goTab("wildlife")}></kestrel-lu-button><kestrel-lu-button kind="secondary" label="Cameras" @click=${() => this._goTab("live")}></kestrel-lu-button></div>
      </kestrel-lu-state></div>`;
    }
    if (!visit && this._visitGone?.id === this._visitId) return this._renderVisitGone(this._visitGone.camera);
    if (!visit && this._loading) {
      return html`<article class="visit-view"><section class="visit-hero sheet"><kestrel-lu-image ratio="16/10" alt=""></kestrel-lu-image></section><div class="visit-summary"><kestrel-lu-state kind="loading" variant="text" count="4" heading="Loading this visit"></kestrel-lu-state></div></article>`;
    }
    if (!visit) {
      return html`<div class="page"><kestrel-lu-state kind="empty" icon="mdi:cloud-alert" heading="This visit didn't load" message="Kestrel couldn't reach the server. Check the connection and try again.">
        <kestrel-lu-button slot="action" kind="secondary" label="Try again" @click=${() => this._loadForView()}></kestrel-lu-button>
      </kestrel-lu-state></div>`;
    }
    const photo = visitSnapshot(visit);
    const clip = visitClip(visit);
    const pending = visit.clip?.state === "pending";
    const confirmed = visit.status === "confirmed";
    const heard = visit.heard ?? null;
    const progress = pending ? this._progress : 0;
    const kind = asKind(visit.kind) ?? "seen";
    return html`<article class="visit-view">
      <section class="visit-hero sheet">
        <div class="hero-media">
          ${visit.clip?.state === "ready" && clip
            ? html`<video class="visit-video" src=${clip} poster=${photo ?? nothing} controls autoplay muted playsinline preload="auto" aria-label=${`${visit.species} visit clip`}></video>`
            : photo
              ? html`<kestrel-lu-image priority="high" ratio="16/10" .src=${photo} alt=${`${visit.species} at ${visit.camera.name}`}></kestrel-lu-image>`
              : visit.kind === "heard"
                ? html`<kestrel-lu-image ratio="16/10" .src=${this._visitReferencePhoto ?? ""} alt=${`${visit.species} reference photo`} @lu-image-error=${() => this._onVisitReferenceImageError()}>${heardHero(KIND.heard.icon, "fallback")}</kestrel-lu-image>${this._visitReferencePhoto ? nothing : heardHero(KIND.heard.icon)}`
                : html`<kestrel-lu-image ratio="16/10" .src=${""} alt=${visit.species || "Unidentified animal"}></kestrel-lu-image>`}
          ${visit.kind === "heard" && !photo && this._visitReferencePhoto && !this._visitReferencePhotoFailed ? html`<kestrel-lu-chip class="snapshot-chip" overlay label="Reference photo"></kestrel-lu-chip>` : nothing}
        </div>
        ${pending ? html`<div class="clip-progress"><div class="progress-label"><span>Saving clip…</span><span>${Math.round(progress)}%</span></div><div class="progress-track" role="progressbar" aria-label="Clip processing" aria-valuemin="0" aria-valuemax="100" aria-valuenow=${Math.round(progress)}><span style=${`width:${progress}%`}></span></div><p class="caption">The recording is still being finalized. This view updates when it's ready.</p></div>` : nothing}
        ${visit.clip?.state === "none" && visit.kind !== "heard" ? html`<p class="media-note">No clip was saved for this visit.</p>` : nothing}
        ${visit.clip?.state === "deleted" ? html`<p class="media-note">This clip is no longer available.</p>` : nothing}
        ${visit.clip?.state === "ready" && !clip ? html`<p class="media-note">The clip is ready, but its signed link isn't available yet.</p>` : nothing}
      </section>
      <div class="visit-summary">
        <div class="visit-title-row"><div><h2>${visit.species || "Unidentified animal"}</h2><p class="muted">${visit.camera.name} · ${dateTime(visit.startedAt)}</p></div><span class="score" role="img" aria-label=${`${Math.round((visit.score ?? 0) * 100)} percent sure`}>${Math.round((visit.score ?? 0) * 100)}<small>%</small></span></div>
        <div class="visit-tags">
          <kestrel-lu-chip icon=${KIND[kind].icon} label=${evidenceWord(visit)}></kestrel-lu-chip>
          <kestrel-lu-chip label=${GROUP_LABEL[visit.grp] ?? GROUP_LABEL.unknown}></kestrel-lu-chip>
          <kestrel-lu-chip kind=${confirmed ? "positive" : "neutral"} label=${this._statusLabel(visit.status)}></kestrel-lu-chip>
          ${visit.firstEver ? html`<kestrel-lu-chip kind="info" icon="mdi:star-outline" label="First visit"></kestrel-lu-chip>` : nothing}
        </div>
        <div class="visit-actions">
          <kestrel-lu-button kind="primary" icon="mdi:check" label=${confirmed ? "Confirmed" : "That's right"} ?disabled=${confirmed || this._saving} @click=${() => this._confirmVisit()}></kestrel-lu-button>
          <kestrel-lu-button kind="secondary" label="Wrong?" ?disabled=${this._saving} @click=${this._openWrongPicker}></kestrel-lu-button>
        </div>
        ${visit.kind === "heard" ? html`<section class="heard-panel tile"><div class="heard-copy"><strong>Call recording</strong><span class="muted">${visit.species || "Unidentified sound"} detected here</span></div>${this._audioUrl ? this._renderRecording(this._audioUrl, visit, `Call recording of ${visit.species}`) : html`<span class="muted">No recording is available for this visit.</span>`}</section>` : nothing}
        ${heard ? html`<section class="heard-panel tile"><div class="heard-copy"><strong>Also heard: ${heard.species}</strong><span class="muted">Sound recorded near this visit</span></div><kestrel-lu-button kind="secondary" icon="mdi:check" label="Also heard" ?disabled=${this._saving || this._heardConfirmed} @click=${() => this._confirmVisit(visit.id, true)}></kestrel-lu-button>
          ${this._audioUrl ? this._renderRecording(this._audioUrl, this._callVisit ?? heard, `Call recording of ${heard.species}`) : html`<kestrel-lu-button kind="quiet" ?disabled=${!heard.hasAudio || this._audioLoading === heard.visitId} label=${this._audioLoading === heard.visitId ? "Loading recording…" : heard.hasAudio ? "Play call" : "No call recording"} @click=${() => this._loadCallAudio(heard.visitId)}></kestrel-lu-button>`}
        </section>` : nothing}
      </div>
    </article>`;
  }

  /** A calm explanation, not an error: merged and removed visits are normal, and old notifications still point at them. */
  private _renderVisitGone(camera: { id: string; name: string } | null) {
    return html`<div class="page"><kestrel-lu-state kind="empty" icon="mdi:call-merge" heading="This visit was merged or removed" message="Kestrel combines repeat sightings of the same animal and clears false alarms, so an older notification can point at one that is gone.">
      <div class="action-row" slot="action"><kestrel-lu-button kind="primary" label="See wildlife" @click=${() => this._goTab("wildlife")}></kestrel-lu-button>${camera ? html`<kestrel-lu-button kind="secondary" label=${camera.name} @click=${() => this._openCamera(camera.id)}></kestrel-lu-button>` : html`<kestrel-lu-button kind="secondary" label="Cameras" @click=${() => this._goTab("live")}></kestrel-lu-button>`}</div>
    </kestrel-lu-state></div>`;
  }

  /** A recording player with what the preview service says about it: whether it was cleaned, the moment that
   * was matched, and the untouched original (only when it really is a different file). A fresh player after every
   * restart of Home Assistant, so a player that gave up on dead links does not stay on the fallback. */
  private _renderRecording(src: string, source: { audioOriginal?: string | null; audioInfo?: AudioInfo | null } | null, label: string) {
    const original = source ? visitAudioOriginal(source) : null;
    const notes = recordingNotes(source?.audioInfo);
    return keyed(this._epoch, html`<kestrel-lu-audio-player .src=${src} .original=${original && !sameMedia(original, src) ? original : ""} .mark=${notes.mark} .caption=${notes.caption} label=${label} preload="metadata"></kestrel-lu-audio-player>`);
  }

  private _statusLabel(status: Visit["status"]): string {
    const labels: Record<Visit["status"], string> = { auto: "Model guess", learned: "Learned", corrected: "Corrected", confirmed: "Confirmed", not_animal: "Not an animal", unknown: "Not sure" };
    return labels[status] ?? "Visit";
  }

  // ---- drawing: sheets -----------------------------------------------------------------------------------------------------------

  /** Over the page, outside the views: a modal inside a hidden view would still block the document. */
  private _renderSpeciesSheet() {
    const name = this._sheetSpecies;
    const species = name ? this._species.find((item) => item.species === name) : undefined;
    if (!species) return nothing;
    const open = this._view === "wildlife" && this._selectedSpecies === name;
    return html`<kestrel-species-sheet .hass=${this._hass} .species=${species} .cameras=${this._cameras} .open=${open} .muted=${this._settings?.mutedSpecies.includes(species.species) ?? false} .canMute=${this._settings !== null} @close=${this._onSpeciesClose} @open-visit=${this._onOpenVisit} @warm-visit=${this._onWarmVisit} @toggle-mute=${() => this._toggleMute(species)}></kestrel-species-sheet>`;
  }

  private _renderPickerSheet() {
    if (!this._pickerMounted) return nothing;
    return html`<kestrel-lu-sheet .open=${this._pickerOpen} .history=${this._isPanel} engine="native" layer="wrong-picker" heading="What was it?" subheading="Choose a better match or search the species list." @lu-close=${this._onPickerClose}>
      ${this._visit ? this._renderPickerBody(this._visit) : nothing}
      <div slot="footer" class="special-choices"><kestrel-lu-button kind="secondary" label="Not an animal" @click=${() => this._correctVisit("not_animal")}></kestrel-lu-button><kestrel-lu-button kind="secondary" label="Can't tell" @click=${() => this._correctVisit("unknown")}></kestrel-lu-button></div>
    </kestrel-lu-sheet>`;
  }

  private _renderPickerBody(visit: Visit) {
    const reasonLabels: Record<VisitSuggestion["why"], string> = { usual: "Common here", model: "Model's 2nd guess", heard: "Heard here" };
    const seen = new Set<string>(visit.species ? [visit.species] : []);
    const rows: { name: string; reason?: string }[] = [];
    for (const suggestion of Array.isArray(visit.suggestions) ? visit.suggestions : []) {
      if (!suggestion.species || seen.has(suggestion.species)) continue;
      seen.add(suggestion.species);
      rows.push({ name: suggestion.species, reason: reasonLabels[suggestion.why] });
    }
    for (const species of [...this._species].sort((a, b) => b.count30d - a.count30d)) {
      if (!species.species || seen.has(species.species)) continue;
      seen.add(species.species);
      rows.push({ name: species.species });
    }
    for (const name of [...this._labels].sort((a, b) => a.localeCompare(b))) {
      if (!name || seen.has(name)) continue;
      seen.add(name);
      rows.push({ name });
    }
    const query = this._search.trim().toLowerCase();
    const candidates = (query ? rows.filter((row) => row.name.toLowerCase().includes(query)) : rows).slice(0, 16);
    return html`<input class="species-search" type="search" autofocus placeholder="Search species" aria-label="Search species" .value=${this._search} @input=${(event: Event) => { this._search = (event.currentTarget as HTMLInputElement).value; }}>
      ${candidates.map((row) => html`<kestrel-lu-row interactive chevron .heading=${row.name} .detail=${row.reason ?? ""} @click=${() => this._correctVisit(row.name)}></kestrel-lu-row>`)}
      ${candidates.length === 0 ? html`<kestrel-lu-state kind="empty" compact message="No matching species."></kestrel-lu-state>` : nothing}`;
  }

  private _renderHelpSheet() {
    if (!this._helpMounted) return nothing;
    const rows = [...TABS.map((tab, index) => [String(index + 1), tab.label] as const), ["Esc", "Close a sheet, or go back"]];
    return html`<kestrel-lu-sheet .open=${this._helpOpen} .history=${this._isPanel} engine="native" layer="help" heading="Keyboard shortcuts" subheading="Single keys work anywhere in Kestrel." @lu-close=${this._onHelpClose}>
      ${rows.map(([key, label]) => html`<kestrel-lu-row .heading=${label}><kbd slot="trailing">${key}</kbd></kestrel-lu-row>`)}
    </kestrel-lu-sheet>`;
  }

  // ---- drawing: the frame --------------------------------------------------------------------------------------------------------

  /** Shown views are rendered; the others keep what they last showed. Live is rendered once more when its
   * streams are paused or resumed. The visit page is drawn only while it is showing: a video must not play in a hidden view. */
  private _viewContent(view: View): unknown {
    if (view === "visit") return this._view === "visit" ? this._renderVisit() : nothing;
    let content: TemplateResult | undefined;
    if (this._view === view || (view === "live" && this._liveIsPaused() !== this._frozenLivePaused)) {
      content = view === "live" ? this._renderLive() : view === "wildlife" ? this._renderWildlife() : this._renderInsights();
      if (view === "live") this._frozenLivePaused = this._liveIsPaused();
      this._frozen.set(view, content);
    } else content = this._frozen.get(view);
    return content;
  }

  private _renderViews() {
    return html`<kestrel-lu-view-stack .current=${this._view} max="4" memory-key="kestrel" @lu-view-shown=${this._onViewShown} @lu-view-hidden=${this._onViewHidden} @lu-view-evict=${this._onViewEvict}>
      ${repeat(this._mounted, (view) => view, (view) => html`<div data-view=${view}>${this._viewContent(view)}</div>`)}
    </kestrel-lu-view-stack>`;
  }

  private _renderBody() {
    return html`${this._error ? html`<kestrel-lu-state class="error-banner" kind="error" compact heading="Couldn't load this view" .message=${this._error} @lu-retry=${() => this._loadForView()}></kestrel-lu-state>` : nothing}
      ${this._renderViews()}${this._renderSpeciesSheet()}${this._renderPickerSheet()}${this._renderHelpSheet()}`;
  }

  private _renderConnection() {
    const state = this._link.state;
    if (state === "connected") return nothing;
    // The last data stays. The strip sits in the shell's bottom slot, so appearing and going away moves nothing on the page.
    return html`<kestrel-lu-state slot="bottom" kind="stale" .since=${this._link.lastConnectedAt} message=${state === "grace" ? "Reconnecting…" : "Offline"}></kestrel-lu-state>`;
  }

  private _renderActions() {
    const shell = this._shell();
    const compact = shell ? shell.panelWidth < 680 : false;
    // A visit page has the back arrow where the menu button would be (as Home Assistant's own sub-pages do); the menu stays one tap away at the other end.
    const menu = this._view === "visit" && showMenuButton(this._hass, this.narrow);
    return html`
      ${this._view === "live" ? html`<kestrel-lu-button slot="actions" kind="quiet" icon="mdi:open-in-new" ?icon-only=${compact} label="Open in Scrypted" href=${SCRYPTED_URL} target="_blank"></kestrel-lu-button>` : nothing}
      <kestrel-lu-button slot="actions" class="shortcuts" kind="quiet" icon-only icon="mdi:keyboard-outline" label="Keyboard shortcuts" title="Keyboard shortcuts" @click=${() => this._openHelp()}></kestrel-lu-button>
      ${menu ? html`<kestrel-lu-button slot="actions" kind="quiet" icon-only icon="mdi:menu" label=${this._hass?.localize?.("ui.sidebar.sidebar_toggle") || "Show sidebar"} @click=${() => toggleHaMenu(this)}></kestrel-lu-button>` : nothing}`;
  }

  private _onProfile = (): void => { this.requestUpdate(); };

  private _renderPanel() {
    const visit = this._view === "visit";
    return html`<kestrel-lu-app-shell .hass=${this._hass} ?narrow=${this.narrow} heading=${visit ? "Visit" : "Kestrel"} nav-label="Camera sections"
        leading=${visit ? "back" : "auto"} .destinations=${visit ? NO_DESTINATIONS : this._destinations} current=${visit ? "" : this._view}
        @lu-navigate=${this._onNavigate} @lu-back=${this._onBack} @lu-profile-change=${this._onProfile}>
      ${this._renderActions()}
      ${this._renderConnection()}
      ${this._renderBody()}
    </kestrel-lu-app-shell>`;
  }

  /** The Lovelace card form: no app bar, the destinations as a row of pills above the page. */
  private _renderCard() {
    const visit = this._view === "visit";
    return html`<ha-card><kestrel-lu-root mode="card" @lu-profile-change=${this._onProfile}>
      ${visit ? nothing : html`<kestrel-lu-nav mode="pills" label="Camera sections" .destinations=${this._destinations} .current=${this._view} @lu-navigate=${this._onNavigate}></kestrel-lu-nav>`}
      ${this._renderBody()}
    </kestrel-lu-root></ha-card>`;
  }

  static styles = PANEL_CSS;

  render() {
    return this._isPanel ? this._renderPanel() : this._renderCard();
  }
}

customElements.define("kestrel-cameras", KestrelCameras);

interface CustomCardsWindow extends Window { customCards?: Array<Record<string, unknown>>; }
const cardRegistry = window as CustomCardsWindow;
cardRegistry.customCards = cardRegistry.customCards ?? [];
cardRegistry.customCards.push({ type: "kestrel-cameras", name: "Kestrel Cameras", description: "Camera views and wildlife visits." });

declare global { interface HTMLElementTagNameMap { "kestrel-cameras": KestrelCameras; } }

export class KestrelPanel extends KestrelCameras {}

customElements.define("kestrel-panel", KestrelPanel);

declare global { interface HTMLElementTagNameMap { "kestrel-panel": KestrelPanel; } }
