const ACTIVITY_WINDOWS = [
  { maxIdleMs: 60_000, intervalMs: 5_000 },
  { maxIdleMs: 120_000, intervalMs: 15_000 },
  { maxIdleMs: 300_000, intervalMs: 30_000 },
  { maxIdleMs: 600_000, intervalMs: 60_000 },
  { maxIdleMs: 1_800_000, intervalMs: 120_000 },
] as const;

export interface AdaptivePoller {
  disconnect(): void;
  refresh(): Promise<void>;
  markActivity(): void;
}

interface AdaptivePollerOptions {
  run: (controls: Pick<AdaptivePoller, "markActivity">) => Promise<void>;
  onError?: (error: unknown) => void;
}

interface BrowserActivityTarget {
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: AddEventListenerOptions | boolean,
  ): void;
  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: EventListenerOptions | boolean,
  ): void;
}

function nextIntervalMs(lastActivityAt: number): number {
  const idleMs = Math.max(0, Date.now() - lastActivityAt);
  const window = ACTIVITY_WINDOWS.find((candidate) => idleMs < candidate.maxIdleMs);
  return window?.intervalMs ?? 300_000;
}

function registerBrowserActivityListeners(markActivity: () => void): (() => void) | null {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return null;
  }

  const listeners: Array<{
    target: BrowserActivityTarget;
    type: string;
    listener: EventListener;
    options?: AddEventListenerOptions;
  }> = [
    { target: window, type: "focus", listener: () => markActivity() },
    {
      target: document,
      type: "visibilitychange",
      listener: () => {
        if (!document.hidden) {
          markActivity();
        }
      },
    },
    {
      target: document,
      type: "pointerdown",
      listener: () => markActivity(),
      options: { passive: true },
    },
    { target: document, type: "keydown", listener: () => markActivity() },
  ];

  for (const entry of listeners) {
    entry.target.addEventListener(entry.type, entry.listener, entry.options);
  }

  return () => {
    for (const entry of listeners) {
      entry.target.removeEventListener(entry.type, entry.listener, entry.options);
    }
  };
}

export function createAdaptivePoller(options: AdaptivePollerOptions): AdaptivePoller {
  let running = true;
  let lastActivityAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let nextRunAt: number | null = null;
  let inFlight: Promise<void> | null = null;
  let queuedRun: Promise<void> | null = null;
  let resolveQueuedRun: (() => void) | null = null;

  const clearTimer = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    nextRunAt = null;
  };

  const markActivity = (): void => {
    lastActivityAt = Date.now();
    if (running && !inFlight) {
      scheduleNext({ onlyIfEarlier: true });
    }
  };

  const scheduleNext = (options: { onlyIfEarlier?: boolean } = {}): void => {
    if (!running) {
      return;
    }

    const delayMs = nextIntervalMs(lastActivityAt);
    const candidateRunAt = Date.now() + delayMs;
    if (options.onlyIfEarlier && nextRunAt !== null && nextRunAt <= candidateRunAt) {
      return;
    }

    clearTimer();
    nextRunAt = candidateRunAt;
    timer = setTimeout(() => {
      timer = null;
      nextRunAt = null;
      void startRun();
    }, delayMs);
  };

  const startQueuedRun = (): Promise<void> => {
    const queuedResolver = resolveQueuedRun;
    queuedRun = null;
    resolveQueuedRun = null;
    const promise = startRun();
    promise.finally(() => {
      queuedResolver?.();
    });
    return promise;
  };

  const startRun = (): Promise<void> => {
    if (!running) {
      return Promise.resolve();
    }

    if (inFlight) {
      return inFlight;
    }

    clearTimer();
    inFlight = (async () => {
      try {
        await options.run({ markActivity });
      } catch (error) {
        options.onError?.(error);
      } finally {
        inFlight = null;
        if (!running) {
          return;
        }

        if (queuedRun) {
          void startQueuedRun();
          return;
        }

        scheduleNext();
      }
    })();

    return inFlight;
  };

  const refresh = (): Promise<void> => {
    if (!running) {
      return Promise.resolve();
    }

    markActivity();
    clearTimer();

    if (inFlight) {
      if (!queuedRun) {
        queuedRun = new Promise<void>((resolve) => {
          resolveQueuedRun = resolve;
        });
      }
      return queuedRun;
    }

    return startRun();
  };

  void startRun();
  const unregisterBrowserActivity = registerBrowserActivityListeners(markActivity);

  return {
    disconnect() {
      running = false;
      clearTimer();
      unregisterBrowserActivity?.();
    },
    refresh,
    markActivity,
  };
}
