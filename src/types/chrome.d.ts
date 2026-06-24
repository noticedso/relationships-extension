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
    onMessage: ChromeEvent<[unknown, { id?: string; origin?: string; url?: string }, SendResponse]>;
    onMessageExternal: ChromeEvent<
      [unknown, { id?: string; origin?: string; url?: string }, SendResponse]
    >;
  };
  storage: {
    local: {
      get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
    };
  };
  alarms: {
    create(name: string, alarmInfo?: { periodInMinutes?: number; delayInMinutes?: number }): void;
    clear(name: string): Promise<boolean>;
    onAlarm: ChromeEvent<[{ name: string }]>;
  };
  cookies: {
    get(details: { url: string; name: string }): Promise<{ name: string; value: string } | null>;
  };
  permissions: {
    request(permissions: { origins?: string[]; permissions?: string[] }): Promise<boolean>;
    contains(permissions: { origins?: string[]; permissions?: string[] }): Promise<boolean>;
  };
  tabs: {
    create(createProperties: { url?: string; active?: boolean }): Promise<{ id?: number; url?: string }>;
    remove(tabId: number): Promise<void>;
  };
};
