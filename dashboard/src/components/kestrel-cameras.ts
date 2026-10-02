import { LitElement, css, html, nothing, type PropertyValues, type TemplateResult } from "lit";
import KestrelMark from "../../../assets/kestrel-mark-96.png";
import { api, asVisit, cameraArray, cameraPicture, extractLabels, goBack, isNotFound, navigate, routeView, speciesArray, speciesFromLocation, speciesPicture, speciesReferencePhoto, visitAudio, visitAudioOriginal, visitClip, visitIdFromLocation, visitPage, visitSnapshot } from "../api.ts";
import { readCached, writeCached } from "../cache.ts";
import { ago, clamp, dateTime, formatMiB, sentence, timestamp, when } from "../format.ts";
import { COMMON_CSS, TOKENS_CSS } from "../styles/tokens.ts";
import type { AudioInfo, Camera, CameraDetection, Health, HomeAssistant, KestrelCardConfig, KestrelPush, Settings, Species, Visit, VisitSuggestion } from "../types.ts";
import { GROUP_LABEL, KIND, asKind, evidenceCount, evidenceWord, recordingNotes } from "../vocab.ts";
import { sameMedia } from "../urls.ts";
import { filterCounts, lastActivity, matchesFilter, recentSighting, rememberFilter, rememberedFilter, type SpeciesFilter } from "../wildlife.ts";
import { PARTS_CSS, badge } from "../ui/parts.ts";
import { PanelProfile } from "../ui/profile.ts";
import { trackPresses } from "lucent-ha";
import "../ui/lazy-image.ts";
import "../ui/sheet.ts";
import "../ui/live-picture.ts";
import "./kestrel-live-player.ts";
import { forgetVisit } from "./kestrel-species-sheet.ts";
import type { KestrelLivePlayer } from "./kestrel-live-player.ts";
import type { KestrelSpeciesSheet } from "./kestrel-species-sheet.ts";

type ToastState = { message: string; actionLabel?: string; action?: () => void; duration?: number };
/** Views that stay in the page once shown, hidden while away, so coming back costs a repaint, not a rebuild. */
type CachedView = "live" | "wildlife" | "insights";
type PendingUndo = { visitId: string; before?: Visit | null };
const NAV = [
  { view: "live", label: "Live", icon: "mdi:cctv" },
  { view: "wildlife", label: "Wildlife", icon: "mdi:paw" },
  { view: "insights", label: "AI check-up", icon: "mdi:heart-pulse" },
] as const;
/** How long Live keeps streaming after another view is opened: long enough for the new view to paint first. */
const LIVE_GRACE_MS = 250;
const SCRYPTED_URL = "https://192.168.1.69:10443";

export class KestrelCameras extends LitElement {
  static properties = {
    hass: { attribute: false },
    narrow: { type: Boolean },
    _config: { state: true },
    _view: { state: true },
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
    _speciesFilter: { state: true },
    _labels: { state: true },
    _pickerOpen: { state: true },
    _search: { state: true },
    _saving: { state: true },
    _toast: { state: true },
    _progress: { state: true },
    _helpOpen: { state: true },
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
  };


  declare _config: KestrelCardConfig;
  declare _view: "live" | "visit" | "wildlife" | "insights";
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
  declare _selectedSpecies: string | null;
  declare _speciesFilter: SpeciesFilter;
  declare _labels: string[];
  declare _pickerOpen: boolean;
  declare _search: string;
  declare _saving: boolean;
  declare _toast: ToastState | null;
  declare _progress: number;
  declare _helpOpen: boolean;
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
  declare narrow: boolean;

  private _hass?: HomeAssistant;
  private _connection?: HomeAssistant["connection"];
  private _unsubscribe?: () => Promise<void>;
  private _subscriptionVersion = 0;
  private _generation = 0;
  private _toastTimer?: number;
  private _clipTimer?: number;
  /** Container size and input decide the Lucent profile; it also keeps data-lu-profile on this element. */
  private readonly _panel = new PanelProfile(this);
  private _visitSeeds = new Map<string, Visit>();
  private _scrolls = new Map<string, number>();
  private _pageKey = "";
  private _restoreTo: number | null = null;
  private _restoreUntil = 0;
  private _restoreFrame = 0;
  private _restoreHeight = 0;
  private _restoreStable = 0;
  private _stopPresses?: () => void;
  private _mounted = new Set<CachedView>();
  private _frozen = new Map<CachedView, TemplateResult>();
  private _frozenLivePaused = false;
  private _livePauseTimer?: number;
  private _clockTimer?: number;
  private _previousScrollRestoration: ScrollRestoration | undefined;
  private _failedReferenceImages = new Set<string>();
  private static _nvrComponentsPromise: Promise<void> | undefined;
  private _pendingUndo: PendingUndo | null = null;
  private _routeKey = "";

  constructor() {
    super();
    this._config = { type: "custom:kestrel-cameras", view: "live" };
    this._view = "live";
    this._visitId = null;
    this._cameras = readCached("cameras") ?? [];
    this._visit = null;
    this._species = readCached("species") ?? [];
    this._review = [];
    this._health = null;
    this._settings = null;
    this._error = "";
    this._loading = true;
    this._selectedCamera = null;
    this._selectedSpecies = null;
    this._speciesFilter = rememberedFilter();
    this._labels = [];
    this._pickerOpen = false;
    this._search = "";
    this._saving = false;
    this._toast = null;
    this._progress = 0;
    this._helpOpen = false;
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
    this.narrow = false;
  }

  get hass(): HomeAssistant { return this._hass as HomeAssistant; }
  set hass(value: HomeAssistant) {
    const previous = this._hass;
    this._hass = value;
    for (const child of this.renderRoot?.querySelectorAll<KestrelLivePlayer | KestrelSpeciesSheet>("kestrel-live-player, kestrel-species-sheet") ?? []) child.hass = value;
    this.requestUpdate("hass", previous);
    if (this.isConnected) this._ensureConnection();
  }

  setConfig(config: KestrelCardConfig): void {
    this._config = { ...config, view: config.view ?? "live" };
    this._view = routeView(this._config) ?? "live";
    this._visitId = visitIdFromLocation();
    this.requestUpdate();
    if (this.isConnected) void this._loadForView();
  }

  getCardSize(): number { return 8; }
  static getStubConfig(): KestrelCardConfig { return { type: "custom:kestrel-cameras", view: "live" }; }

  connectedCallback(): void {
    super.connectedCallback();
    this._generation++;
    window.addEventListener("location-changed", this._onLocationChanged);
    window.addEventListener("popstate", this._onLocationChanged);
    window.addEventListener("keydown", this._onGlobalKeydown);
    this._syncRoute(false);
    // Scroll positions are restored by the panel (see _syncRoute), not guessed by the browser.
    this._previousScrollRestoration = window.history.scrollRestoration;
    window.history.scrollRestoration = "manual";
    this._stopPresses = trackPresses(this.renderRoot);
    this._clockTimer = window.setInterval(() => { if (document.visibilityState === "visible" && this._view !== "visit") this._tick++; }, 30_000);
    this._ensureConnection();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this._generation++;
    window.removeEventListener("location-changed", this._onLocationChanged);
    window.removeEventListener("popstate", this._onLocationChanged);
    window.removeEventListener("keydown", this._onGlobalKeydown);
    this._stopPresses?.();
    this._stopPresses = undefined;
    window.clearTimeout(this._livePauseTimer);
    window.clearInterval(this._clockTimer);
    this._endRestore();
    if (this._previousScrollRestoration) window.history.scrollRestoration = this._previousScrollRestoration;
    this._clearClipTimer();
    window.clearTimeout(this._toastTimer);
    this._toastTimer = undefined;
    void this._stopSubscription();
  }

  protected shouldUpdate(changed: PropertyValues<this>): boolean {
    return [...changed.keys()].some((key) => key !== "hass");
  }

  protected updated(changed: PropertyValues<this>): void {
    if (changed.has("_view") && this._view !== "visit") this._clearClipTimer();
    if (changed.has("_view")) this._onViewChanged(changed.get("_view") as string | undefined);
    if (this._restoreTo !== null) this._applyRestore();
  }

  private _liveIsPaused(): boolean { return this._livePaused && this._view !== "live"; }

  private _lastPictureRefresh = 0;
  /** A picture link the server no longer accepts: ask for the cameras again (their links are signed afresh), at most once a minute. */
  private _onPictureExpired = (): void => {
    const now = Date.now();
    if (now - this._lastPictureRefresh < 60_000) return;
    this._lastPictureRefresh = now;
    void this._loadCameras();
  };

  private _onViewChanged(previous: string | undefined): void {
    window.clearTimeout(this._livePauseTimer);
    if (this._view === "live") this._livePaused = false;
    else if (previous === "live") this._livePauseTimer = window.setTimeout(() => { this._livePaused = true; }, LIVE_GRACE_MS);
  }

  /** Puts the page back where it was when Back returns to it. The target is held until the page has stopped
   * growing (children render a moment after their parent) so nothing lands it a few pixels off, and any
   * touch, wheel or key from the user ends it at once. */
  private _beginRestore(target: number): void {
    this._endRestore();
    this._restoreTo = target;
    this._restoreUntil = performance.now() + 1500;
    this._restoreHeight = 0;
    this._restoreStable = performance.now();
    document.documentElement.style.overflowAnchor = "none"; // the browser's own anchoring would second-guess us
    for (const name of ["wheel", "touchstart", "pointerdown", "keydown"]) window.addEventListener(name, this._abortRestore, { capture: true, passive: true });
  }

  private _abortRestore = (): void => { this._endRestore(); };

  private _endRestore(): void {
    window.cancelAnimationFrame(this._restoreFrame);
    this._restoreTo = null;
    document.documentElement.style.overflowAnchor = "";
    for (const name of ["wheel", "touchstart", "pointerdown", "keydown"]) window.removeEventListener(name, this._abortRestore, true);
  }

  private _applyRestore(): void {
    const target = this._restoreTo;
    if (target === null) return;
    window.cancelAnimationFrame(this._restoreFrame);
    const now = performance.now();
    const height = document.documentElement.scrollHeight;
    const room = height - window.innerHeight;
    if (height !== this._restoreHeight) { this._restoreHeight = height; this._restoreStable = now; }
    const reachable = target <= room + 1;
    if (reachable && Math.abs(window.scrollY - target) > 0.5) window.scrollTo(0, target);
    if ((reachable && now - this._restoreStable >= 160) || now > this._restoreUntil) {
      if (!reachable) window.scrollTo(0, Math.max(0, room));
      this._endRestore();
      return;
    }
    this._restoreFrame = window.requestAnimationFrame(() => this._applyRestore());
  }

  private _isActive(generation = this._generation): boolean {
    return this.isConnected && generation === this._generation;
  }

  private _ensureConnection(): void {
    if (!this._hass || !this.isConnected) return;
    const connection = this._hass.connection;
    if (this._connection !== connection) {
      void this._stopSubscription();
      this._connection = connection;
      const version = ++this._subscriptionVersion;
      void connection.subscribeMessage<KestrelPush>((message) => this._onPush(message), { type: "kestrel/subscribe" }).then((unsubscribe) => {
        if (!this.isConnected || version !== this._subscriptionVersion || this._connection !== connection) {
          void unsubscribe();
          return;
        }
        this._unsubscribe = unsubscribe;
      }).catch(() => {
        if (this.isConnected) this._setError("Live updates are unavailable. Try refreshing this view.");
      });
      void this._loadForView();
    }
  }

  private async _stopSubscription(): Promise<void> {
    this._subscriptionVersion++;
    const stop = this._unsubscribe;
    this._unsubscribe = undefined;
    this._connection = undefined;
    if (stop) {
      try { await stop(); } catch { /* subscription already ended */ }
    }
  }

  private _syncRoute(load = true, popped = false): void {
    const view = routeView(this._config) ?? "live";
    const visitId = visitIdFromLocation();
    const species = view === "wildlife" ? speciesFromLocation() : null;
    const key = `${view}:${visitId ?? ""}:${species ?? ""}`;
    if (key === this._routeKey) return;
    this._routeKey = key;
    const oldView = this._view;
    const oldVisitId = this._visitId;
    // The page underneath doesn't move when a sheet opens over it, so a sheet shares its page's key.
    const pageKey = `${view}:${visitId ?? ""}`;
    if (pageKey !== this._pageKey) {
      if (this._pageKey && this.isConnected) this._scrolls.set(this._pageKey, window.scrollY);
      this._pageKey = pageKey;
      const tabs = view !== "visit" && oldView !== "visit";
      this._beginRestore(popped || tabs ? this._scrolls.get(pageKey) ?? 0 : 0);
    }
    this._view = view;
    this._visitId = visitId;
    this._selectedSpecies = species;
    if (view !== oldView) {
      // Opening a visit from a focused camera and coming Back lands on that camera again; moving between tabs starts at the grid.
      if (view !== "visit" && oldView !== "visit") this._selectedCamera = null;
      this._pickerOpen = false;
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

  private _onLocationChanged = (event: Event): void => { this._syncRoute(true, event.type === "popstate"); };

  /** Single-key shortcuts for the main destinations. Ignored while typing and while a sheet is open. */
  private _onGlobalKeydown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.composedPath()[0];
    if (target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
    if (this._pickerOpen || this._selectedSpecies || this._helpOpen) return;
    const index = Number(event.key);
    if (Number.isInteger(index) && index >= 1 && index <= NAV.length && this._view !== "visit") {
      event.preventDefault();
      this._goTo(NAV[index - 1].view);
    } else if (event.key === "?") {
      event.preventDefault();
      this._helpOpen = true;
    }
  };

  private _onPush(message: KestrelPush): void {
    const event = message?.event;
    if (!event) return;
    if (event.type === "camera") {
      // The event carries the whole camera list and is only sent when something changed, so use it as is.
      const cameras = cameraArray(event.data);
      if (cameras.length && typeof cameras[0]?.name === "string") this._setCameras(cameras);
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
      this._setCameras(this._cameras.map((camera) => camera.lastDetection?.visitId === id ? { ...camera, lastDetection: null } : camera));
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

  private async _loadForView(): Promise<void> {
    if (!this._hass || !this.isConnected) return;
    this._error = "";
    const generation = this._generation;
    const view = this._view;
    // Only show a loading state when there is nothing to show yet; otherwise refresh behind what's on screen.
    this._loading = view === "live" ? !this._cameras.length : view === "wildlife" ? !this._species.length : view === "visit" ? !this._visit : !this._health && !this._review.length;
    try {
      if (view === "live") await this._loadCameras(generation);
      else if (view === "visit") {
        if (this._visitId) await this._loadVisit(this._visitId, generation);
        else this._visit = null;
      } else if (view === "wildlife") await this._loadWildlife(generation);
      else await this._loadInsights(generation);
    } catch {
      if (this._isActive(generation)) this._setError(`Kestrel couldn't load ${view === "insights" ? "the check-up" : view === "visit" ? "this visit" : view === "wildlife" ? "wildlife records" : "the cameras"}. Check the connection and try again.`);
    } finally {
      if (this._isActive(generation)) this._loading = false;
    }
  }

  private async _loadCameras(generation = this._generation): Promise<void> {
    if (!this._hass) return;
    this._ensureNvrComponents();
    const cameras = await api.cameras(this._hass);
    if (this._isActive(generation)) this._setCameras(cameraArray(cameras));
  }

  /** Replacing a list that hasn't changed would still re-render every tile, so an identical refresh is dropped. */
  private _camerasSignature = "";
  private _speciesSignature = "";

  private _setCameras(cameras: Camera[]): void {
    const next = cameras.slice(0, 32);
    const signature = JSON.stringify(next);
    if (signature === this._camerasSignature && this._cameras.length) return;
    this._camerasSignature = signature;
    this._cameras = next;
    // Signed picture links are good for hours, not for the six this snapshot is kept: they are never stored.
    writeCached("cameras", next.map((camera) => ({ ...camera, picture: null })));
  }

  private _setSpecies(species: Species[]): void {
    const next = species.slice(0, 500);
    const signature = JSON.stringify(next);
    if (signature === this._speciesSignature && this._species.length) return;
    this._speciesSignature = signature;
    this._species = next;
    writeCached("species", next);
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
    const [speciesResult, settingsResult, camerasResult] = await Promise.allSettled([
      api.species(this._hass), api.settings(this._hass), api.cameras(this._hass),
    ]);
    if (!this._isActive(generation)) return;
    if (speciesResult.status === "fulfilled") this._setSpecies(speciesArray(speciesResult.value));
    if (settingsResult.status === "fulfilled" && JSON.stringify(settingsResult.value) !== JSON.stringify(this._settings)) this._settings = settingsResult.value;
    if (camerasResult.status === "fulfilled") this._setCameras(cameraArray(camerasResult.value));
    if (speciesResult.status === "rejected") throw speciesResult.reason;
    this._speciesVisible = Math.min(24, Math.max(this._speciesVisible, 24));
  }

  private async _loadSpecies(): Promise<void> {
    if (!this._hass) return;
    try { this._setSpecies(speciesArray(await api.species(this._hass))); }
    catch { /* keep the last good species list */ }
  }

  private async _loadInsights(generation = this._generation): Promise<void> {
    if (!this._hass) return;
    const results = await Promise.allSettled([api.health(this._hass), api.review(this._hass), api.cameras(this._hass)]);
    if (!this._isActive(generation)) return;
    const [health, review, cameras] = results;
    if (health.status === "fulfilled") this._health = health.value;
    if (review.status === "fulfilled") this._review = visitPage(review.value).items.slice(0, 24);
    if (cameras.status === "fulfilled") this._setCameras(cameraArray(cameras.value));
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
    catch { this._setToast({ message: "Species search is unavailable. Try again shortly.", duration: 4500 }); }
  }

  /** A species sheet is a history entry of its own, so Back (or the phone's back gesture) closes it. */
  private _openSpecies(name: string): void { navigate("wildlife", `?s=${encodeURIComponent(name)}`); }
  private _closeSpecies(): void { goBack("wildlife"); }

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

  private _onFilter(event: Event): void {
    const value = (event as CustomEvent<{ value: string }>).detail.value;
    const filter: SpeciesFilter = value === "seen" || value === "heard" ? value : "all";
    this._speciesFilter = filter;
    this._speciesVisible = 24;
    rememberFilter(filter);
  }

  private _openWrongPicker(): void {
    this._pickerOpen = true;
    this._search = "";
    void this._loadLabels();
    if (!this._species.length) void this._loadSpecies();
  }

  private _closeWrongPicker(): void { this._pickerOpen = false; this._search = ""; }
  private _closeHelp(): void { this._helpOpen = false; }

  private async _correctVisit(species: string): Promise<void> {
    const current = this._visit;
    if (!this._hass || !current || this._saving) return;
    const before = { ...current, clip: { ...current.clip }, camera: { ...current.camera }, suggestions: [...current.suggestions] };
    this._pendingUndo = { visitId: current.id, before };
    this._visit = { ...current, species: species === "not_animal" ? "Not an animal" : species === "unknown" ? "Unidentified animal" : species, status: species === "not_animal" ? "not_animal" : species === "unknown" ? "unknown" : "corrected" };
    this._pickerOpen = false;
    this._saving = true;
    this._setToast({ message: species === "not_animal" ? "Marked as not an animal" : species === "unknown" ? "Marked as unsure" : `Changed to ${species}`, actionLabel: "Undo", action: () => this._undoAction(), duration: 10_000 });
    try {
      const response = await api.correct(this._hass, current.id, species);
      const updated = asVisit(response);
      if (updated && this.isConnected && this._visitId === current.id) this._visit = updated;
    } catch {
      if (this.isConnected && this._visitId === current.id) this._visit = before;
      this._pendingUndo = null;
      this._setToast({ message: "The correction wasn't saved. Try again.", duration: 5000 });
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
    this._setToast({ message: alsoHeard ? "Heard visit confirmed" : "Visit confirmed", actionLabel: "Undo", action: () => this._undoAction(), duration: 10_000 });
    try {
      const response = await api.confirm(this._hass, visitId, alsoHeard);
      const updated = asVisit(response);
      if (updated && this.isConnected && this._visitId === visitId) this._visit = updated;
    } catch {
      if (before && this.isConnected && this._visitId === visitId) this._visit = before;
      if (alsoHeard) this._heardConfirmed = false;
      this._pendingUndo = null;
      this._setToast({ message: "The confirmation wasn't saved. Try again.", duration: 5000 });
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
      this._setToast({ message: "Undone", duration: 3500 });
    } catch {
      this._setToast({ message: "Undo is no longer available. The visit may have updated.", duration: 5000 });
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
      this._setToast({ message: muted ? `${species.species} notifications restored` : `${species.species} notifications muted`, duration: 4000 });
    } catch {
      this._settings = before;
      this._setToast({ message: "Notification setting couldn't be saved.", duration: 5000 });
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
      } else this._setToast({ message: "No recording is available for this call.", duration: 4500 });
    } catch { this._setToast({ message: "The call recording couldn't be loaded.", duration: 4500 }); }
    finally { this._audioLoading = null; }
  }

  private _setToast(toast: ToastState): void {
    window.clearTimeout(this._toastTimer);
    this._toast = toast;
    if ((toast.duration ?? 5000) > 0) this._toastTimer = window.setTimeout(() => { this._toast = null; }, toast.duration ?? 5000);
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

  private _maxLive(): number { return this._panel.width === 0 || this._panel.width <= 680 ? 4 : 9; }

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

  private _goTo(view: "live" | "wildlife" | "insights"): void { navigate(view); }
  private _openCamera(id: string): void { this._selectedCamera = id; navigate("live"); }
  private _openVisit(id: string): void { navigate("visit", `?v=${encodeURIComponent(id)}`); }
  /** Back from a visit returns to wherever it was opened from, with that page where it was left. */
  private _onBack(): void { this._selectedCamera = null; goBack("live"); }

  private _onMenu(): void {
    this.dispatchEvent(new CustomEvent("hass-toggle-menu", { bubbles: true, composed: true }));
  }

  private _statusKind(health: Camera["health"]): string {
    return health === "ok" ? "ok" : health === "unstable" ? "warn" : "danger";
  }

  private _healthLabel(camera: Camera): string {
    if (!camera.online) return "Offline";
    const labels: Record<Camera["health"], string> = { ok: "Online", unstable: "Unstable", offline: "Offline" };
    return labels[camera.health] ?? "Offline";
  }

  private _cameraName(id: string | number): string {
    return this._cameras.find((camera) => String(camera.id) === String(id))?.name ?? `Camera ${id}`;
  }

  /** The camera's latest animal as a button: kind icon, species and when, opening that visit. */
  private _renderSighting(detection: CameraDetection) {
    const kind = asKind(detection.kind);
    const phrase = `${kind ? `${KIND[kind].verb} ` : ""}${when(detection.at)}`;
    const spoken = `${kind ? `${KIND[kind].verb.toLowerCase()} ` : ""}${when(detection.at)}`;
    return html`<button class="chip-button" type="button" aria-label=${`Open ${detection.species}, ${spoken}`} @pointerdown=${() => this._warmVisit(detection.visitId)} @click=${() => this._openVisit(detection.visitId)}>
      ${kind ? html`<ha-icon .icon=${KIND[kind].icon} aria-hidden="true"></ha-icon>` : nothing}
      <span class="lines"><span class="lead">${detection.species}</span><span class="sub">${phrase}</span></span>
    </button>`;
  }

  private _renderHeader() {
    const title = this._view === "live" ? "Live cameras" : this._view === "wildlife" ? "Wildlife" : this._view === "insights" ? "AI check-up" : "Visit";
    return html`<header class="topbar">
      ${this._view === "visit" ? html`<button class="back-button" type="button" aria-label="Back" @click=${this._onBack}><ha-icon .icon=${"mdi:arrow-left"}></ha-icon></button>` : this.narrow ? html`<button class="icon-button menu-button" type="button" aria-label="Show sidebar" @click=${this._onMenu}><ha-icon .icon=${"mdi:menu"}></ha-icon></button>` : nothing}
      <img class="brand" src=${KestrelMark} alt="Kestrel mark" width="32" height="32">
      <div class="title-stack"><strong>Kestrel</strong><span>${title}</span></div>
      ${this._view === "live" ? html`<a class="open-scrypted" href=${SCRYPTED_URL} target="_blank" rel="noopener noreferrer">Open in Scrypted</a>` : nothing}
      <button class="icon-button shortcuts-button" type="button" aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)" @click=${() => { this._helpOpen = true; }}><ha-icon .icon=${"mdi:keyboard-outline"}></ha-icon></button>
    </header>`;
  }

  private _renderNav() {
    if (this._view === "visit") return nothing;
    return html`<nav class="navigation" aria-label="Camera sections">
      ${NAV.map((item, index) => html`<button type="button" class="nav-item ${this._view === item.view ? "selected" : ""}" aria-current=${this._view === item.view ? "page" : nothing} aria-keyshortcuts=${String(index + 1)} title=${`${item.label} (${index + 1})`} @click=${() => this._goTo(item.view)}>
        <ha-icon .icon=${item.icon} aria-hidden="true"></ha-icon><span>${item.label}</span>
      </button>`)}
    </nav>`;
  }

  private _renderLoadError() {
    if (!this._error) return nothing;
    return html`<section class="error-state" role="alert"><ha-icon .icon=${"mdi:cloud-alert"}></ha-icon><div><strong>Couldn't load this view</strong><p>${this._error}</p><button type="button" class="pill secondary" @click=${() => this._loadForView()}>Try again</button></div></section>`;
  }

  /** Shaped like the camera grid it stands in for, so nothing moves when the cameras arrive. */
  private _renderCameraSkeleton() {
    return html`<section class="live-view" role="status" aria-label="Loading your cameras">
      <div class="section-heading"><div><h1>Your cameras</h1><p class="muted">Connecting…</p></div></div>
      <div class="camera-grid">${Array.from({ length: 6 }, () => html`<div class="camera-tile"><div class="bone camera-bone"></div><div class="bone line"></div><div class="bone line short"></div></div>`)}</div>
    </section>`;
  }

  private _renderWildlifeSkeleton() {
    return html`<section class="wildlife-view" role="status" aria-label="Loading your wildlife list">
      <div class="section-heading"><div><h1>Wildlife</h1><p class="muted">Loading…</p></div></div>
      <div class="bone segmented-bone"></div>
      <div class="species-grid">${Array.from({ length: 12 }, () => html`<div class="species-tile skeleton"><div class="bone species-bone"></div><div class="bone line"></div><div class="bone line short"></div></div>`)}</div>
    </section>`;
  }

  private _renderLive() {
    if (this._loading && !this._cameras.length) return this._renderCameraSkeleton();
    if (!this._cameras.length) return html`<section class="empty-state"><ha-icon .icon=${"mdi:cctv-off"}></ha-icon><h2>No cameras are available</h2><p>Kestrel hasn't received a camera list yet.</p><button class="pill secondary" @click=${() => this._loadCameras()}>Refresh</button></section>`;
    const selected = this._selectedCamera ? this._cameras.find((camera) => String(camera.id) === this._selectedCamera) : null;
    if (selected) {
      return html`<section class="focused-camera">
        <div class="section-heading"><button class="back-inline" type="button" @pointerdown=${this._prewarmFocus} @keydown=${this._prewarmFocus} @click=${() => { this._selectedCamera = null; }}>All cameras</button><h1>${selected.name}</h1><span class="status-chip"><i class="status-dot ${this._statusKind(selected.health)}"></i>${this._healthLabel(selected)}</span></div>
        ${selected.nvrCardId === null ? html`<div class="focused-snapshot"><kestrel-live-picture class="snapshot-image" .src=${cameraPicture(selected) ?? ""} .paused=${this._liveIsPaused()} alt=${`${selected.name} latest picture`} wide @kestrel-picture-expired=${this._onPictureExpired}></kestrel-live-picture><span class="snapshot-chip">Snapshot only</span></div>` : selected.online ? html`<kestrel-live-player mode="focus" .cameraId=${String(selected.id)} .nvrCardId=${selected.nvrCardId} .label=${selected.name} .live=${true} .paused=${this._liveIsPaused()} .wide=${this._panel.width > 680} .scryptedUrl=${SCRYPTED_URL} .hass=${this._hass}></kestrel-live-player>` : html`<div class="unsupported-stream"><ha-icon .icon=${"mdi:cctv-off"}></ha-icon><strong>Camera is offline</strong><span>The last camera health state is offline.</span><a href=${SCRYPTED_URL} target="_blank" rel="noopener noreferrer">Open in Scrypted</a></div>`}
        <div class="camera-meta"><span>${selected.drops1h ?? 0} stream drops in the last hour</span>${recentSighting(selected) ? this._renderSighting(recentSighting(selected) as CameraDetection) : html`<span class="muted">No sightings in the last 24 hours</span>`}</div>
      </section>`;
    }
    const liveIds = new Set(this._cameras.filter((camera) => camera.nvrCardId !== null && camera.online).map((camera) => String(camera.id)).slice(0, this._maxLive()));
    return html`<section class="live-view">
      <div class="section-heading"><div><h1>Your cameras</h1><p class="muted">Tap a view to make it the main picture.</p></div><span class="camera-count">${this._cameras.length} cameras</span></div>
      <div class="camera-grid">${this._cameras.slice(0, 32).map((camera) => {
        const sighting = recentSighting(camera);
        return html`<article class="camera-tile">
          <button class="camera-focus" type="button" aria-label=${`Focus ${camera.name}`} @pointerdown=${this._prewarmTile} @keydown=${this._prewarmTile} @click=${() => { this._selectedCamera = String(camera.id); }}>
            <div class="camera-picture">
              ${camera.nvrCardId === null
                ? html`<kestrel-live-picture class="camera-snapshot" .src=${cameraPicture(camera) ?? ""} .paused=${this._liveIsPaused()} alt=${`${camera.name} latest picture`} @kestrel-picture-expired=${this._onPictureExpired}></kestrel-live-picture><span class="snapshot-chip">Snapshot only</span>`
                : camera.online
                  ? html`<kestrel-live-player .cameraId=${String(camera.id)} .nvrCardId=${camera.nvrCardId} .label=${camera.name} .live=${liveIds.has(String(camera.id))} .paused=${this._liveIsPaused()} .hass=${this._hass}></kestrel-live-player>`
                  : html`<div class="stream-placeholder static"><ha-icon .icon=${"mdi:cctv-off"}></ha-icon><span>Camera offline</span></div>`}
              <span class="camera-health"><i class="status-dot ${this._statusKind(camera.health)}"></i>${this._healthLabel(camera)}</span>
            </div>
            <strong class="camera-name">${camera.name}</strong>
          </button>
          <div class="camera-sighting">${sighting ? this._renderSighting(sighting) : html`<span class="muted">${camera.wildlife ? "Wildlife enabled" : "Camera"}</span>`}</div>
        </article>`;
      })}
      </div>
      ${this._cameras.every((camera) => camera.nvrCardId === null) ? html`<p class="muted all-unsupported">Live streams aren't enabled for these cameras. Open Scrypted to view them.</p>` : nothing}
    </section>`;
  }

  private _renderVisit() {
    const visit = this._visit;
    if (!this._visitId) return html`<section class="empty-state"><ha-icon .icon=${"mdi:timeline-clock-outline"}></ha-icon><h2>No visit selected</h2><p>Open a visit from a camera card or from the wildlife list to see its picture and clip.</p><div class="state-actions"><button class="pill primary" type="button" @click=${() => this._goTo("wildlife")}>See wildlife</button><button class="pill secondary" type="button" @click=${() => this._goTo("live")}>Cameras</button></div></section>`;
    if (!visit && this._visitGone?.id === this._visitId) return this._renderVisitGone(this._visitGone.camera);
    if (!visit && this._loading) return html`<article class="visit-view" role="status" aria-label="Loading this visit">
      <div class="visit-hero sheet"><div class="bone visit-bone"></div></div>
      <div class="visit-summary"><div class="bone line"></div><div class="bone line short"></div><div class="bone line"></div></div>
    </article>`;
    if (!visit) return html`<section class="empty-state"><ha-icon .icon=${"mdi:cloud-alert"}></ha-icon><h2>This visit didn't load</h2><p>Kestrel couldn't reach the server. Check the connection and try again.</p><button class="pill secondary" type="button" @click=${() => this._loadForView()}>Try again</button></section>`;
    const photo = visitSnapshot(visit);
    const clip = visitClip(visit);
    const pending = visit.clip?.state === "pending";
    const confirmed = visit.status === "confirmed";
    const heard = visit.heard ?? null;
    const progress = pending ? this._progress : 0;
    return html`<article class="visit-view">
      <section class="visit-hero sheet">
        ${visit.clip?.state === "ready" && clip
          ? html`<video class="visit-video" src=${clip} poster=${photo ?? nothing} controls autoplay muted playsinline preload="auto" aria-label=${`${visit.species} visit clip`}></video>`
          : photo
            ? html`<kestrel-lazy-image class="visit-image" .src=${photo} alt=${`${visit.species} at ${visit.camera.name}`} wide></kestrel-lazy-image>`
            : visit.kind === "heard"
              ? html`<kestrel-lazy-image class="visit-image" .src=${this._visitReferencePhoto ?? ""} alt=${`${visit.species} reference photo`} wide @kestrel-image-error=${() => this._onVisitReferenceImageError()}><div slot="empty" class="heard-hero"><ha-icon .icon=${"mdi:waveform"}></ha-icon></div></kestrel-lazy-image>`
              : html`<kestrel-lazy-image class="visit-image" .src=${""} alt=${visit.species || "Unidentified animal"} wide></kestrel-lazy-image>`}
        ${visit.kind === "heard" && !photo && this._visitReferencePhoto && !this._visitReferencePhotoFailed ? html`<span class="snapshot-chip">Reference photo</span>` : nothing}
        ${pending ? html`<div class="clip-progress"><div class="progress-label"><span>Saving clip…</span><span>${Math.round(progress)}%</span></div><div class="progress-track" role="progressbar" aria-label="Clip processing" aria-valuemin="0" aria-valuemax="100" aria-valuenow=${Math.round(progress)}><span style=${`width:${progress}%`}></span></div><p class="caption">The recording is still being finalized. This view updates when it's ready.</p></div>` : nothing}
        ${visit.clip?.state === "none" && visit.kind !== "heard" ? html`<p class="media-note">No clip was saved for this visit.</p>` : nothing}
        ${visit.clip?.state === "deleted" ? html`<p class="media-note">This clip is no longer available.</p>` : nothing}
        ${visit.clip?.state === "ready" && !clip ? html`<p class="media-note">The clip is ready, but its signed link isn't available yet.</p>` : nothing}
      </section>
      <div class="visit-summary">
        <div class="visit-title-row"><div><h1>${visit.species || "Unidentified animal"}</h1><p class="muted">${visit.camera.name} · ${dateTime(visit.startedAt)}</p></div><span class="score">${Math.round((visit.score ?? 0) * 100)}<small>%</small></span></div>
        <div class="visit-tags"><span class="status-chip"><ha-icon .icon=${KIND[asKind(visit.kind) ?? "seen"].icon} aria-hidden="true"></ha-icon>${evidenceWord(visit)}</span><span class="status-chip">${GROUP_LABEL[visit.grp] ?? GROUP_LABEL.unknown}</span><span class="status-chip">${this._statusLabel(visit.status)}</span>${visit.firstEver ? html`<span class="status-chip new-tag">First visit</span>` : nothing}</div>
        <div class="visit-actions"><button class="pill primary" type="button" ?disabled=${confirmed || this._saving} @click=${() => this._confirmVisit()}>${confirmed ? "✓ Confirmed" : "✓ That's right"}</button><button class="pill secondary" type="button" ?disabled=${this._saving} @click=${this._openWrongPicker}>Wrong?</button></div>
        ${visit.kind === "heard" ? html`<section class="heard-panel tile"><div class="heard-copy"><strong>Call recording</strong><span class="muted">${visit.species || "Unidentified sound"} detected here</span></div>${this._audioUrl ? this._renderRecording(this._audioUrl, visit, `Call recording of ${visit.species}`) : html`<span class="muted">No recording is available for this visit.</span>`}</section>` : nothing}
        ${heard ? html`<section class="heard-panel tile"><div class="heard-copy"><strong>Also heard: ${heard.species}</strong><span class="muted">Sound recorded near this visit</span></div><button class="pill secondary" type="button" ?disabled=${this._saving || this._heardConfirmed} @click=${() => this._confirmVisit(visit.id, true)}>${this._heardConfirmed ? "✓ Also heard" : "✓ Also heard"}</button>
          ${this._audioUrl ? this._renderRecording(this._audioUrl, this._callVisit ?? heard, `Call recording of ${heard.species}`) : html`<button class="text-button" type="button" ?disabled=${!heard.hasAudio || this._audioLoading === heard.visitId} @click=${() => this._loadCallAudio(heard.visitId)}>${this._audioLoading === heard.visitId ? "Loading recording…" : heard.hasAudio ? "Play call" : "No call recording"}</button>`}
        </section>` : nothing}
      </div>
      ${this._pickerOpen ? this._renderCorrectionSheet(visit) : nothing}
    </article>`;
  }

  /** A calm explanation, not an error: merged and removed visits are normal, and old notifications still point at them. */
  private _renderVisitGone(camera: { id: string; name: string } | null) {
    return html`<section class="empty-state" role="status"><ha-icon .icon=${"mdi:call-merge"}></ha-icon><h2>This visit was merged or removed</h2><p>Kestrel combines repeat sightings of the same animal and clears false alarms, so an older notification can point at one that is gone.</p>
      <div class="state-actions"><button class="pill primary" type="button" @click=${() => this._goTo("wildlife")}>See wildlife</button>${camera ? html`<button class="pill secondary" type="button" @click=${() => this._openCamera(camera.id)}>${camera.name}</button>` : html`<button class="pill secondary" type="button" @click=${() => this._goTo("live")}>Cameras</button>`}</div>
    </section>`;
  }

  /** A recording player with what the preview service says about it: whether it was cleaned, the moment that
   * was matched, and the untouched original (only when it really is a different file). */
  private _renderRecording(src: string, source: { audioOriginal?: string | null; audioInfo?: AudioInfo | null } | null, label: string) {
    const original = source ? visitAudioOriginal(source) : null;
    const notes = recordingNotes(source?.audioInfo);
    return html`<kestrel-lu-audio-player .src=${src} .original=${original && !sameMedia(original, src) ? original : ""} .mark=${notes.mark} .caption=${notes.caption} label=${label} preload="metadata"></kestrel-lu-audio-player>`;
  }

  private _statusLabel(status: Visit["status"]): string {
    const labels: Record<Visit["status"], string> = { auto: "Model guess", learned: "Learned", corrected: "Corrected", confirmed: "Confirmed", not_animal: "Not an animal", unknown: "Not sure" };
    return labels[status] ?? "Visit";
  }

  private _onReferenceImageError(name: string): void {
    if (this._failedReferenceImages.has(name)) return;
    this._failedReferenceImages.add(name);
    this.requestUpdate("_failedReferenceImages", undefined);
  }

  private _onVisitReferenceImageError(): void { this._visitReferencePhotoFailed = true; }

  private _renderCorrectionSheet(visit: Visit) {
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
    return html`<kestrel-sheet heading="What was it?" subheading="Choose a better match or search the species list." @close=${this._closeWrongPicker}>
      <input class="species-search" type="search" placeholder="Search species" aria-label="Search species" .value=${this._search} @input=${(event: Event) => { this._search = (event.currentTarget as HTMLInputElement).value; }}>
      <div class="choice-list" role="listbox" aria-label="Species choices">
        ${candidates.map((row) => html`<button class="choice-row" type="button" role="option" @click=${() => this._correctVisit(row.name)}><span class="choice-copy"><span>${row.name}</span>${row.reason ? html`<small class="caption">${row.reason}</small>` : nothing}</span><ha-icon .icon=${"mdi:chevron-right"}></ha-icon></button>`)}
        ${candidates.length === 0 ? html`<p class="muted no-match">No matching species.</p>` : nothing}
      </div>
      <div class="special-choices"><button class="pill secondary" type="button" @click=${() => this._correctVisit("not_animal")}>Not an animal</button><button class="pill secondary" type="button" @click=${() => this._correctVisit("unknown")}>Can't tell</button></div>
    </kestrel-sheet>`;
  }

  private _renderHelp() {
    const rows = [...NAV.map((item, index) => [String(index + 1), item.label] as const), ["?", "Show this list"], ["Esc", "Close a sheet"]];
    return html`<kestrel-sheet heading="Keyboard shortcuts" subheading="Single keys work anywhere in Kestrel." @close=${this._closeHelp}>
      <ul class="shortcut-list" role="list">${rows.map(([key, label]) => html`<li><kbd>${key}</kbd><span>${label}</span></li>`)}</ul>
    </kestrel-sheet>`;
  }

  private _renderWildlife() {
    if (this._loading && !this._species.length) return this._renderWildlifeSkeleton();
    if (!this._species.length) return html`<section class="empty-state"><ha-icon .icon=${"mdi:paw-outline"}></ha-icon><h2>No wildlife visits yet</h2><p>Identified birds and animals will appear here with their videos and recordings.</p></section>`;
    const counts = filterCounts(this._species);
    const shown = this._species.filter((species) => matchesFilter(species, this._speciesFilter));
    const visible = shown.slice(0, this._speciesVisible);
    const options = [
      { value: "all", label: "All", icon: "mdi:paw", count: counts.all },
      { value: "seen", label: "On camera", icon: KIND.seen.icon, count: counts.seen },
      { value: "heard", label: KIND.heard.word, icon: KIND.heard.icon, count: counts.heard },
    ];
    return html`<section class="wildlife-view">
      <div class="section-heading"><div><h1>Wildlife</h1><p class="muted summary"><span>${counts.all} species</span><span aria-hidden="true">·</span><span><ha-icon .icon=${KIND.seen.icon} aria-hidden="true"></ha-icon>${counts.seen} on camera</span><span aria-hidden="true">·</span><span><ha-icon .icon=${KIND.heard.icon} aria-hidden="true"></ha-icon>${counts.heard} heard</span></p></div></div>
      <kestrel-lu-segmented label="Show species" .value=${this._speciesFilter} .options=${options} @lu-change=${this._onFilter}></kestrel-lu-segmented>
      ${visible.length
        ? html`<div class="species-grid">${visible.map((species) => this._renderSpeciesTile(species))}</div>
          ${this._speciesVisible < shown.length ? html`<button class="pill secondary show-more" type="button" @click=${() => { this._speciesVisible = Math.min(this._speciesVisible + 24, shown.length); }}>Show more species</button>` : nothing}`
        : html`<section class="empty-state"><ha-icon .icon=${this._speciesFilter === "seen" ? KIND.seen.icon : KIND.heard.icon}></ha-icon><h2>${this._speciesFilter === "seen" ? "Nothing on camera yet" : "Nothing heard yet"}</h2><p>${this._speciesFilter === "seen" ? "When a camera catches an animal, it shows up here with its video." : "Sounds picked up by BirdNET-Go show up here with their recordings."}</p><button class="pill secondary" type="button" @click=${this._showAllSpecies}>Show all species</button></section>`}
    </section>`;
  }

  /** Over the page, outside the cached views: a modal inside a hidden view would still block the document. */
  private _renderSpeciesSheet() {
    const selected = this._view === "wildlife" && this._selectedSpecies ? this._species.find((species) => species.species === this._selectedSpecies) : undefined;
    if (!selected) return nothing;
    return html`<kestrel-species-sheet .hass=${this._hass} .species=${selected} .cameras=${this._cameras} .muted=${this._settings?.mutedSpecies.includes(selected.species) ?? false} .canMute=${this._settings !== null} @close=${this._closeSpecies} @open-visit=${this._onOpenVisit} @warm-visit=${this._onWarmVisit} @toggle-mute=${() => this._toggleMute(selected)}></kestrel-species-sheet>`;
  }

  /** Shown views are rendered; the others keep what they last showed. Live is rendered once more when its
   * streams are paused or resumed. */
  private _renderCached(view: CachedView): unknown {
    const active = this._view === view;
    if (active) this._mounted.add(view);
    if (!this._mounted.has(view)) return nothing;
    let content: TemplateResult | undefined;
    if (active || (view === "live" && this._liveIsPaused() !== this._frozenLivePaused)) {
      content = view === "live" ? this._renderLive() : view === "wildlife" ? this._renderWildlife() : this._renderInsights();
      if (view === "live") this._frozenLivePaused = this._liveIsPaused();
      this._frozen.set(view, content);
    } else content = this._frozen.get(view);
    return html`<div class="view" data-view=${view} data-active=${active ? "true" : "false"} ?inert=${!active}>${content}</div>`;
  }

  private _renderSpeciesTile(species: Species) {
    const picture = speciesPicture(species);
    const activity = lastActivity(species);
    const camera = activity?.camera ? this._cameraName(activity.camera) : null;
    const when1 = activity ? (activity.kind ? `${KIND[activity.kind].verb} ${when(activity.at)}` : sentence(when(activity.at))) : null;
    const line = when1 ? `${when1}${camera ? ` · ${camera}` : ""}` : null;
    const evidence = (["seen", "heard"] as const).filter((kind) => species[kind]).map((kind) => ({ kind, count: kind === "seen" ? species.seenCount30d : species.heardCount30d }));
    const summary = evidence.map(({ kind, count }) => count ? evidenceCount(kind, count) : KIND[kind].verb).join(", ");
    return html`<button class="species-tile" type="button" aria-label=${`${species.species}. ${summary}${line ? `. ${line}` : ""}`} @click=${() => this._openSpecies(species.species)}>
      <div class="species-photo">
        <kestrel-lazy-image .src=${picture.url ?? ""} alt=${species.species} square @kestrel-image-error=${() => this._onReferenceImageError(species.species)}>${species.heard ? html`<div slot="empty" class="heard-hero"><ha-icon .icon=${KIND.heard.icon}></ha-icon></div>` : nothing}</kestrel-lazy-image>
        ${picture.isReference && !this._failedReferenceImages.has(species.species) ? html`<span class="snapshot-chip">Reference photo</span>` : nothing}
        <span class="badge-row" aria-hidden="true">${evidence.map(({ kind, count }) => badge(KIND[kind].icon, count ? (count > 999 ? "999+" : count) : null))}</span>
      </div>
      <span class="species-name">${species.species}</span>
      ${line ? html`<span class="species-last">${activity?.kind ? html`<ha-icon .icon=${KIND[activity.kind].icon} aria-hidden="true"></ha-icon>` : nothing}<span>${line}</span></span>` : nothing}
      ${species.newThisYear ? html`<span class="new-tag">New this year</span>` : nothing}
    </button>`;
  }

  private _renderInsights() {
    if (this._loading && !this._health && !this._review.length) return html`<section class="insights-view" role="status" aria-label="Checking the wildlife system">
      <div class="section-heading"><div><h1>AI check-up</h1><p class="muted">Checking the wildlife system…</p></div></div>
      <div class="health-grid">${Array.from({ length: 4 }, () => html`<div class="bone health-bone"></div>`)}</div>
    </section>`;
    const health = this._health;
    const noisy = (health?.cameras ?? []).filter((camera) => camera.emptyChecksToday > 0).sort((a, b) => (b.emptyChecksToday / Math.max(1, b.checksToday)) - (a.emptyChecksToday / Math.max(1, a.checksToday))).slice(0, 5);
    const storage = health ? health.storage.dbMB + health.storage.mediaMB : 0;
    const storagePercent = health?.storage.budgetMB ? clamp((storage / health.storage.budgetMB) * 100, 0, 100) : 0;
    const gpuPercent = health?.gpu.totalMiB ? clamp((health.gpu.usedMiB / health.gpu.totalMiB) * 100, 0, 100) : 0;
    return html`<section class="insights-view">
      <div class="section-heading"><div><h1>AI check-up</h1><p class="muted">A quick look at the wildlife system's health.</p></div><button class="icon-button" type="button" aria-label="Refresh check-up" @click=${() => this._loadForView()}><ha-icon .icon=${"mdi:refresh"}></ha-icon></button></div>
      <section class="review-section sheet"><div class="section-heading compact"><div><h2>Needs a look</h2><p class="muted">Visits that may need a correction.</p></div><span class="count-badge">${this._review.length}</span></div>${this._review.length ? html`<ul class="visit-list">${this._review.slice(0, 12).map((visit) => html`<li><button class="visit-row" type="button" @click=${() => this._openVisit(visit.id)}><kestrel-lazy-image class="review-thumb" .src=${visitSnapshot(visit) ?? ""} .alt=${visit.species} square></kestrel-lazy-image><span class="review-copy"><strong>${visit.species || "Unidentified animal"}</strong><small class="review-meta"><ha-icon .icon=${KIND[asKind(visit.kind) ?? "seen"].icon} aria-hidden="true"></ha-icon>${visit.camera.name} · ${ago(visit.startedAt)}</small></span><ha-icon .icon=${"mdi:chevron-right"}></ha-icon></button></li>`)}</ul>` : html`<p class="empty-inline">Nothing needs a review right now.</p>`}</section>
      <section class="health-grid">
        <article class="health-tile tile"><div class="health-title"><ha-icon .icon=${"mdi:brain"}></ha-icon><span>Wildlife detector</span></div><strong>${health?.detector.name ?? "Not available"}</strong><p>${health ? (health.detector.avgMs === null ? health.detector.provider : `${health.detector.provider} · ${health.detector.avgMs} ms average`) : "Waiting for health data"}</p><small>${health?.detector.checksToday ?? 0} checks today</small></article>
        <article class="health-tile tile"><div class="health-title"><ha-icon .icon=${"mdi:expansion-card"}></ha-icon><span>GPU memory</span></div><strong>${health ? `${formatMiB(health.gpu.usedMiB)} / ${formatMiB(health.gpu.totalMiB)}` : "Not available"}</strong><div class="meter"><span style=${`width:${gpuPercent}%`}></span></div><small>${health?.gpu.util ?? 0}% GPU use</small></article>
        <article class="health-tile tile"><div class="health-title"><ha-icon .icon=${"mdi:database"}></ha-icon><span>Wildlife storage</span></div><strong>${health ? `${storage.toFixed(1)} / ${health.storage.budgetMB} MB` : "Not available"}</strong><div class="meter"><span style=${`width:${storagePercent}%`}></span></div><small>${health ? `${health.storage.dbMB.toFixed(1)} MB database · ${health.storage.mediaMB.toFixed(1)} MB photos and clips` : "Waiting for health data"}</small></article>
        <article class="health-tile tile"><div class="health-title"><ha-icon .icon=${"mdi:check-decagram"}></ha-icon><span>Corrections</span></div><strong>${health?.corrections.sinceRetrain ?? 0}</strong><p>since the last model retrain</p><small>${health?.corrections.total ?? 0} all-time corrections</small></article>
        <article class="health-tile tile"><div class="health-title"><ha-icon .icon=${"mdi:microphone"}></ha-icon><span>BirdNET sound detector</span></div><strong class=${health?.birdnet ? (health.birdnet.online ? "healthy" : "unhealthy") : ""}>${health?.birdnet ? (health.birdnet.online ? "Online" : "Offline") : "Not set up yet"}</strong><p>${health?.birdnet?.lastHeardAt ? `Last heard ${ago(health.birdnet.lastHeardAt)}` : "No recent sound detections"}</p>${health?.birdnetLink ? html`<a class="text-button" href=${health.birdnetLink} target="_blank" rel="noopener noreferrer">Open in BirdNET-Go</a>` : nothing}</article>
      </section>
      <section class="noisy-section sheet"><div class="section-heading compact"><div><h2>Quiet camera checks</h2><p class="muted">Checks with no animal detection today.</p></div></div>${noisy.length ? html`<ul class="simple-list">${noisy.map((camera) => html`<li><span>${this._cameraName(camera.id)}</span><strong>${camera.emptyChecksToday} of ${camera.checksToday} checks</strong></li>`)}</ul>` : html`<p class="empty-inline">No empty checks reported today.</p>`}</section>
    </section>`;
  }

  private _renderToast() {
    if (!this._toast) return nothing;
    return html`<div class="toast" role="status" aria-live="polite" aria-atomic="true"><span>${this._toast.message}</span>${this._toast.action && this._toast.actionLabel ? html`<button class="toast-action" type="button" @click=${this._toast.action}>${this._toast.actionLabel}</button>` : nothing}<button class="icon-button toast-close" type="button" aria-label="Dismiss" @click=${() => { window.clearTimeout(this._toastTimer); this._toast = null; }}><ha-icon .icon=${"mdi:close"}></ha-icon></button></div>`;
  }

  static styles = [TOKENS_CSS, COMMON_CSS, PARTS_CSS, css`
    :host { container-type: inline-size; min-height: 100%; }
    ha-card { display: block; min-height: calc(100vh - var(--header-height, 56px)); overflow: hidden; border-radius: var(--lu-radius-card); color: var(--lu-ink); }
    .app { min-height: inherit; display: flex; flex-direction: column; position: relative; }
    .topbar { position: relative; display: flex; align-items: center; gap: var(--lu-space-3); min-height: 68px; padding: var(--lu-space-3) var(--lu-edge-x); border-bottom: 1px solid var(--lu-edge); background: var(--lu-card); }
    .brand { width: 32px; height: 32px; object-fit: contain; flex: none; }
    .title-stack { display: flex; flex: 1; min-width: 0; flex-direction: column; gap: 2px; }
    .title-stack strong { color: var(--lu-ink); font-size: var(--lu-type-title); font-weight: 650; letter-spacing: -.015em; }
    .title-stack span { color: var(--lu-ink-2); font-size: var(--lu-type-caption); }
    .open-scrypted { display: inline-flex; align-items: center; min-height: 48px; padding: 0 var(--lu-space-3); border-radius: var(--lu-radius-pill); color: var(--lu-ink-2); font-size: var(--lu-type-label); text-decoration: none; }
    .open-scrypted:is(:active, [data-pressed]) { background: var(--lu-material-press-wash); }
    @media (hover: hover) and (pointer: fine) { .open-scrypted:hover { background: var(--lu-glass-raised); color: var(--lu-ink); } }
    .shortcuts-button { display: none; }
    @media (hover: hover) and (pointer: fine) { .shortcuts-button { display: inline-grid; } }
    .navigation { display: flex; align-items: center; gap: var(--lu-space-1); padding: var(--lu-space-3) var(--lu-edge-x) 0; }
    .nav-item { display: inline-flex; min-height: var(--lu-target); align-items: center; justify-content: center; gap: var(--lu-space-2); padding: 0 var(--lu-space-5); border: 0; border-radius: var(--lu-radius-pill); color: var(--lu-ink-2); background: transparent; font-size: var(--lu-type-label); font-weight: 500; cursor: pointer; }
    .nav-item:is(:active, [data-pressed]):not(.selected) { background: var(--lu-material-press-wash); }
    .nav-item.selected { color: var(--lu-accent-ink); background: var(--lu-accent); }
    .nav-item ha-icon { --mdc-icon-size: 20px; width: 20px; height: 20px; }
    main { flex: 1; min-width: 0; padding: var(--lu-edge-y) var(--lu-edge-x); }
    main > section, main > article, main > .view > section, main > .view > article { max-width: var(--lu-content-max, 1600px); margin-inline: auto; }
    /* A view that isn't showing keeps its layout but is skipped by rendering, so coming back is a repaint, not a rebuild. */
    .view[data-active="false"] { content-visibility: hidden; contain-intrinsic-size: 0 0; }
    @supports not (content-visibility: hidden) { .view[data-active="false"] { display: none; } }
    h1, h2, h3, p { margin: 0; }
    h1 { font-size: clamp(var(--lu-type-title), 3cqi, calc(var(--lu-type-title) * 1.4)); font-weight: 620; letter-spacing: -.02em; line-height: 1.18; }
    h2 { font-size: var(--lu-type-title); font-weight: 620; letter-spacing: -.012em; }
    h3 { margin-bottom: var(--lu-space-3); font-size: var(--lu-type-label); font-weight: 600; }
    p { line-height: 1.45; }
    .section-heading { display: flex; align-items: center; justify-content: space-between; gap: var(--lu-space-4); margin-bottom: var(--lu-space-5); }
    .section-heading > div { min-width: 0; }
    .section-heading p { margin-top: var(--lu-space-1); font-size: var(--lu-type-label); }
    .section-heading.compact { margin-bottom: var(--lu-space-3); }
    .camera-count, .count-badge { color: var(--lu-ink-2); font-size: var(--lu-type-label); font-variant-numeric: tabular-nums; }
    .count-badge { display: inline-grid; min-width: 34px; height: 34px; place-items: center; border-radius: var(--lu-radius-pill); background: var(--lu-accent-soft); color: var(--lu-accent); font-weight: 600; }
    .camera-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, calc(var(--lu-target) * 5)), 1fr)); gap: var(--lu-gutter); }
    .camera-tile { display: grid; min-width: 0; overflow: hidden; border: 1px solid var(--lu-edge); border-radius: var(--lu-radius-card); color: var(--lu-ink); }
    .camera-focus:is(:active, [data-pressed]) .camera-picture::after { content: ""; position: absolute; inset: 0; background: var(--lu-material-press-wash); pointer-events: none; }
    .camera-focus { display: block; width: 100%; padding: 0; border: 0; color: inherit; background: transparent; text-align: left; cursor: pointer; }
    @media (hover: hover) and (pointer: fine) { .camera-focus:hover { background: var(--lu-material-hover-wash); } }
    .camera-focus:is(:active, [data-pressed]) .camera-name { background: var(--lu-material-press-wash); }
    .camera-name { display: block; padding: var(--lu-space-3) var(--lu-space-4) var(--lu-space-2); font-weight: 600; }
    .camera-sighting { display: flex; align-items: center; min-height: var(--lu-target); padding: 0 var(--lu-space-3) var(--lu-space-2); }
    .camera-sighting .muted { padding: 0 var(--lu-space-1); font-size: var(--lu-type-caption); }
    .camera-picture { position: relative; overflow: hidden; aspect-ratio: 16 / 9; background: var(--lu-tile); }
    .camera-picture kestrel-live-player { position: absolute; inset: 0; }
    .focused-snapshot { position: relative; }
    .focused-snapshot .snapshot-image { display: block; width: 100%; aspect-ratio: 16 / 9; min-height: clamp(240px, 45cqi, 520px); border-radius: var(--lu-radius-card); }
    .stream-placeholder { display: grid; place-items: center; min-height: 44px; padding: var(--lu-space-4); color: var(--lu-ink-3); font-size: var(--lu-type-caption); text-align: center; }
    .stream-placeholder.static { position: absolute; inset: 0; gap: var(--lu-space-2); align-content: center; }
    .stream-placeholder.static ha-icon { --mdc-icon-size: 26px; width: 26px; height: 26px; }
    .camera-health { position: absolute; top: var(--lu-space-2); left: var(--lu-space-2); display: inline-flex; min-height: 32px; align-items: center; gap: 6px; padding: 0 var(--lu-space-3); border: 1px solid var(--lu-edge); border-radius: var(--lu-radius-pill); color: var(--lu-ink); background: var(--lu-reading); font-size: var(--lu-type-caption); }
    .camera-picture .camera-snapshot { position: absolute; inset: 0; width: 100%; height: 100%; }
    .snapshot-chip { position: absolute; top: var(--lu-space-2); right: var(--lu-space-2); z-index: 1; display: inline-flex; min-height: 28px; align-items: center; padding: 0 var(--lu-space-3); border: 1px solid var(--lu-edge); border-radius: var(--lu-radius-pill); color: var(--lu-ink-2); background: var(--lu-reading); font-size: var(--lu-type-caption); }
    .status-chip ha-icon { --mdc-icon-size: 16px; width: 16px; height: 16px; flex: none; }
    .status-chip { display: inline-flex; min-height: 32px; align-items: center; gap: 7px; padding: 0 var(--lu-space-3); border: 1px solid var(--lu-edge); border-radius: var(--lu-radius-pill); color: var(--lu-ink-2); background: var(--lu-tile); font-size: var(--lu-type-caption); }
    .all-unsupported { margin-top: var(--lu-space-4); }
    .focused-camera { display: grid; gap: var(--lu-space-4); }
    .focused-camera .section-heading { margin-bottom: 0; }
    .camera-meta { display: flex; flex-wrap: wrap; align-items: center; gap: var(--lu-space-4); color: var(--lu-ink-2); font-size: var(--lu-type-label); }
    .unsupported-stream { display: grid; min-height: 260px; align-content: center; justify-items: center; gap: var(--lu-space-3); padding: var(--lu-space-6); border: 1px solid var(--lu-edge); border-radius: var(--lu-radius-card); color: var(--lu-ink-2); background: var(--lu-tile); text-align: center; }
    .unsupported-stream ha-icon { --mdc-icon-size: 34px; width: 34px; height: 34px; color: var(--lu-ink-3); }
    .unsupported-stream strong { color: var(--lu-ink); }
    .unsupported-stream a { min-height: var(--lu-target); display: inline-flex; align-items: center; }
    .empty-state { display: grid; min-height: 40vh; place-content: center; justify-items: center; gap: var(--lu-space-3); padding: var(--lu-space-6); color: var(--lu-ink-2); text-align: center; }
    .empty-state ha-icon { --mdc-icon-size: 40px; width: 40px; height: 40px; color: var(--lu-ink-3); }
    .empty-state h2 { color: var(--lu-ink); }
    .empty-state p { max-width: 32rem; }
    .error-state { display: flex; align-items: flex-start; gap: var(--lu-space-4); margin-bottom: var(--lu-space-4); padding: var(--lu-space-4); border: 1px solid color-mix(in srgb, var(--lu-danger) 35%, var(--lu-edge)); border-radius: var(--lu-radius-tile); color: var(--lu-danger); }
    .error-state ha-icon { flex: none; }
    .error-state p { margin: var(--lu-space-1) 0 var(--lu-space-3); color: var(--lu-ink-2); font-size: var(--lu-type-label); }
    .pill { width: max-content; }
    .visit-view { display: grid; grid-template-columns: minmax(0, 1.45fr) minmax(280px, .8fr); align-items: start; gap: var(--lu-space-5); max-width: 1440px; margin: 0 auto; }
    .visit-hero { position: relative; min-width: 0; overflow: hidden; padding: var(--lu-space-2); }
    kestrel-lazy-image.visit-image { display: block; width: 100%; aspect-ratio: 16 / 10; border-radius: var(--lu-radius-tile); }
    .visit-video { display: block; width: 100%; max-height: 68vh; aspect-ratio: 16 / 10; border-radius: var(--lu-radius-tile); background: var(--lu-tile); object-fit: contain; }
    .clip-progress { display: grid; gap: var(--lu-space-2); padding: var(--lu-space-4) var(--lu-space-2) var(--lu-space-2); }
    .progress-label { display: flex; justify-content: space-between; gap: var(--lu-space-3); color: var(--lu-ink-2); font-size: var(--lu-type-label); }
    .progress-track, .meter { height: 6px; overflow: hidden; border-radius: var(--lu-radius-pill); background: var(--lu-track-off); }
    .progress-track span, .meter span { display: block; height: 100%; border-radius: inherit; background: var(--lu-accent); transition: width var(--lu-motion-label) var(--lu-ease); }
    .media-note { padding: var(--lu-space-3); color: var(--lu-ink-2); font-size: var(--lu-type-label); }
    .visit-summary { display: grid; gap: var(--lu-space-4); min-width: 0; }
    .visit-title-row { display: flex; justify-content: space-between; align-items: flex-start; gap: var(--lu-space-4); }
    .visit-title-row h1 { max-width: 18ch; }
    .visit-title-row p { margin-top: var(--lu-space-2); font-size: var(--lu-type-label); }
    .score { color: var(--lu-ink); font-size: var(--lu-type-display); font-weight: 350; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .score small { color: var(--lu-ink-3); font-size: var(--lu-type-label); }
    .visit-tags { display: flex; flex-wrap: wrap; gap: var(--lu-space-2); }
    .new-tag { color: var(--lu-accent); }
    .visit-actions { display: flex; flex-wrap: wrap; gap: var(--lu-space-2); margin-top: var(--lu-space-1); }
    .heard-panel { display: grid; grid-template-columns: 1fr minmax(0, 210px); align-items: center; gap: var(--lu-space-3); padding: var(--lu-space-4); }
    .heard-copy { display: flex; flex-direction: column; gap: var(--lu-space-1); }
    .heard-copy strong { font-size: var(--lu-type-label); }
    .heard-copy span { font-size: var(--lu-type-caption); }
    .heard-panel .text-button { grid-column: 1 / -1; justify-self: start; }
    .species-search { width: 100%; min-height: var(--lu-target); margin-bottom: var(--lu-space-3); padding: 0 var(--lu-space-4); border: 1px solid var(--lu-edge); border-radius: var(--lu-radius-control); color: var(--lu-ink); background: var(--lu-tile); }
    .choice-list { max-height: 36vh; overflow-y: auto; }
    .choice-row, .visit-row { display: flex; width: 100%; min-height: var(--lu-target); align-items: center; justify-content: space-between; gap: var(--lu-space-3); padding: var(--lu-space-2) var(--lu-space-3); border: 0; border-bottom: 1px solid var(--lu-edge); border-radius: var(--lu-radius-row); color: var(--lu-ink); background: transparent; text-align: left; cursor: pointer; }
    .choice-row:is(:active, [data-pressed]), .visit-row:is(:active, [data-pressed]) { background: var(--lu-material-press-wash); }
    @media (hover: hover) and (pointer: fine) { .choice-row:hover, .visit-row:hover { background: var(--lu-glass-raised); } }
    .choice-row ha-icon, .visit-row ha-icon { color: var(--lu-ink-3); }
    .choice-copy { display: flex; min-width: 0; flex-direction: column; gap: 2px; overflow-wrap: anywhere; }
    .no-match { padding: var(--lu-space-4); }
    .special-choices { display: flex; flex-wrap: wrap; gap: var(--lu-space-2); margin-top: var(--lu-space-4); }
    .wildlife-view, .insights-view { display: grid; gap: var(--lu-space-5); max-width: 1440px; margin: 0 auto; }
    .species-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, calc(var(--lu-target) * 3.75)), 1fr)); gap: var(--lu-gutter); }
    .summary { display: flex; flex-wrap: wrap; align-items: center; gap: var(--lu-space-1) var(--lu-space-2); font-variant-numeric: tabular-nums; }
    .summary span { display: inline-flex; align-items: center; gap: var(--lu-space-1); }
    .summary ha-icon { --mdc-icon-size: 16px; width: 16px; height: 16px; }
    .wildlife-view .section-heading { margin-bottom: 0; }
    .species-tile { display: grid; align-content: start; min-width: 0; gap: var(--lu-space-2); padding: 0 0 var(--lu-space-3); border: 0; border-radius: var(--lu-radius-card); color: var(--lu-ink); background: transparent; text-align: left; cursor: pointer; transition: background-color var(--lu-motion-label) var(--lu-ease); }
    .species-tile:is(:active, [data-pressed]) { background: var(--lu-material-press-wash); transition: none; }
    .species-tile:is(:active, [data-pressed]) .species-photo::after { content: ""; position: absolute; inset: 0; border-radius: var(--lu-radius-tile); background: var(--lu-material-press-wash); pointer-events: none; }
    @media (hover: hover) and (pointer: fine) { .species-tile:hover { background: var(--lu-material-hover-wash); } }
    .species-tile kestrel-lazy-image { display: block; width: 100%; }
    .species-photo { position: relative; }
    .heard-hero { display: grid; width: 100%; height: 100%; place-items: center; }
    .heard-hero ha-icon { --mdc-icon-size: 40px; width: 40px; height: 40px; color: var(--lu-ink-3); }
    .species-name { padding: var(--lu-space-1) var(--lu-space-2) 0; overflow-wrap: anywhere; font-size: var(--lu-type-label); font-weight: 600; }
    .species-last { display: flex; align-items: flex-start; gap: var(--lu-space-1); padding: 0 var(--lu-space-2); color: var(--lu-ink-2); font-size: var(--lu-type-caption); line-height: 1.35; }
    .species-last ha-icon { --mdc-icon-size: 14px; width: 14px; height: 14px; flex: none; margin-top: 1px; }
    .species-tile .new-tag { padding: 0 var(--lu-space-2); font-size: var(--lu-type-caption); }
    .show-more { margin: var(--lu-space-2) auto 0; }
    .camera-bone { aspect-ratio: 16 / 9; border-radius: 0; }
    .camera-tile .line { height: 14px; margin: var(--lu-space-3) var(--lu-space-4) 0; border-radius: var(--lu-radius-pill); }
    .species-tile .line, .camera-tile .line.short { height: 14px; border-radius: var(--lu-radius-pill); }
    .species-tile .line { margin: 0 var(--lu-space-2); }
    .line.short { width: 55%; }
    .camera-tile .line.short { margin: var(--lu-space-2) var(--lu-space-4) var(--lu-space-4); }
    .species-bone { aspect-ratio: 1; }
    .state-actions { display: flex; flex-wrap: wrap; justify-content: center; gap: var(--lu-space-2); margin-top: var(--lu-space-2); }
    .visit-bone { aspect-ratio: 16 / 10; }
    .visit-summary .line { height: 20px; border-radius: var(--lu-radius-pill); }
    .segmented-bone { height: var(--lu-target); max-width: 480px; border-radius: var(--lu-radius-control); }
    .health-bone { height: 120px; border-radius: var(--lu-radius-tile); }
    .species-tile.skeleton { pointer-events: none; }
    .shortcut-list { display: grid; margin: 0; padding: 0; list-style: none; }
    .shortcut-list li { display: flex; align-items: center; gap: var(--lu-space-4); min-height: var(--lu-row); border-bottom: 1px solid var(--lu-edge); font-size: var(--lu-type-body); }
    .shortcut-list li:last-child { border-bottom: 0; }
    kbd { display: inline-grid; min-width: 32px; height: 32px; place-items: center; padding: 0 var(--lu-space-2); border: 1px solid var(--lu-edge-raised); border-radius: var(--lu-radius-control); background: var(--lu-glass-raised); box-shadow: var(--lu-highlight-raised); font: 600 var(--lu-type-label) var(--lu-font); }
    .simple-list, .visit-list { display: grid; margin: 0; padding: 0; list-style: none; }
    .simple-list li { display: flex; min-height: var(--lu-target); align-items: center; justify-content: space-between; gap: var(--lu-space-3); border-bottom: 1px solid var(--lu-edge); color: var(--lu-ink-2); font-size: var(--lu-type-label); }
    .simple-list li:last-child, .visit-list li:last-child .visit-row { border-bottom: 0; }
    .simple-list strong { color: var(--lu-ink); font-variant-numeric: tabular-nums; }
    .visit-row { justify-content: flex-start; }
    .visit-row > span { display: flex; min-width: 0; flex: 1; flex-direction: column; gap: 3px; }
    .visit-row strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 550; }
    .visit-row small { color: var(--lu-ink-2); font-size: var(--lu-type-caption); }
    .review-section, .noisy-section { padding: var(--lu-space-5); }
    .empty-inline { padding: var(--lu-space-3) 0; color: var(--lu-ink-2); font-size: var(--lu-type-label); }
    .review-thumb { width: 56px; height: 56px; flex: none; }
    .review-copy { min-width: 0; }
    .review-meta { display: inline-flex; align-items: center; gap: var(--lu-space-1); }
    .review-meta ha-icon { --mdc-icon-size: 14px; width: 14px; height: 14px; flex: none; }
    .health-grid { display: grid; grid-template-columns: repeat(3, minmax(0,1fr)); gap: var(--lu-space-3); }
    .health-tile { display: flex; min-width: 0; flex-direction: column; gap: var(--lu-space-2); padding: var(--lu-space-4); }
    .health-title { display: flex; align-items: center; gap: var(--lu-space-2); color: var(--lu-ink-2); font-size: var(--lu-type-caption); }
    .health-title ha-icon { --mdc-icon-size: 18px; width: 18px; height: 18px; color: var(--lu-accent); }
    .health-tile strong { overflow-wrap: anywhere; font-size: var(--lu-type-title); font-weight: 600; font-variant-numeric: tabular-nums; }
    .health-tile p, .health-tile small { color: var(--lu-ink-2); font-size: var(--lu-type-caption); line-height: 1.4; }
    .health-tile small { margin-top: auto; }
    .health-tile .meter { width: 100%; margin: var(--lu-space-1) 0; }
    .health-tile .healthy { color: var(--lu-positive); }
    .health-tile .unhealthy { color: var(--lu-warning); }
    .toast { position: fixed; z-index: 30; right: max(var(--lu-space-4), env(safe-area-inset-right)); bottom: calc(var(--lu-space-4) + env(safe-area-inset-bottom)); left: max(var(--lu-space-4), env(safe-area-inset-left)); display: flex; width: max-content; max-width: min(560px, calc(100vw - 32px)); min-height: 56px; align-items: center; justify-content: space-between; gap: var(--lu-space-3); margin: 0 auto; padding: var(--lu-space-2) var(--lu-space-3); border: 1px solid var(--lu-edge); border-radius: var(--lu-radius-pill); color: var(--lu-ink); background: var(--lu-sheet); box-shadow: var(--lu-highlight-rest), var(--lu-shadow-rest); }
    .toast-action:is(:active, [data-pressed]) { background: var(--lu-material-press-wash); }
    .toast-action { min-width: var(--lu-target); min-height: var(--lu-target); border: 0; border-radius: var(--lu-radius-pill); color: var(--lu-accent); background: transparent; font-weight: 600; cursor: pointer; }
    .toast-close { width: var(--lu-target); height: var(--lu-target); }
    @container (max-width: 680px) {
      ha-card { min-height: calc(100vh - var(--header-height, 56px)); }
      main { padding: var(--lu-space-4) var(--lu-space-3) calc(84px + env(safe-area-inset-bottom)); }
      .topbar { min-height: 60px; padding: var(--lu-space-2) var(--lu-space-3); }
      .navigation { position: fixed; z-index: 15; right: 0; bottom: 0; left: 0; display: grid; height: calc(64px + env(safe-area-inset-bottom)); grid-template-columns: repeat(3, minmax(0,1fr)); gap: var(--lu-space-1); padding: var(--lu-space-1) var(--lu-space-2) calc(var(--lu-space-1) + env(safe-area-inset-bottom)); border-top: 1px solid var(--lu-edge); background: var(--primary-background-color); }
      @supports (backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px)) {
        .navigation { background: color-mix(in srgb, var(--lu-sheet) 82%, transparent); backdrop-filter: blur(24px) saturate(1.4); -webkit-backdrop-filter: blur(24px) saturate(1.4); }
      }
      .nav-item { min-width: 0; min-height: 48px; flex-direction: column; gap: 2px; padding: var(--lu-space-1); font-size: var(--lu-type-caption); }
      .nav-item span { overflow: hidden; max-width: 100%; text-overflow: ellipsis; white-space: nowrap; }
      .open-scrypted { min-height: 48px; padding: 0 var(--lu-space-2); font-size: var(--lu-type-caption); }
      .visit-view { grid-template-columns: 1fr; gap: var(--lu-space-4); }
      .health-grid { grid-template-columns: repeat(2, minmax(0,1fr)); }
    }
    @container (max-width: 400px) {
      .species-grid { grid-template-columns: repeat(auto-fill, minmax(min(100%, 140px), 1fr)); }
      .health-grid { grid-template-columns: 1fr; }
      .section-heading { align-items: flex-start; }
      .heard-panel { grid-template-columns: 1fr; }
      .heard-panel .pill { width: 100%; }
      .open-scrypted { max-width: 104px; overflow: hidden; white-space: nowrap; }
      .focused-camera .section-heading { flex-wrap: wrap; }
      .toast { width: calc(100% - 32px); }
    }
    :host([data-lu-short]) .app { display: grid; grid-template-columns: calc(var(--lu-target) * 1.5 + var(--lu-space-2)) minmax(0, 1fr); grid-template-rows: auto 1fr; align-content: start; }
    :host([data-lu-short]) .topbar { grid-column: 2; grid-row: 1; min-height: 48px; padding-block: var(--lu-space-1); }
    :host([data-lu-short]) .brand { width: 28px; height: 28px; }
    :host([data-lu-short]) .title-stack span { display: none; }
    :host([data-lu-short]) .navigation { position: static; grid-column: 1; grid-row: 1 / span 2; display: flex; flex-direction: column; justify-content: flex-start; height: auto; padding: var(--lu-space-2) var(--lu-space-1); border-top: 0; border-right: 1px solid var(--lu-edge); background: transparent; backdrop-filter: none; -webkit-backdrop-filter: none; }
    :host([data-lu-short]) .nav-item { width: 100%; min-height: calc(var(--lu-target) + var(--lu-space-3)); flex-direction: column; gap: 2px; padding: var(--lu-space-1); border-radius: var(--lu-radius-control); font-size: var(--lu-type-caption); line-height: 1.2; text-align: center; }
    :host([data-lu-short]) .wildlife-view { grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: var(--lu-space-3) var(--lu-space-4); }
    :host([data-lu-short]) .wildlife-view > :not(.section-heading):not(kestrel-lu-segmented) { grid-column: 1 / -1; }
    :host([data-lu-short]) main { grid-column: 2; grid-row: 2; padding-bottom: var(--lu-edge-y); }
    :host([data-lu-short]) .toast { bottom: var(--lu-space-3); }
    :host([data-lu-short]) kestrel-lu-segmented { min-width: calc(var(--lu-target) * 7); }
    :host([data-lu-short][data-lu-profile="phone"]) .species-grid { grid-template-columns: repeat(auto-fill, minmax(min(100%, 150px), 1fr)); }
    /* A short screen gives the picture the whole height and puts the name, status and sightings beside it. */
    :host([data-lu-short]) .focused-camera { grid-template-columns: minmax(0, 1fr) minmax(11rem, 16rem); grid-template-rows: auto 1fr; align-items: start; column-gap: var(--lu-space-4); }
    :host([data-lu-short]) .focused-camera > .section-heading { grid-column: 2; grid-row: 1; flex-direction: column; align-items: flex-start; gap: var(--lu-space-2); }
    :host([data-lu-short]) .focused-camera > kestrel-live-player, :host([data-lu-short]) .focused-camera > .focused-snapshot, :host([data-lu-short]) .focused-camera > .unsupported-stream { grid-column: 1; grid-row: 1 / span 2; max-height: calc(100dvh - 48px - var(--lu-edge-y) * 2); }
    :host([data-lu-short]) .camera-meta { grid-column: 2; grid-row: 2; flex-direction: column; align-items: flex-start; }
    :host([data-lu-short]) .focused-snapshot .snapshot-image { min-height: 0; max-height: calc(100dvh - 48px - var(--lu-edge-y) * 2); }
    @media (prefers-reduced-motion: reduce) {
      .progress-track span, .meter span { transition: none; }
    }
  `];

  render() {
    const view = this._view === "visit" ? this._renderVisit() : nothing;
    const shell = html`<div class="app" aria-busy=${this._loading ? "true" : "false"}>
      ${this._renderHeader()}${this._renderNav()}<main>
        ${this._renderLoadError()}${this._renderCached("live")}${this._renderCached("wildlife")}${this._renderCached("insights")}${view}
      </main>${this._renderSpeciesSheet()}${this._renderToast()}${this._helpOpen ? this._renderHelp() : nothing}
    </div>`;
    return this.localName === "kestrel-panel" ? shell : html`<ha-card>${shell}</ha-card>`;
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
