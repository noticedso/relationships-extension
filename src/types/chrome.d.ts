// Minimal ambient declaration of the chrome.* extension surface this package uses.
// Covers only the APIs referenced by src/ — not the full @types/chrome surface.

interface ChromeEvent<T extends unknown[]> {
  addListener(listener: (...args: T) => void): void;
  removeListener(listener: (...args: T) => void): void;
}

type SendResponse = (response?: unknown) => void;

declare const chrome: {
  runtime: {
    id: string;
    sendMessage(message: unknown): Promise<unknown>;
    getManifest(): { version: string };
    requestUpdateCheck(): Promise<{ status: "throttled" | "no_update" | "update_available"; version?: string }>;
    onMessage: ChromeEvent<[unknown, { id?: string; origin?: string; url?: string }, SendResponse]>;
    onMessageExternal: ChromeEvent<
      [unknown, { id?: string; origin?: string; url?: string }, SendResponse]
    >;
    onInstalled: ChromeEvent<[{ reason: string; previousVersion?: string }]>;
  };
  storage: {
    local: {
      get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
    };
  };
  alarms: {
    create(
      name: string,
      alarmInfo?: { periodInMinutes?: number; delayInMinutes?: number; when?: number },
    ): void;
    get(name: string): Promise<{ name: string; periodInMinutes?: number } | undefined>;
    clear(name: string): Promise<boolean>;
    onAlarm: ChromeEvent<[{ name: string }]>;
  };
  cookies: {
    get(details: { url: string; name: string }): Promise<{ name: string; value: string } | null>;
    onChanged: ChromeEvent<[{ removed: boolean; cookie: { name: string; domain: string }; cause: string }]>;
  };
  permissions: {
    request(permissions: { origins?: string[]; permissions?: string[] }): Promise<boolean>;
    contains(permissions: { origins?: string[]; permissions?: string[] }): Promise<boolean>;
    onAdded: ChromeEvent<[{ origins?: string[]; permissions?: string[] }]>;
  };
  tabs: {
    create(createProperties: { url?: string; active?: boolean }): Promise<{ id?: number; url?: string }>;
    get(tabId: number): Promise<{ id?: number; url?: string; pendingUrl?: string }>;
    remove(tabId: number): Promise<void>;
    query(queryInfo: { url?: string | string[] }): Promise<Array<{ id?: number; windowId?: number; url?: string }>>;
    update(tabId: number, updateProperties: { active?: boolean }): Promise<{ id?: number }>;
  };
  windows: {
    update(windowId: number, updateInfo: { focused?: boolean }): Promise<{ id?: number }>;
  };
  action: {
    onClicked: ChromeEvent<[{ id?: number; url?: string }]>;
  };
};
