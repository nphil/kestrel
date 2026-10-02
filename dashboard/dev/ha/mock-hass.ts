/* Adapted from lucent-ha dev/mock-hass.ts (MIT, same owner): a scripted stand-in for the `hass` object Home Assistant hands every panel.
 *
 * Like the real one it is IMMUTABLE: every change builds a NEW object and tells the subscribers (the frame, the panel), so a panel that
 * compares `hass` by identity sees what it would see in Home Assistant.
 *
 * `connection` follows home-assistant-js-websocket's `Connection` as far as a panel looks at it:
 *   - `connected`, `addEventListener` / `removeEventListener` for "ready" and "disconnected" (the SAME object survives a reconnect);
 *   - `subscribeMessage(callback, message, options?)` resolves to an unsubscribe function; subscriptions survive a drop (the library re-sends them)
 *     unless `options.resubscribe` is false;
 *   - while the socket is down, a NEW command fails at once with the bare number ERR_CONNECTION_LOST (3), as `sendMessage` throws it;
 *     a command already in flight when the socket drops fails with `{ code: 3, message: "Connection lost" }`, as `sendMessagePromise` does. */
import type { HassConnection, HomeAssistant } from "lucent-ha";
import { HA_THEMES, describeTheme, type ThemeName } from "./theme.ts";

type ConnectionEvent = "ready" | "disconnected" | "reconnect-error";
type ConnectionListener = (connection: HassConnection, data?: unknown) => void;

/** `home-assistant-js-websocket`'s `ERR_CONNECTION_LOST`. */
export const ERR_CONNECTION_LOST = 3;

/** What an event subscription delivers to its callback (the whole websocket message, like the library). */
export type SubscriptionCallback = (message: never) => void;

export class MockConnection implements HassConnection {
  connected = true;
  private readonly listeners: Record<ConnectionEvent, Set<ConnectionListener>> = { ready: new Set(), disconnected: new Set(), "reconnect-error": new Set() };
  private readonly subscriptions = new Map<SubscriptionCallback, { message: Record<string, unknown>; resubscribe: boolean }>();
  private readonly inFlight = new Set<(reason: unknown) => void>();

  addEventListener(type: ConnectionEvent, listener: ConnectionListener): void {
    this.listeners[type].add(listener);
  }

  removeEventListener(type: ConnectionEvent, listener: ConnectionListener): void {
    this.listeners[type].delete(listener);
  }

  emit(type: ConnectionEvent): void {
    for (const listener of [...this.listeners[type]]) listener(this);
  }

  /** Delivers a push message to every subscription (what the integration's `kestrel/subscribe` stream does). */
  push(message: unknown): void {
    for (const callback of [...this.subscriptions.keys()]) (callback as (message: unknown) => void)(message);
  }

  /** How many event subscriptions are open (a test can see that a panel really subscribed). */
  get subscriptionCount(): number {
    return this.subscriptions.size;
  }

  /** `options.resubscribe: false` (the library's option): after a drop the server side is gone and nothing re-sends it, so the owner must subscribe again. */
  async subscribeMessage<T>(callback: (message: T) => void, message: Record<string, unknown>, options?: { resubscribe?: boolean }): Promise<() => Promise<void>> {
    if (!this.connected) throw ERR_CONNECTION_LOST;
    const key = callback as SubscriptionCallback;
    this.subscriptions.set(key, { message, resubscribe: options?.resubscribe !== false });
    return async () => {
      this.subscriptions.delete(key);
    };
  }

  /** Runs `work` as one websocket command: refused while down, rejected when the socket drops under it. */
  send<T>(work: () => Promise<T>): Promise<T> {
    if (!this.connected) return Promise.reject(ERR_CONNECTION_LOST);
    return new Promise<T>((resolve, reject) => {
      this.inFlight.add(reject);
      work().then(resolve, reject).finally(() => this.inFlight.delete(reject));
    });
  }

  /** The socket dropped: commands in flight fail like the library's `sendMessagePromise` ones. */
  drop(): void {
    this.connected = false;
    for (const [callback, subscription] of [...this.subscriptions]) if (!subscription.resubscribe) this.subscriptions.delete(callback);
    const pending = [...this.inFlight];
    this.inFlight.clear();
    for (const reject of pending) reject({ code: ERR_CONNECTION_LOST, message: "Connection lost" });
  }
}

export type WebSocketHandler = (message: Record<string, unknown>) => unknown;

/** The few strings Home Assistant's own UI asks `hass.localize` for; anything else comes back as its key, like an untranslated string. */
const ENGLISH: Record<string, string> = {
  "ui.sidebar.sidebar_toggle": "Sidebar toggle",
  "ui.common.close": "Close",
  "ui.common.back": "Back",
  "ui.common.cancel": "Cancel",
  "ui.common.retry": "Retry",
};

export interface MockHaOptions {
  dockedSidebar: NonNullable<HomeAssistant["dockedSidebar"]>;
  kioskMode: boolean;
  theme: ThemeName;
}

export class MockHa {
  readonly connection = new MockConnection();
  private readonly subscribers = new Set<(hass: HomeAssistant) => void>();
  private readonly handlers = new Map<string, WebSocketHandler>();
  private current: HomeAssistant;

  constructor(options: MockHaOptions) {
    const theme = describeTheme(options.theme);
    this.current = {
      connected: true,
      connection: this.connection,
      kioskMode: options.kioskMode,
      dockedSidebar: options.dockedSidebar,
      auth: { external: undefined },
      themes: { darkMode: theme.dark, theme: theme.haTheme, themes: HA_THEMES },
      selectedTheme: { theme: theme.haTheme, dark: theme.dark },
      language: "en",
      localize: (key) => ENGLISH[key] ?? key,
      callWS: <T,>(message: Record<string, unknown>) => this.callWS<T>(message),
      hassUrl: (path = "") => `${location.origin}${path}`,
      states: {},
      user: { is_admin: true, name: "Nitin" },
      panelUrl: "kestrel",
    };
  }

  get hass(): HomeAssistant {
    return this.current;
  }

  /** Builds the next `hass` (a new object) and tells every subscriber. */
  update(patch: Partial<HomeAssistant>): void {
    this.current = { ...this.current, ...patch };
    for (const subscriber of [...this.subscribers]) subscriber(this.current);
  }

  /** The emulated theme changed: `hass.themes` and `hass.selectedTheme` follow, as they do in Home Assistant. */
  setTheme(name: ThemeName): void {
    const theme = describeTheme(name);
    this.update({ themes: { darkMode: theme.dark, theme: theme.haTheme, themes: HA_THEMES }, selectedTheme: { theme: theme.haTheme, dark: theme.dark } });
  }

  subscribe(subscriber: (hass: HomeAssistant) => void): () => void {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  /** Answers `callWS({ type })` with `handler(message)` (a value or a promise); a rejection becomes the error the caller sees. */
  onWS(type: string, handler: WebSocketHandler): void {
    this.handlers.set(type, handler);
  }

  /** The websocket drops: in-flight commands fail, `hass.connected` turns false and the connection fires `disconnected`. */
  disconnect(): void {
    if (!this.connection.connected) return;
    this.connection.drop();
    this.update({ connected: false });
    this.connection.emit("disconnected");
  }

  /** The websocket is back: `hass.connected` turns true and the connection fires `ready`. */
  reconnect(): void {
    if (this.connection.connected) return;
    this.connection.connected = true;
    this.update({ connected: true });
    this.connection.emit("ready");
  }

  private callWS<T>(message: Record<string, unknown>): Promise<T> {
    return this.connection.send(async () => {
      const handler = this.handlers.get(String(message.type));
      if (!handler) throw Object.assign(new Error(`mock hass: no handler for websocket message "${String(message.type)}"`), { code: "unknown_command" });
      return (await handler(message)) as T;
    }) as Promise<T>;
  }
}
