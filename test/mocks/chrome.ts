// A typed fake implementing the subset of the chrome.* extension APIs we use.
// No real browser APIs are touched; everything is in-memory and resettable.

type Listener<T extends unknown[]> = (...args: T) => void;

interface FakeEvent<T extends unknown[]> {
  addListener(listener: Listener<T>): void;
  removeListener(listener: Listener<T>): void;
  dispatch(...args: T): void;
  readonly listeners: ReadonlyArray<Listener<T>>;
}

function createEvent<T extends unknown[]>(): FakeEvent<T> {
  const listeners: Listener<T>[] = [];
  return {
    addListener(listener) {
      listeners.push(listener);
    },
    removeListener(listener) {
      const i = listeners.indexOf(listener);
      if (i >= 0) listeners.splice(i, 1);
    },
    dispatch(...args: T) {
      for (const l of [...listeners]) l(...args);
    },
    listeners,
  };
}

export interface ChromeMock {
  runtime: {
    id: string;
    sendMessage: (message: unknown) => Promise<unknown>;
    onMessage: FakeEvent<[unknown, unknown, (response?: unknown) => void]>;
    onMessageExternal: FakeEvent<[unknown, unknown, (response?: unknown) => void]>;
  };
  storage: {
    local: {
      get: (keys?: string | string[] | null) => Promise<Record<string, unknown>>;
      set: (items: Record<string, unknown>) => Promise<void>;
      reset: () => void;
    };
  };
  alarms: {
    create: (name: string, alarmInfo?: unknown) => void;
    clear: (name: string) => Promise<boolean>;
    onAlarm: FakeEvent<[{ name: string }]>;
  };
  cookies: {
    get: (details: { url: string; name: string }) => Promise<{ name: string; value: string } | null>;
  };
  permissions: {
    request: (permissions: unknown) => Promise<boolean>;
    contains: (permissions: unknown) => Promise<boolean>;
  };
  tabs: {
    create: (createProperties: { url?: string }) => Promise<{ id: number; url?: string }>;
  };
}

function createChromeMock(): ChromeMock {
  let store: Record<string, unknown> = {};

  const local = {
    async get(keys?: string | string[] | null): Promise<Record<string, unknown>> {
      if (keys == null) return { ...store };
      const names = Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const k of names) {
        if (k in store) out[k] = store[k];
      }
      return out;
    },
    async set(items: Record<string, unknown>): Promise<void> {
      Object.assign(store, items);
    },
    reset(): void {
      store = {};
    },
  };

  return {
    runtime: {
      id: "test-extension-id",
      async sendMessage(_message: unknown): Promise<unknown> {
        return undefined;
      },
      onMessage: createEvent(),
      onMessageExternal: createEvent(),
    },
    storage: { local },
    alarms: {
      create(_name: string, _alarmInfo?: unknown): void {},
      async clear(_name: string): Promise<boolean> {
        return true;
      },
      onAlarm: createEvent(),
    },
    cookies: {
      async get(_details: { url: string; name: string }): Promise<{ name: string; value: string } | null> {
        return null;
      },
    },
    permissions: {
      async request(_permissions: unknown): Promise<boolean> {
        return true;
      },
      async contains(_permissions: unknown): Promise<boolean> {
        return false;
      },
    },
    tabs: {
      async create(createProperties: { url?: string }): Promise<{ id: number; url?: string }> {
        return { id: 1, url: createProperties.url };
      },
    },
  };
}

let current: ChromeMock | undefined;

export function installChromeMock(): ChromeMock {
  current = createChromeMock();
  (globalThis as unknown as { chrome?: ChromeMock }).chrome = current;
  return current;
}

export function resetChromeMock(): void {
  current?.storage.local.reset();
  delete (globalThis as unknown as { chrome?: ChromeMock }).chrome;
  current = undefined;
}
