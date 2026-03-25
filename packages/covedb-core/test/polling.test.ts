import { afterEach, describe, expect, it, vi } from "vitest";

import { createAdaptivePoller } from "../src/polling";

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("createAdaptivePoller", () => {
  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as { window?: unknown }).window;
    delete (globalThis as { document?: unknown }).document;
  });

  it("reschedules to the active window after browser focus activity", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-13T00:00:00.000Z"));

    const windowTarget = new EventTarget();
    const documentTarget = new EventTarget() as EventTarget & { hidden: boolean };
    documentTarget.hidden = false;
    (globalThis as { window?: unknown }).window = windowTarget;
    (globalThis as { document?: unknown }).document = documentTarget;

    const runTimes: number[] = [];
    const poller = createAdaptivePoller({
      run: async () => {
        runTimes.push(Date.now());
      },
    });

    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(1_800_000);
    expect(runTimes.at(-1)).toBe(Date.parse("2026-03-13T00:30:00.000Z"));

    windowTarget.dispatchEvent(new Event("focus"));

    const runCountAfterFocus = runTimes.length;
    await vi.advanceTimersByTimeAsync(4_000);
    expect(runTimes).toHaveLength(runCountAfterFocus);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(runTimes.at(-1)).toBe(Date.parse("2026-03-13T00:30:05.000Z"));

    poller.disconnect();
  });

  it("marks activity when the document becomes visible", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-13T00:00:00.000Z"));

    const windowTarget = new EventTarget();
    const documentTarget = new EventTarget() as EventTarget & { hidden: boolean };
    documentTarget.hidden = true;
    (globalThis as { window?: unknown }).window = windowTarget;
    (globalThis as { document?: unknown }).document = documentTarget;

    const runTimes: number[] = [];
    const poller = createAdaptivePoller({
      run: async () => {
        runTimes.push(Date.now());
      },
    });

    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(1_800_000);
    expect(runTimes.at(-1)).toBe(Date.parse("2026-03-13T00:30:00.000Z"));

    documentTarget.hidden = false;
    documentTarget.dispatchEvent(new Event("visibilitychange"));

    const runCountAfterVisible = runTimes.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(runTimes).toHaveLength(runCountAfterVisible + 1);
    expect(runTimes.at(-1)).toBe(Date.parse("2026-03-13T00:30:05.000Z"));

    poller.disconnect();
  });

  it("does not delay five second polling when activity repeats inside the active window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-13T00:00:00.000Z"));

    const runTimes: number[] = [];
    const poller = createAdaptivePoller({
      run: async ({ markActivity }) => {
        runTimes.push(Date.now());
        if (runTimes.length === 1) {
          markActivity();
        }
      },
    });

    await flushMicrotasks();
    expect(runTimes).toEqual([Date.parse("2026-03-13T00:00:00.000Z")]);

    await vi.advanceTimersByTimeAsync(1_000);
    poller.markActivity();
    await vi.advanceTimersByTimeAsync(1_000);
    poller.markActivity();
    await vi.advanceTimersByTimeAsync(1_000);
    poller.markActivity();
    await vi.advanceTimersByTimeAsync(1_000);
    poller.markActivity();

    expect(runTimes).toEqual([Date.parse("2026-03-13T00:00:00.000Z")]);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(runTimes).toEqual([
      Date.parse("2026-03-13T00:00:00.000Z"),
      Date.parse("2026-03-13T00:00:05.000Z"),
    ]);

    poller.disconnect();
  });
});
