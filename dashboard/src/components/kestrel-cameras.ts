import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import KestrelMark from "../../../assets/kestrel-icon-128.png";
import { api, asArray, asVisit, cameraSnapshotUrl, extractLabels, navigate, routeView, speciesArray, speciesFromDetail, speciesPhoto, speciesReferencePhoto, visitAudio, visitClip, visitPage, visitSnapshot, visitIdFromLocation } from "../api.ts";
import { ago, clamp, clockTime, dateTime, formatMiB, pluralize, timestamp } from "../format.ts";
import { COMMON_CSS, TOKENS_CSS } from "../styles/tokens.ts";
import type { Camera, Health, HomeAssistant, KestrelCardConfig, KestrelPush, Settings, Species, SpeciesDetail, Visit, VisitSuggestion } from "../types.ts";
import "./kestrel-lazy-image.ts";
import "./kestrel-lazy-audio.ts";

type ToastState = { message: string; actionLabel?: string; action?: () => void; duration?: number };
type PendingUndo = { visitId: string; before?: Visit | null };
const NAV = [
  { view: "live", label: "Live", icon: "mdi:cctv" },
  { view: "wildlife", label: "Wildlife", icon: "mdi:paw" },
  { view: "insights", label: "AI check-up", icon: "mdi:heart-pulse" },
] as const;
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
    _speciesDetail: { state: true },
    _speciesVisits: { state: true },
    _speciesCalls: { state: true },
    _labels: { state: true },
    _pickerOpen: { state: true },
    _search: { state: true },
    _saving: { state: true },
    _toast: { state: true },
    _progress: { state: true },
    _containerWidth: { state: true },
    _speciesVisible: { state: true },
    _visitsNext: { state: true },
    _audioByVisit: { state: true },
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
  declare _speciesDetail: SpeciesDetail | Species | null;
  declare _speciesVisits: Visit[];
  declare _speciesCalls: Visit[];
  declare _labels: string[];
  declare _pickerOpen: boolean;
  declare _search: string;
  declare _saving: boolean;
  declare _toast: ToastState | null;
  declare _progress: number;
  declare _containerWidth: number;
  declare _speciesVisible: number;
  declare _visitsNext: string | null;
  declare _audioByVisit: Map<string, string>;
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
  private _liveObserver?: IntersectionObserver;
  private _resizeObserver?: ResizeObserver;
  private _liveElements = new Map<string, HTMLElement>();
  private _pendingLiveMounts = new Set<string>();
  private _failedReferenceImages = new Set<string>();
  private static _nvrComponentsPromise: Promise<void> | undefined;
  private _pendingUndo: PendingUndo | null = null;
  private _routeKey = "";

  constructor() {
    super();
    this._config = { type: "custom:kestrel-cameras", view: "live" };
    this._view = "live";
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
    this._speciesDetail = null;
    this._speciesVisits = [];
    this._speciesCalls = [];
    this._labels = [];
    this._pickerOpen = false;
    this._search = "";
    this._saving = false;
    this._toast = null;
    this._progress = 0;
    this._containerWidth = 0;
    this._speciesVisible = 24;
    this._visitsNext = null;
    this._audioByVisit = new Map();
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
    for (const player of this._liveElements.values()) (player as HTMLElement & { hass?: HomeAssistant }).hass = value;
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
    document.addEventListener("visibilitychange", this._onVisibilityChanged);
    window.addEventListener("keydown", this._onGlobalKeydown);
    this._syncRoute(false);
    if (typeof ResizeObserver !== "undefined") {
      this._resizeObserver = new ResizeObserver((entries) => {
        const width = entries[0]?.contentRect.width ?? 0;
        if (Math.abs(width - this._containerWidth) > 2) this._containerWidth = width;
      });
      this._resizeObserver.observe(this);
    }
    this._ensureConnection();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this._generation++;
    window.removeEventListener("location-changed", this._onLocationChanged);
    window.removeEventListener("popstate", this._onLocationChanged);
    document.removeEventListener("visibilitychange", this._onVisibilityChanged);
    window.removeEventListener("keydown", this._onGlobalKeydown);
    this._resizeObserver?.disconnect();
    this._resizeObserver = undefined;
    this._stopLivePlayers();
    this._clearClipTimer();
    window.clearTimeout(this._toastTimer);
    this._toastTimer = undefined;
    void this._stopSubscription();
  }

  protected shouldUpdate(changed: PropertyValues<this>): boolean {
    return [...changed.keys()].some((key) => key !== "hass");
  }

  protected updated(changed: PropertyValues<this>): void {
    if (changed.has("_view") || changed.has("_containerWidth") || changed.has("_cameras") || changed.has("_selectedCamera")) {
      this._syncLivePlayers();
    }
    if (changed.has("_view") && this._view !== "visit") this._clearClipTimer();
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

  private _syncRoute(load = true): void {
    const view = routeView(this._config) ?? "live";
    const visitId = visitIdFromLocation();
    const key = `${view}:${visitId ?? ""}`;
    if (key === this._routeKey) return;
    this._routeKey = key;
    const oldView = this._view;
    const oldVisitId = this._visitId;
    this._view = view;
    this._visitId = visitId;
    if (view !== oldView) {
      this._selectedCamera = null;
      this._selectedSpecies = null;
      this._speciesDetail = null;
      this._pickerOpen = false;
      this._audioUrl = null;
      this._visitReferencePhoto = null;
      this._visitReferencePhotoFailed = false;
    }
    if (visitId !== oldVisitId) {
      this._visit = null;
      this._heardConfirmed = false;
      this._audioUrl = null;
      this._visitReferencePhoto = null;
      this._visitReferencePhotoFailed = false;
    }
    if (load && (view !== oldView || visitId !== oldVisitId)) void this._loadForView();
  }

  private _onLocationChanged = (): void => { this._syncRoute(); };

  private _onVisibilityChanged = (): void => {
    if (document.visibilityState === "hidden") this._unmountAllLivePlayers();
    else this._syncLivePlayers();
  };

  private _onGlobalKeydown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    if (this._pickerOpen) this._closeWrongPicker();
    else if (this._selectedSpecies) this._closeSpecies();
  };

  private _onPush(message: KestrelPush): void {
    const event = message?.event;
    if (!event) return;
    if (event.type === "camera") {
      if (this._view === "live") void this._loadCameras();
      if (this._view === "insights") void this._loadHealth();
      return;
    }
    if (event.type === "visit_new" || event.type === "visit_updated") {
      if (this._view === "visit" && this._visitId) {
        const data = event.data as Record<string, unknown> | null;
        const eventId = data && (data.id ?? data.visit_id);
        if (!eventId || String(eventId) === this._visitId) void this._loadVisit(this._visitId);
      } else if (this._view === "wildlife") {
        void this._loadSpecies();
      } else if (this._view === "insights") {
        void this._loadReview();
      }
    }
  }

  private _setError(message: string): void {
    this._error = message;
    this.requestUpdate();
  }

  private async _loadForView(): Promise<void> {
    if (!this._hass || !this.isConnected) return;
    this._error = "";
    this._loading = true;
    const generation = this._generation;
    const view = this._view;
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
    if (this._isActive(generation)) this._cameras = asArray<Camera>(cameras).slice(0, 32);
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
    if (!this._hass) return;
    if (!this._visit) this._loading = true;
    const response = await api.visit(this._hass, id);
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
    if (speciesResult.status === "fulfilled") this._species = speciesArray(speciesResult.value).slice(0, 500);
    if (settingsResult.status === "fulfilled") this._settings = settingsResult.value;
    if (camerasResult.status === "fulfilled") this._cameras = asArray<Camera>(camerasResult.value).slice(0, 32);
    if (speciesResult.status === "rejected") throw speciesResult.reason;
    this._speciesVisible = Math.min(24, Math.max(this._speciesVisible, 24));
  }

  private async _loadSpecies(): Promise<void> {
    if (!this._hass || this._species.length) return;
    try { this._species = speciesArray(await api.species(this._hass)).slice(0, 500); }
    catch { /* keep the last good species list */ }
  }

  private async _loadInsights(generation = this._generation): Promise<void> {
    if (!this._hass) return;
    const results = await Promise.allSettled([api.health(this._hass), api.review(this._hass), api.cameras(this._hass)]);
    if (!this._isActive(generation)) return;
    const [health, review, cameras] = results;
    if (health.status === "fulfilled") this._health = health.value;
    if (review.status === "fulfilled") this._review = visitPage(review.value).items.slice(0, 24);
    if (cameras.status === "fulfilled") this._cameras = asArray<Camera>(cameras.value).slice(0, 32);
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

  private async _loadMoreSpeciesVisits(): Promise<void> {
    const species = this._selectedSpecies;
    if (!this._hass || !species || !this._visitsNext) return;
    const generation = this._generation;
    try {
      const page = visitPage(await api.visits(this._hass, { species, before: this._visitsNext, limit: 24 }));
      if (!this._isActive(generation) || this._selectedSpecies !== species) return;
      this._speciesVisits = [...this._speciesVisits, ...page.items].slice(0, 48);
      this._visitsNext = page.next ?? null;
    } catch { this._setToast({ message: "More visits couldn't be loaded.", duration: 4500 }); }
  }

  private async _openSpecies(name: string): Promise<void> {
    this._selectedSpecies = name;
    this._speciesDetail = null;
    this._speciesVisits = [];
    this._speciesCalls = [];
    this._visitsNext = null;
    if (!this._hass) return;
    const generation = this._generation;
    const [detail, visits, calls] = await Promise.allSettled([
      api.speciesDetail(this._hass, name),
      api.visits(this._hass, { species: name, limit: 24 }),
      api.visits(this._hass, { species: name, kind: "heard", limit: 8 }),
    ]);
    if (!this._isActive(generation) || this._selectedSpecies !== name) return;
    if (detail.status === "fulfilled") this._speciesDetail = detail.value;
    if (visits.status === "fulfilled") {
      const page = visitPage(visits.value);
      this._speciesVisits = page.items.slice(0, 24);
      this._visitsNext = page.next ?? null;
    }
    if (calls.status === "fulfilled") this._speciesCalls = visitPage(calls.value).items.filter((visit) => visit.kind === "heard").slice(0, 8);
  }

  private _closeSpecies(): void { this._selectedSpecies = null; this._speciesDetail = null; }

  private _openWrongPicker(): void {
    this._pickerOpen = true;
    this._search = "";
    void this._loadLabels();
    void this._loadSpecies();
  }

  private _closeWrongPicker(): void { this._pickerOpen = false; this._search = ""; }

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
        const next = new Map(this._audioByVisit);
        next.set(visitId, source);
        while (next.size > 8) next.delete(next.keys().next().value as string);
        this._audioByVisit = next;
        if (this._visit?.heard?.visitId === visitId) this._audioUrl = source;
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

  private _maxLive(): number { return this._containerWidth === 0 || this._containerWidth <= 680 ? 4 : 9; }

  private _syncLivePlayers(): void {
    if (this._view !== "live" || document.visibilityState === "hidden") {
      this._stopLivePlayers();
      return;
    }
    const slots = [...this.renderRoot.querySelectorAll<HTMLElement>(".stream-slot[data-camera-id]")];
    const slotIds = new Set(slots.map((slot) => slot.dataset.cameraId ?? ""));
    for (const id of [...this._liveElements.keys()]) if (!slotIds.has(id)) this._unmountLivePlayer(id);
    this._liveObserver?.disconnect();
    this._liveObserver = undefined;
    if (typeof IntersectionObserver === "undefined") {
      for (const slot of slots) this._mountLivePlayer(slot);
      return;
    }
    this._liveObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const slot = entry.target as HTMLElement;
        if (entry.isIntersecting && document.visibilityState !== "hidden") this._mountLivePlayer(slot);
        else this._unmountLivePlayer(slot.dataset.cameraId ?? "");
      }
    }, { rootMargin: "120px" });
    for (const slot of slots) this._liveObserver.observe(slot);
  }

  private _mountLivePlayer(slot: HTMLElement): void {
    const cameraId = slot.dataset.cameraId;
    if (!cameraId || this._liveElements.has(cameraId) || this._pendingLiveMounts.has(cameraId)) return;
    const camera = this._cameras.find((item) => String(item.id) === cameraId);
    if (!camera?.nvrCardId || !camera.online) return;
    const live = slot.dataset.live === "true";
    this._pendingLiveMounts.add(cameraId);
    // Scrypted's card only starts its video/snapshot pipeline when setConfig + hass are both
    // present before it connects to the DOM; configuring an already-connected instance leaves
    // it permanently blank, so build and configure it off-DOM first, then insert it.
    void customElements.whenDefined("scrypted-nvr-camera").then(() => {
      this._pendingLiveMounts.delete(cameraId);
      if (this._liveElements.has(cameraId) || !this.isConnected) return;
      const target = this.renderRoot.querySelector<HTMLElement>(`.stream-slot[data-camera-id="${cameraId}"]`);
      if (!target) return;
      const player = document.createElement("scrypted-nvr-camera") as HTMLElement & { hass?: HomeAssistant; setConfig?: (config: Record<string, unknown>) => void };
      player.setConfig?.({ type: "custom:scrypted-nvr-camera", id: String(camera.nvrCardId), destination: "low-resolution", live, imageClick: "none", videoClick: "none" });
      player.hass = this.hass;
      player.setAttribute("aria-label", `${camera.name} ${live ? "live view" : "snapshot"}`);
      player.style.display = "block";
      player.style.width = "100%";
      player.style.height = "100%";
      target.replaceChildren(player);
      this._liveElements.set(cameraId, player);
    });
  }

  private _unmountLivePlayer(cameraId: string): void {
    const player = this._liveElements.get(cameraId);
    if (player) player.remove();
    this._liveElements.delete(cameraId);
  }

  private _unmountAllLivePlayers(): void {
    this._liveObserver?.disconnect();
    this._liveObserver = undefined;
    for (const id of [...this._liveElements.keys()]) this._unmountLivePlayer(id);
  }

  private _stopLivePlayers(): void { this._unmountAllLivePlayers(); }

  private _goTo(view: "live" | "wildlife" | "insights"): void { navigate(view); }
  private _openVisit(id: string): void { navigate("visit", `?v=${encodeURIComponent(id)}`); }
  private _returnLive(): void { this._selectedCamera = null; this._goTo("live"); }

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

  private _cameraSighting(camera: Camera): string | null {
    const detection = camera.lastDetection;
    if (!detection) return null;
    const species = typeof detection.species === "string" ? detection.species : typeof detection.label === "string" ? detection.label : null;
    return species;
  }

  private _renderHeader() {
    const title = this._view === "live" ? "Live cameras" : this._view === "wildlife" ? "Wildlife" : this._view === "insights" ? "AI check-up" : "Visit";
    return html`<header class="topbar">
      ${this._view === "visit" ? html`<button class="back-button" type="button" aria-label="Back to live cameras" @click=${this._returnLive}><ha-icon .icon=${"mdi:arrow-left"}></ha-icon></button>` : this.narrow ? html`<button class="icon-button menu-button" type="button" aria-label="Show sidebar" @click=${this._onMenu}><ha-icon .icon=${"mdi:menu"}></ha-icon></button>` : nothing}
      <img class="brand" src=${KestrelMark} alt="Kestrel mark" width="32" height="32">
      <div class="title-stack"><strong>Kestrel</strong><span>${title}</span></div>
      ${this._view === "live" ? html`<a class="open-scrypted" href=${SCRYPTED_URL} target="_blank" rel="noopener noreferrer">Open in Scrypted</a>` : nothing}
    </header>`;
  }

  private _renderNav() {
    if (this._view === "visit") return nothing;
    return html`<nav class="navigation" aria-label="Camera sections">
      ${NAV.map((item) => html`<button type="button" class="nav-item ${this._view === item.view ? "selected" : ""}" aria-current=${this._view === item.view ? "page" : nothing} @click=${() => this._goTo(item.view)}>
        <ha-icon .icon=${item.icon} aria-hidden="true"></ha-icon><span>${item.label}</span>
      </button>`)}
    </nav>`;
  }

  private _renderLoadError() {
    if (!this._error) return nothing;
    return html`<section class="error-state" role="alert"><ha-icon .icon=${"mdi:cloud-alert"}></ha-icon><div><strong>Couldn't load this view</strong><p>${this._error}</p><button type="button" class="pill secondary" @click=${() => this._loadForView()}>Try again</button></div></section>`;
  }

  private _renderLive() {
    if (this._loading && !this._cameras.length) return html`<section class="empty-state"><div class="loader" aria-hidden="true"></div><p>Connecting to your cameras…</p></section>`;
    if (!this._cameras.length) return html`<section class="empty-state"><ha-icon .icon=${"mdi:cctv-off"}></ha-icon><h2>No cameras are available</h2><p>Kestrel hasn't received a camera list yet.</p><button class="pill secondary" @click=${() => this._loadCameras()}>Refresh</button></section>`;
    const selected = this._selectedCamera ? this._cameras.find((camera) => String(camera.id) === this._selectedCamera) : null;
    if (selected) {
      return html`<section class="focused-camera">
        <div class="section-heading"><button class="back-inline" type="button" @click=${() => { this._selectedCamera = null; }}>All cameras</button><h1>${selected.name}</h1><span class="status-chip"><i class="status-dot ${this._statusKind(selected.health)}"></i>${this._healthLabel(selected)}</span></div>
        ${selected.nvrCardId === null ? html`<div class="focused-snapshot"><kestrel-lazy-image class="snapshot-image" .src=${cameraSnapshotUrl(selected.id) ?? ""} alt=${`${selected.name} latest snapshot`} wide></kestrel-lazy-image><span class="snapshot-chip">Snapshot only</span></div>` : selected.online ? html`<div class="stream-slot focused-stream" data-camera-id=${String(selected.id)} data-live="true" aria-label=${`${selected.name} live view`}><span class="stream-placeholder">Connecting to live view…</span></div>` : html`<div class="unsupported-stream"><ha-icon .icon=${"mdi:cctv-off"}></ha-icon><strong>Camera is offline</strong><span>The last camera health state is offline.</span><a href=${SCRYPTED_URL} target="_blank" rel="noopener noreferrer">Open in Scrypted</a></div>`}
        <div class="camera-meta"><span>${selected.drops1h ?? 0} stream drops in the last hour</span>${this._cameraSighting(selected) ? html`<span class="sighting"><ha-icon .icon=${"mdi:paw"}></ha-icon>${this._cameraSighting(selected)}</span>` : html`<span class="muted">No current AI sighting</span>`}</div>
      </section>`;
    }
    const liveIds = new Set(this._cameras.filter((camera) => camera.nvrCardId !== null && camera.online).map((camera) => String(camera.id)).slice(0, this._maxLive()));
    return html`<section class="live-view">
      <div class="section-heading"><div><h1>Your cameras</h1><p class="muted">Tap a view to make it the main picture.</p></div><span class="camera-count">${this._cameras.length} cameras</span></div>
      <div class="camera-grid">${this._cameras.slice(0, 32).map((camera) => html`
        <button class="camera-tile" type="button" aria-label=${`Focus ${camera.name}`} @click=${() => { this._selectedCamera = String(camera.id); }}>
          <div class="camera-picture">
            ${camera.nvrCardId === null
              ? html`<kestrel-lazy-image class="camera-snapshot" .src=${cameraSnapshotUrl(camera.id) ?? ""} alt=${`${camera.name} latest snapshot`}></kestrel-lazy-image><span class="snapshot-chip">Snapshot only</span>`
              : camera.online
                ? html`<div class="stream-slot" data-camera-id=${String(camera.id)} data-live=${liveIds.has(String(camera.id)) ? "true" : "false"} aria-label=${`${camera.name} ${liveIds.has(String(camera.id)) ? "live view" : "snapshot"}`}><span class="stream-placeholder">Connecting…</span></div>`
                : html`<div class="stream-placeholder static"><ha-icon .icon=${"mdi:cctv-off"}></ha-icon><span>Camera offline</span></div>`}
            <span class="camera-health"><i class="status-dot ${this._statusKind(camera.health)}"></i>${this._healthLabel(camera)}</span>
          </div>
          <div class="camera-label"><strong>${camera.name}</strong>${this._cameraSighting(camera) ? html`<span class="sighting"><ha-icon .icon=${"mdi:paw"}></ha-icon>${this._cameraSighting(camera)}</span>` : html`<span class="muted">${camera.wildlife ? "Wildlife enabled" : "Camera"}</span>`}</div>
        </button>`)}
      </div>
      ${this._cameras.every((camera) => camera.nvrCardId === null) ? html`<p class="muted all-unsupported">Live streams aren't enabled for these cameras. Open Scrypted to view them.</p>` : nothing}
    </section>`;
  }

  private _renderVisit() {
    const visit = this._visit;
    if (!this._visitId) return html`<section class="empty-state"><ha-icon .icon=${"mdi:timeline-alert"}></ha-icon><h2>No visit selected</h2><p>Open a wildlife visit from Live or Wildlife to see its snapshot and clip.</p><button class="pill secondary" @click=${() => this._goTo("live")}>Back to cameras</button></section>`;
    if (!visit && this._loading) return html`<section class="empty-state"><div class="loader" aria-hidden="true"></div><p>Loading this visit…</p></section>`;
    if (!visit) return html`<section class="empty-state"><ha-icon .icon=${"mdi:timeline-alert"}></ha-icon><h2>Visit not found</h2><p>This visit may have expired or its id is no longer available.</p><button class="pill secondary" @click=${() => this._loadForView()}>Try again</button></section>`;
    const photo = visitSnapshot(visit);
    const clip = visitClip(visit);
    const pending = visit.clip?.state === "pending";
    const confirmed = visit.status === "confirmed";
    const heard = visit.heard ?? null;
    const progress = pending ? this._progress : 0;
    return html`<article class="visit-view">
      <section class="visit-hero sheet">
        ${visit.clip?.state === "ready" && clip
          ? html`<video class="visit-video" src=${clip} controls autoplay muted playsinline preload="metadata" aria-label=${`${visit.species} visit clip`}></video>`
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
        <div class="visit-tags"><span class="status-chip"><i class="status-dot ${visit.kind === "heard" ? "info" : "ok"}"></i>${visit.kind === "heard" ? "Heard" : visit.grp === "bird" ? "Bird" : visit.grp === "mammal" ? "Mammal" : "Wildlife"}</span><span class="status-chip">${this._statusLabel(visit.status)}</span>${visit.firstEver ? html`<span class="status-chip new-tag">First visit</span>` : nothing}</div>
        <div class="visit-actions"><button class="pill primary" type="button" ?disabled=${confirmed || this._saving} @click=${() => this._confirmVisit()}>${confirmed ? "✓ Confirmed" : "✓ That's right"}</button><button class="pill secondary" type="button" ?disabled=${this._saving} @click=${this._openWrongPicker}>Wrong?</button></div>
        ${visit.kind === "heard" ? html`<section class="heard-panel tile"><div class="heard-copy"><strong>Call recording</strong><span class="muted">${visit.species || "Unidentified sound"} detected here</span></div>${this._audioUrl ? html`<kestrel-lazy-audio .src=${this._audioUrl} label=${`Call recording of ${visit.species}`} preload="metadata"></kestrel-lazy-audio>` : html`<span class="muted">No recording is available for this visit.</span>`}</section>` : nothing}
        ${heard ? html`<section class="heard-panel tile"><div class="heard-copy"><strong>Also heard: ${heard.species}</strong><span class="muted">Sound recorded near this visit</span></div><button class="pill secondary" type="button" ?disabled=${this._saving || this._heardConfirmed} @click=${() => this._confirmVisit(visit.id, true)}>${this._heardConfirmed ? "✓ Also heard" : "✓ Also heard"}</button>
          ${this._audioUrl ? html`<kestrel-lazy-audio .src=${this._audioUrl} label=${`Call recording of ${heard.species}`} preload="metadata"></kestrel-lazy-audio>` : html`<button class="text-button" type="button" ?disabled=${!heard.hasAudio || this._audioLoading === heard.visitId} @click=${() => this._loadCallAudio(heard.visitId)}>${this._audioLoading === heard.visitId ? "Loading recording…" : heard.hasAudio ? "Play call" : "No call recording"}</button>`}
        </section>` : nothing}
      </div>
      ${this._pickerOpen ? this._renderCorrectionSheet(visit) : nothing}
    </article>`;
  }

  private _statusLabel(status: Visit["status"]): string {
    const labels: Record<Visit["status"], string> = { auto: "Model guess", learned: "Learned", corrected: "Corrected", confirmed: "Confirmed", not_animal: "Not an animal", unknown: "Not sure" };
    return labels[status] ?? "Visit";
  }

  private _seenHeardLabel(species: Species): { icon: string; label: string } {
    if (species.seen && species.heard) return { icon: "mdi:eye-outline", label: "Seen & heard" };
    if (species.heard) return { icon: "mdi:waveform", label: "Heard" };
    return { icon: "mdi:eye-outline", label: "Seen" };
  }

  private _photoFor(species: Species, detail?: unknown): { url: string | null; isReference: boolean } {
    const own = speciesPhoto(species, detail);
    if (own) return { url: own, isReference: false };
    const reference = speciesReferencePhoto(detail, species);
    return { url: reference, isReference: reference !== null };
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
    return html`<div class="scrim" @click=${this._closeWrongPicker}>
      <section class="correction-sheet sheet" role="dialog" aria-modal="true" aria-labelledby="correction-title" @click=${(event: Event) => event.stopPropagation()}>
        <div class="sheet-handle" aria-hidden="true"></div><div class="sheet-head"><div><h2 id="correction-title">What was it?</h2><p class="muted">Choose a better match or search the species list.</p></div><button class="icon-button" type="button" aria-label="Close" @click=${this._closeWrongPicker}><ha-icon .icon=${"mdi:close"}></ha-icon></button></div>
        <input class="species-search" type="search" placeholder="Search species" .value=${this._search} @input=${(event: Event) => { this._search = (event.currentTarget as HTMLInputElement).value; }}>
        <div class="choice-list" role="listbox" aria-label="Species choices">
          ${candidates.map((row) => html`<button class="choice-row" type="button" role="option" @click=${() => this._correctVisit(row.name)}><span class="choice-copy"><span>${row.name}</span>${row.reason ? html`<small class="caption">${row.reason}</small>` : nothing}</span><ha-icon .icon=${"mdi:chevron-right"}></ha-icon></button>`)}
          ${candidates.length === 0 ? html`<p class="muted no-match">No matching species.</p>` : nothing}
        </div>
        <div class="special-choices"><button class="pill secondary" type="button" @click=${() => this._correctVisit("not_animal")}>Not an animal</button><button class="pill secondary" type="button" @click=${() => this._correctVisit("unknown")}>Can't tell</button></div>
      </section>
    </div>`;
  }

  private _renderWildlife() {
    if (this._loading && !this._species.length) return html`<section class="empty-state"><div class="loader" aria-hidden="true"></div><p>Loading your wildlife list…</p></section>`;
    const visible = this._species.slice(0, this._speciesVisible);
    if (!this._species.length) return html`<section class="empty-state"><ha-icon .icon=${"mdi:paw-outline"}></ha-icon><h2>No wildlife visits yet</h2><p>Identified birds and animals will appear here with their visits and calls.</p></section>`;
    return html`<section class="wildlife-view">
      <div class="section-heading"><div><h1>Wildlife</h1><p class="muted">The species Kestrel has seen or heard.</p></div><span class="camera-count">${this._species.length} species</span></div>
      <div class="species-grid">${visible.map((species) => this._renderSpeciesTile(species))}</div>
      ${this._speciesVisible < this._species.length ? html`<button class="pill secondary show-more" type="button" @click=${() => { this._speciesVisible = Math.min(this._speciesVisible + 24, this._species.length); }}>Show more species</button>` : nothing}
      ${this._selectedSpecies ? this._renderSpeciesSheet() : nothing}
    </section>`;
  }

  private _renderSpeciesTile(species: Species) {
    const detail = this._selectedSpecies === species.species ? this._speciesDetail : null;
    const photo = this._photoFor(species, detail);
    const mark = this._seenHeardLabel(species);
    return html`<button class="species-tile" type="button" @click=${() => this._openSpecies(species.species)} aria-label=${`View ${species.species}`}>
      <div class="species-photo">
        <kestrel-lazy-image .src=${photo.url ?? ""} alt=${species.species} square @kestrel-image-error=${() => this._onReferenceImageError(species.species)}>${species.heard ? html`<div slot="empty" class="heard-hero"><ha-icon .icon=${"mdi:waveform"}></ha-icon></div>` : nothing}</kestrel-lazy-image>
        ${photo.isReference && !this._failedReferenceImages.has(species.species) ? html`<span class="snapshot-chip">Reference photo</span>` : nothing}
      </div>
      <span class="species-name">${species.species}</span>
      <span class="species-marks"><span><ha-icon .icon=${mark.icon}></ha-icon>${mark.label}</span>${species.newThisYear ? html`<span class="new-tag">New this year</span>` : nothing}</span>
      <span class="caption">${pluralize(species.count30d, "visit")} in 30 days</span>
    </button>`;
  }

  private _renderSpeciesSheet() {
    const speciesName = this._selectedSpecies;
    if (!speciesName) return nothing;
    const item = this._species.find((species) => species.species === speciesName);
    if (!item) return nothing;
    const detail = this._speciesDetail ? speciesFromDetail(this._speciesDetail, item) : item;
    const photo = this._photoFor(detail, this._speciesDetail);
    const max = Math.max(1, ...detail.hours.map((hour) => Number(hour) || 0));
    const cameras = Object.entries(detail.cameras ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 8);
    const muted = this._settings?.mutedSpecies.includes(detail.species) ?? false;
    const recent = this._speciesVisits.slice(0, 24);
    return html`<div class="scrim" @click=${this._closeSpecies}><section class="species-sheet sheet" role="dialog" aria-modal="true" aria-labelledby="species-title" @click=${(event: Event) => event.stopPropagation()}>
      <div class="sheet-handle" aria-hidden="true"></div><div class="sheet-head"><div><h2 id="species-title">${detail.species}</h2><p class="muted">${detail.grp === "bird" ? "Bird" : detail.grp === "mammal" ? "Mammal" : "Wildlife"}${detail.first ? ` · First seen ${dateTime(detail.first)}` : ""}</p></div><button class="icon-button" type="button" aria-label="Close" @click=${this._closeSpecies}><ha-icon .icon=${"mdi:close"}></ha-icon></button></div>
      <div class="species-detail-hero"><div class="species-photo"><kestrel-lazy-image .src=${photo.url ?? ""} alt=${detail.species} wide @kestrel-image-error=${() => this._onReferenceImageError(detail.species)}>${detail.heard ? html`<div slot="empty" class="heard-hero"><ha-icon .icon=${"mdi:waveform"}></ha-icon></div>` : nothing}</kestrel-lazy-image>${photo.isReference && !this._failedReferenceImages.has(detail.species) ? html`<span class="snapshot-chip">Reference photo</span>` : nothing}</div><div class="species-count"><strong>${detail.count30d}</strong><span>${detail.count30d === 1 ? "visit" : "visits"} in the last 30 days</span></div></div>
      <section class="detail-section"><h3>When it visits</h3><div class="hours-chart" role="img" aria-label="Visits by hour of day">${Array.from({ length: 24 }, (_, hour) => html`<span class="hour-bar" style=${`--bar-height:${clamp(((Number(detail.hours[hour]) || 0) / max) * 100, 4, 100)}%`} title=${`${hour}:00 — ${detail.hours[hour] ?? 0} visits`}></span>`)}</div><div class="hours-labels"><span>12 am</span><span>6 am</span><span>12 pm</span><span>6 pm</span><span>12 am</span></div></section>
      <section class="detail-section"><h3>Cameras</h3>${cameras.length ? html`<ul class="simple-list">${cameras.map(([id, count]) => html`<li><span>${this._cameraName(id)}</span><strong>${count}</strong></li>`)}</ul>` : html`<p class="muted">No camera breakdown is available yet.</p>`}</section>
      <section class="detail-section"><h3>Recent visits</h3>${recent.length ? html`<ul class="visit-list">${recent.map((visit) => html`<li><button type="button" class="visit-row" @click=${() => this._openVisit(visit.id)}><span><strong>${visit.kind === "heard" ? "Heard" : visit.camera.name}</strong><small>${dateTime(visit.startedAt)}</small></span><ha-icon .icon=${"mdi:chevron-right"}></ha-icon></button></li>`)}</ul>${this._visitsNext ? html`<button class="text-button" type="button" @click=${() => this._loadMoreSpeciesVisits()}>Show more visits</button>` : nothing}` : html`<p class="muted">No recent visits found.</p>`}</section>
      ${detail.heard || this._speciesCalls.length ? html`<section class="detail-section"><h3>Calls</h3>${this._speciesCalls.length ? html`<ul class="call-list">${this._speciesCalls.map((call) => html`<li><span>${this._cameraName(call.camera.id)} · ${ago(call.startedAt)}</span>${this._audioByVisit.has(call.id) ? html`<kestrel-lazy-audio .src=${this._audioByVisit.get(call.id)} label=${`${detail.species} call`}></kestrel-lazy-audio>` : html`<button class="text-button" type="button" ?disabled=${this._audioLoading === call.id} @click=${() => this._loadCallAudio(call.id)}>${this._audioLoading === call.id ? "Loading…" : call.heard?.hasAudio || visitAudio(call) ? "Play call" : "Load call"}</button>`}</li>`)}</ul>` : html`<p class="muted">No call recordings are linked to these visits.</p>`}</section>` : nothing}
      <div class="sheet-footer"><button class="pill secondary" type="button" @click=${() => this._toggleMute(item)}>${muted ? "Unmute notifications" : "Mute notifications"}</button><span class="caption">${muted ? "Muted for wildlife alerts" : "Wildlife alerts are enabled"}</span></div>
    </section></div>`;
  }

  private _renderInsights() {
    if (this._loading && !this._health && !this._review.length) return html`<section class="empty-state"><div class="loader" aria-hidden="true"></div><p>Checking the wildlife system…</p></section>`;
    const health = this._health;
    const noisy = (health?.cameras ?? []).filter((camera) => camera.emptyChecksToday > 0).sort((a, b) => (b.emptyChecksToday / Math.max(1, b.checksToday)) - (a.emptyChecksToday / Math.max(1, a.checksToday))).slice(0, 5);
    const storage = health ? health.storage.dbMB + health.storage.mediaMB : 0;
    const storagePercent = health?.storage.budgetMB ? clamp((storage / health.storage.budgetMB) * 100, 0, 100) : 0;
    const gpuPercent = health?.gpu.totalMiB ? clamp((health.gpu.usedMiB / health.gpu.totalMiB) * 100, 0, 100) : 0;
    return html`<section class="insights-view">
      <div class="section-heading"><div><h1>AI check-up</h1><p class="muted">A quick look at the wildlife system's health.</p></div><button class="icon-button" type="button" aria-label="Refresh check-up" @click=${() => this._loadForView()}><ha-icon .icon=${"mdi:refresh"}></ha-icon></button></div>
      <section class="review-section sheet"><div class="section-heading compact"><div><h2>Needs a look</h2><p class="muted">Visits that may need a correction.</p></div><span class="count-badge">${this._review.length}</span></div>${this._review.length ? html`<ul class="visit-list">${this._review.slice(0, 12).map((visit) => html`<li><button class="visit-row" type="button" @click=${() => this._openVisit(visit.id)}><kestrel-lazy-image class="review-thumb" .src=${visitSnapshot(visit) ?? ""} .alt=${visit.species} square></kestrel-lazy-image><span class="review-copy"><strong>${visit.species || "Unidentified animal"}</strong><small>${visit.camera.name} · ${ago(visit.startedAt)}</small></span><ha-icon .icon=${"mdi:chevron-right"}></ha-icon></button></li>`)}</ul>` : html`<p class="empty-inline">Nothing needs a review right now.</p>`}</section>
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

  static styles = [TOKENS_CSS, COMMON_CSS, css`
    :host { container-type: inline-size; min-height: 100%; }
    ha-card { display: block; min-height: calc(100vh - var(--header-height, 56px)); overflow: hidden; border-radius: var(--lu-radius-card); color: var(--lu-ink); }
    .app { min-height: inherit; display: flex; flex-direction: column; position: relative; }
    .topbar { position: relative; display: flex; align-items: center; gap: var(--lu-space-3); min-height: 68px; padding: var(--lu-space-3) var(--lu-space-5); border-bottom: 1px solid var(--lu-edge); background: var(--lu-card); }
    .brand { width: 32px; height: 32px; object-fit: contain; flex: none; }
    .title-stack { display: flex; flex: 1; min-width: 0; flex-direction: column; gap: 2px; }
    .title-stack strong { color: var(--lu-ink); font-size: var(--lu-type-title); font-weight: 650; letter-spacing: -.015em; }
    .title-stack span { color: var(--lu-ink-2); font-size: var(--lu-type-caption); }
    .open-scrypted { display: inline-flex; align-items: center; min-height: 48px; padding: 0 var(--lu-space-3); border-radius: var(--lu-radius-pill); color: var(--lu-ink-2); font-size: var(--lu-type-label); text-decoration: none; }
    .open-scrypted:hover { background: var(--lu-glass-raised); color: var(--lu-ink); }
    .back-button, .icon-button { display: inline-grid; flex: none; width: var(--lu-target); height: var(--lu-target); place-items: center; border: 0; border-radius: 50%; color: var(--lu-ink-2); background: transparent; cursor: pointer; }
    .back-button:hover, .icon-button:hover { color: var(--lu-ink); background: var(--lu-glass-raised); }
    .navigation { display: flex; align-items: center; gap: var(--lu-space-1); padding: var(--lu-space-3) var(--lu-space-5) 0; }
    .nav-item { display: inline-flex; min-height: var(--lu-target); align-items: center; justify-content: center; gap: var(--lu-space-2); padding: 0 var(--lu-space-5); border: 0; border-radius: var(--lu-radius-pill); color: var(--lu-ink-2); background: transparent; font-size: var(--lu-type-label); font-weight: 500; cursor: pointer; }
    .nav-item.selected { color: var(--lu-accent-ink); background: var(--lu-accent); }
    .nav-item ha-icon { width: 20px; height: 20px; }
    main { flex: 1; min-width: 0; padding: var(--lu-space-5); }
    h1, h2, h3, p { margin: 0; }
    h1 { font-size: clamp(1.45rem, 3cqi, 2rem); font-weight: 620; letter-spacing: -.02em; line-height: 1.18; }
    h2 { font-size: var(--lu-type-title); font-weight: 620; letter-spacing: -.012em; }
    h3 { margin-bottom: var(--lu-space-3); font-size: var(--lu-type-label); font-weight: 600; }
    p { line-height: 1.45; }
    .section-heading { display: flex; align-items: center; justify-content: space-between; gap: var(--lu-space-4); margin-bottom: var(--lu-space-5); }
    .section-heading > div { min-width: 0; }
    .section-heading p { margin-top: var(--lu-space-1); font-size: var(--lu-type-label); }
    .section-heading.compact { margin-bottom: var(--lu-space-3); }
    .camera-count, .count-badge { color: var(--lu-ink-2); font-size: var(--lu-type-label); font-variant-numeric: tabular-nums; }
    .count-badge { display: inline-grid; min-width: 34px; height: 34px; place-items: center; border-radius: var(--lu-radius-pill); background: var(--lu-accent-soft); color: var(--lu-accent); font-weight: 600; }
    .camera-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--lu-space-4); }
    .camera-tile { min-width: 0; overflow: hidden; padding: 0; border: 1px solid var(--lu-edge); border-radius: var(--lu-radius-card); color: var(--lu-ink); background: transparent; text-align: left; cursor: pointer; }
    .camera-tile:hover { background: var(--lu-tile); }
    .camera-picture { position: relative; overflow: hidden; aspect-ratio: 16 / 9; background: var(--lu-tile); }
    .stream-slot { position: relative; display: grid; width: 100%; height: 100%; min-height: 160px; place-items: center; overflow: hidden; aspect-ratio: 16 / 9; background: var(--lu-tile); }
    .camera-picture .stream-slot { position: absolute; inset: 0; min-height: 0; }
    .focused-stream { aspect-ratio: 16 / 9; min-height: clamp(240px, 45cqi, 520px); border-radius: var(--lu-radius-card); }
    .focused-snapshot { position: relative; }
    .focused-snapshot .snapshot-image { display: block; width: 100%; aspect-ratio: 16 / 9; min-height: clamp(240px, 45cqi, 520px); border-radius: var(--lu-radius-card); }
    .stream-placeholder { display: grid; place-items: center; min-height: 44px; padding: var(--lu-space-4); color: var(--lu-ink-3); font-size: var(--lu-type-caption); text-align: center; }
    .stream-placeholder.static { position: absolute; inset: 0; gap: var(--lu-space-2); align-content: center; }
    .stream-placeholder.static ha-icon { width: 26px; height: 26px; }
    .camera-health { position: absolute; top: var(--lu-space-2); left: var(--lu-space-2); display: inline-flex; min-height: 32px; align-items: center; gap: 6px; padding: 0 var(--lu-space-3); border: 1px solid var(--lu-edge); border-radius: var(--lu-radius-pill); color: var(--lu-ink); background: var(--lu-card); font-size: var(--lu-type-caption); }
    .camera-picture .camera-snapshot { position: absolute; inset: 0; width: 100%; height: 100%; }
    .snapshot-chip { position: absolute; top: var(--lu-space-2); right: var(--lu-space-2); z-index: 1; display: inline-flex; min-height: 28px; align-items: center; padding: 0 var(--lu-space-3); border: 1px solid var(--lu-edge); border-radius: var(--lu-radius-pill); color: var(--lu-ink-2); background: var(--lu-card); font-size: var(--lu-type-caption); }
    .status-chip { display: inline-flex; min-height: 32px; align-items: center; gap: 7px; padding: 0 var(--lu-space-3); border: 1px solid var(--lu-edge); border-radius: var(--lu-radius-pill); color: var(--lu-ink-2); background: var(--lu-tile); font-size: var(--lu-type-caption); }
    .status-dot.info { background: var(--lu-info); }
    .camera-label { display: flex; min-height: 64px; flex-direction: column; justify-content: center; gap: var(--lu-space-1); padding: var(--lu-space-3) var(--lu-space-4); }
    .camera-label strong { font-weight: 600; }
    .camera-label .muted { font-size: var(--lu-type-caption); }
    .sighting { display: inline-flex; align-items: center; gap: 6px; color: var(--lu-accent); font-size: var(--lu-type-caption); }
    .sighting ha-icon { width: 16px; height: 16px; }
    .all-unsupported { margin-top: var(--lu-space-4); }
    .focused-camera { display: grid; gap: var(--lu-space-4); }
    .focused-camera .section-heading { margin-bottom: 0; }
    .back-inline, .text-button { display: inline-flex; align-items: center; min-height: 44px; padding: 0 var(--lu-space-3); border: 0; border-radius: var(--lu-radius-pill); color: var(--lu-accent); background: transparent; font: 600 var(--lu-type-label) var(--lu-font); text-decoration: none; cursor: pointer; }
    .camera-meta { display: flex; flex-wrap: wrap; align-items: center; gap: var(--lu-space-4); color: var(--lu-ink-2); font-size: var(--lu-type-label); }
    .unsupported-stream { display: grid; min-height: 260px; align-content: center; justify-items: center; gap: var(--lu-space-3); padding: var(--lu-space-6); border: 1px solid var(--lu-edge); border-radius: var(--lu-radius-card); color: var(--lu-ink-2); background: var(--lu-tile); text-align: center; }
    .unsupported-stream ha-icon { width: 34px; height: 34px; color: var(--lu-ink-3); }
    .unsupported-stream strong { color: var(--lu-ink); }
    .unsupported-stream a { min-height: 44px; display: inline-flex; align-items: center; }
    .empty-state { display: grid; min-height: 40vh; place-content: center; justify-items: center; gap: var(--lu-space-3); padding: var(--lu-space-6); color: var(--lu-ink-2); text-align: center; }
    .empty-state ha-icon { width: 40px; height: 40px; color: var(--lu-ink-3); }
    .empty-state h2 { color: var(--lu-ink); }
    .empty-state p { max-width: 32rem; }
    .loader { width: 22px; height: 22px; border: 2px solid var(--lu-track-off); border-top-color: var(--lu-accent); border-radius: 50%; animation: spin 1s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
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
    .scrim { position: fixed; z-index: 20; inset: 0; display: flex; align-items: flex-end; justify-content: center; padding: var(--lu-space-4); background: var(--lu-scrim, color-mix(in srgb, var(--primary-background-color) 55%, transparent)); }
    .correction-sheet, .species-sheet { width: min(100%, 640px); max-height: min(86vh, 820px); overflow-y: auto; padding: var(--lu-space-5); border-radius: var(--lu-radius-sheet); background: var(--lu-card); box-shadow: var(--lu-shadow-rest); }
    .sheet-handle { display: none; width: 40px; height: 4px; margin: 0 auto var(--lu-space-3); border-radius: var(--lu-radius-pill); background: var(--lu-track-off); }
    .sheet-head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--lu-space-3); margin-bottom: var(--lu-space-4); }
    .sheet-head p { margin-top: var(--lu-space-1); font-size: var(--lu-type-label); }
    .species-search { width: 100%; min-height: var(--lu-target); margin-bottom: var(--lu-space-3); padding: 0 var(--lu-space-4); border: 1px solid var(--lu-edge); border-radius: var(--lu-radius-control); color: var(--lu-ink); background: var(--lu-tile); }
    .choice-list { max-height: 36vh; overflow-y: auto; }
    .choice-row, .visit-row { display: flex; width: 100%; min-height: var(--lu-target); align-items: center; justify-content: space-between; gap: var(--lu-space-3); padding: var(--lu-space-2) var(--lu-space-3); border: 0; border-bottom: 1px solid var(--lu-edge); border-radius: var(--lu-radius-row); color: var(--lu-ink); background: transparent; text-align: left; cursor: pointer; }
    .choice-row:hover, .visit-row:hover { background: var(--lu-glass-raised); }
    .choice-row ha-icon, .visit-row ha-icon { color: var(--lu-ink-3); }
    .choice-copy { display: flex; min-width: 0; flex-direction: column; gap: 2px; overflow-wrap: anywhere; }
    .no-match { padding: var(--lu-space-4); }
    .special-choices { display: flex; flex-wrap: wrap; gap: var(--lu-space-2); margin-top: var(--lu-space-4); }
    .wildlife-view, .insights-view { display: grid; gap: var(--lu-space-5); max-width: 1440px; margin: 0 auto; }
    .species-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: var(--lu-space-4); }
    .species-tile { display: grid; align-content: start; min-width: 0; gap: var(--lu-space-2); padding: 0 0 var(--lu-space-3); border: 0; border-radius: var(--lu-radius-card); color: var(--lu-ink); background: transparent; text-align: left; cursor: pointer; }
    .species-tile:hover { background: var(--lu-tile); }
    .species-tile kestrel-lazy-image { display: block; width: 100%; }
    .species-photo { position: relative; }
    .heard-hero { display: grid; width: 100%; height: 100%; place-items: center; }
    .heard-hero ha-icon { width: 40px; height: 40px; color: var(--lu-ink-3); }
    .species-name { padding: var(--lu-space-1) var(--lu-space-2) 0; overflow-wrap: anywhere; font-size: var(--lu-type-label); font-weight: 600; }
    .species-marks { display: flex; flex-wrap: wrap; gap: var(--lu-space-3); padding: 0 var(--lu-space-2); color: var(--lu-ink-2); font-size: var(--lu-type-caption); }
    .species-marks span { display: inline-flex; align-items: center; gap: var(--lu-space-2); }
    .species-marks ha-icon { width: 16px; height: 16px; flex: none; }
    .species-tile .caption { padding: 0 var(--lu-space-2); }
    .show-more { margin: var(--lu-space-2) auto 0; }
    .species-detail-hero { display: grid; grid-template-columns: minmax(0,1.4fr) minmax(110px,.6fr); align-items: center; gap: var(--lu-space-4); margin-bottom: var(--lu-space-5); }
    .species-detail-hero kestrel-lazy-image { display: block; width: 100%; aspect-ratio: 16 / 10; }
    .species-count { display: grid; gap: var(--lu-space-1); text-align: center; }
    .species-count strong { font-size: var(--lu-type-display); font-weight: 350; font-variant-numeric: tabular-nums; }
    .species-count span { color: var(--lu-ink-2); font-size: var(--lu-type-caption); }
    .detail-section { margin-top: var(--lu-space-5); padding-top: var(--lu-space-4); border-top: 1px solid var(--lu-edge); }
    .hours-chart { display: grid; height: 100px; grid-template-columns: repeat(24, minmax(0, 1fr)); align-items: end; gap: 3px; padding: var(--lu-space-2) 0; }
    .hour-bar { height: var(--bar-height); min-height: 4px; border-radius: 4px 4px 1px 1px; background: var(--lu-accent); opacity: .78; }
    .hours-labels { display: flex; justify-content: space-between; color: var(--lu-ink-3); font-size: var(--lu-type-caption); }
    .simple-list, .visit-list, .call-list { display: grid; margin: 0; padding: 0; list-style: none; }
    .simple-list li { display: flex; min-height: var(--lu-target); align-items: center; justify-content: space-between; gap: var(--lu-space-3); border-bottom: 1px solid var(--lu-edge); color: var(--lu-ink-2); font-size: var(--lu-type-label); }
    .simple-list li:last-child, .visit-list li:last-child .visit-row { border-bottom: 0; }
    .simple-list strong { color: var(--lu-ink); font-variant-numeric: tabular-nums; }
    .visit-row { justify-content: flex-start; }
    .visit-row > span { display: flex; min-width: 0; flex: 1; flex-direction: column; gap: 3px; }
    .visit-row strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 550; }
    .visit-row small { color: var(--lu-ink-2); font-size: var(--lu-type-caption); }
    .call-list li { display: flex; min-height: var(--lu-target); align-items: center; justify-content: space-between; gap: var(--lu-space-2); border-bottom: 1px solid var(--lu-edge); color: var(--lu-ink-2); font-size: var(--lu-type-caption); }
    .call-list kestrel-lazy-audio { width: min(100%, 280px); }
    .sheet-footer { display: flex; flex-wrap: wrap; align-items: center; gap: var(--lu-space-3); margin-top: var(--lu-space-5); padding-top: var(--lu-space-4); border-top: 1px solid var(--lu-edge); }
    .review-section, .noisy-section { padding: var(--lu-space-5); }
    .empty-inline { padding: var(--lu-space-3) 0; color: var(--lu-ink-2); font-size: var(--lu-type-label); }
    .review-thumb { width: 56px; height: 56px; flex: none; }
    .review-copy { min-width: 0; }
    .health-grid { display: grid; grid-template-columns: repeat(3, minmax(0,1fr)); gap: var(--lu-space-3); }
    .health-tile { display: flex; min-width: 0; flex-direction: column; gap: var(--lu-space-2); padding: var(--lu-space-4); }
    .health-title { display: flex; align-items: center; gap: var(--lu-space-2); color: var(--lu-ink-2); font-size: var(--lu-type-caption); }
    .health-title ha-icon { width: 18px; height: 18px; color: var(--lu-accent); }
    .health-tile strong { overflow-wrap: anywhere; font-size: var(--lu-type-title); font-weight: 600; font-variant-numeric: tabular-nums; }
    .health-tile p, .health-tile small { color: var(--lu-ink-2); font-size: var(--lu-type-caption); line-height: 1.4; }
    .health-tile small { margin-top: auto; }
    .health-tile .meter { width: 100%; margin: var(--lu-space-1) 0; }
    .health-tile .healthy { color: var(--lu-positive); }
    .health-tile .unhealthy { color: var(--lu-warning); }
    .toast { position: fixed; z-index: 30; right: max(var(--lu-space-4), env(safe-area-inset-right)); bottom: calc(var(--lu-space-4) + env(safe-area-inset-bottom)); left: max(var(--lu-space-4), env(safe-area-inset-left)); display: flex; width: max-content; max-width: min(560px, calc(100vw - 32px)); min-height: 56px; align-items: center; justify-content: space-between; gap: var(--lu-space-3); margin: 0 auto; padding: var(--lu-space-2) var(--lu-space-3); border: 1px solid var(--lu-edge); border-radius: var(--lu-radius-pill); color: var(--lu-ink); background: var(--lu-card); box-shadow: var(--lu-highlight-rest), var(--lu-shadow-rest); }
    .toast-action { min-width: var(--lu-target); min-height: var(--lu-target); border: 0; border-radius: var(--lu-radius-pill); color: var(--lu-accent); background: transparent; font-weight: 600; cursor: pointer; }
    .toast-close { width: 42px; height: 42px; }
    @container (max-width: 680px) {
      ha-card { min-height: calc(100vh - var(--header-height, 56px)); }
      main { padding: var(--lu-space-4) var(--lu-space-3) calc(84px + env(safe-area-inset-bottom)); }
      .topbar { min-height: 60px; padding: var(--lu-space-2) var(--lu-space-3); }
      .navigation { position: fixed; z-index: 15; right: 0; bottom: 0; left: 0; display: grid; height: calc(64px + env(safe-area-inset-bottom)); grid-template-columns: repeat(3, minmax(0,1fr)); gap: var(--lu-space-1); padding: var(--lu-space-1) var(--lu-space-2) calc(var(--lu-space-1) + env(safe-area-inset-bottom)); border-top: 1px solid var(--lu-edge); background: var(--primary-background-color); }
      @supports (backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px)) {
        .navigation { background: color-mix(in srgb, var(--lu-card) 75%, transparent); backdrop-filter: blur(24px) saturate(1.4); -webkit-backdrop-filter: blur(24px) saturate(1.4); }
      }
      .nav-item { min-width: 0; min-height: 48px; flex-direction: column; gap: 2px; padding: var(--lu-space-1); font-size: var(--lu-type-caption); }
      .nav-item span { overflow: hidden; max-width: 100%; text-overflow: ellipsis; white-space: nowrap; }
      .open-scrypted { min-height: 48px; padding: 0 var(--lu-space-2); font-size: var(--lu-type-caption); }
      .visit-view { grid-template-columns: 1fr; gap: var(--lu-space-4); }
      .focused-stream { min-height: 240px; }
      .health-grid { grid-template-columns: repeat(2, minmax(0,1fr)); }
      .scrim { padding: 0; }
      .correction-sheet, .species-sheet { width: 100%; max-height: min(90vh, 860px); padding: var(--lu-space-4); padding-bottom: calc(var(--lu-space-5) + env(safe-area-inset-bottom)); border-radius: var(--lu-radius-sheet) var(--lu-radius-sheet) 0 0; }
      .sheet-handle { display: block; }
    }
    @container (max-width: 400px) {
      .species-grid { grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); }
      .camera-grid { grid-template-columns: 1fr; }
      .health-grid { grid-template-columns: 1fr; }
      .section-heading { align-items: flex-start; }
      .heard-panel { grid-template-columns: 1fr; }
      .heard-panel .pill { width: 100%; }
      .species-detail-hero { grid-template-columns: 1fr; }
      .species-count { justify-items: start; text-align: left; }
      .open-scrypted { max-width: 104px; overflow: hidden; white-space: nowrap; }
      .focused-camera .section-heading { flex-wrap: wrap; }
      .toast { width: calc(100% - 32px); }
    }
    @media (prefers-reduced-motion: reduce) {
      .loader { animation: none; }
      .progress-track span, .meter span { transition: none; }
    }
  `];

  render() {
    let view: unknown = nothing;
    if (this._view === "live") view = this._renderLive();
    else if (this._view === "visit") view = this._renderVisit();
    else if (this._view === "wildlife") view = this._renderWildlife();
    else view = this._renderInsights();
    const shell = html`<div class="app" aria-busy=${this._loading ? "true" : "false"}>
      ${this._renderHeader()}${this._renderNav()}<main>
        ${this._renderLoadError()}${view}
      </main>${this._renderToast()}
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
