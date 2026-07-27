import { vi } from 'vitest';

export class FakeTime {
  constructor(now: number | Date = 0) {
    vi.useFakeTimers();
    vi.setSystemTime(now);
  }

  tick(ms: number): void {
    vi.advanceTimersByTime(ms);
  }

  async tickAsync(ms: number): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms);
  }

  runMicrotasks(): void {
    const maybeRunAllTicks = vi as typeof vi & { runAllTicks?: () => void };
    maybeRunAllTicks.runAllTicks?.();
  }

  restore(): void {
    vi.useRealTimers();
  }
}
