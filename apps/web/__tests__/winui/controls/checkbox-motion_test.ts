import { describe, expect, it } from 'vitest';

import { choiceCss } from '../../../src/winui/controls/choice.css';

const CHECK_ON_BEZIER = [0.55, 0, 0, 1] as const;

const cubicCoordinate = (time: number, first: number, second: number) =>
  3 * (1 - time) ** 2 * time * first + 3 * (1 - time) * time ** 2 * second + time ** 3;

const cubicOutputAt = (progress: number) => {
  const [x1, y1, x2, y2] = CHECK_ON_BEZIER;
  let low = 0;
  let high = 1;
  for (let iteration = 0; iteration < 60; iteration += 1) {
    const time = (low + high) / 2;
    if (cubicCoordinate(time, x1, x2) < progress) low = time; else high = time;
  }
  return cubicCoordinate((low + high) / 2, y1, y2);
};

const linearStops = () => {
  const supported = /@supports \(transition-timing-function: linear\(0, 1\)\)[\s\S]*?transition-timing-function: linear\(([^)]*)\)/.exec(choiceCss);
  if (supported === null) throw new Error('the check-on motion has no linear() feature gate');
  return supported[1]!.split(',').map(value => Number(value.trim()));
};

const linearOutputAt = (stops: number[], progress: number) => {
  if (progress === 1) return stops.at(-1)!;
  const position = progress * (stops.length - 1);
  const index = Math.floor(position);
  const offset = position - index;
  return stops[index]! + (stops[index + 1]! - stops[index]!) * offset;
};

describe('WinUI checkbox motion', () => {
  it('keeps the WinUI cubic fallback outside the linear() feature gate', () => {
    const fallback = choiceCss.indexOf('transition-timing-function: cubic-bezier(0.55, 0, 0, 1)');
    const gate = choiceCss.indexOf('@supports (transition-timing-function: linear(0, 1))');
    expect(fallback).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(fallback);
  });

  it('keeps the linear() route within five thousandths of the WinUI curve', () => {
    const stops = linearStops();
    expect(stops).toHaveLength(41);
    expect(stops[0]).toBe(0);
    expect(stops.at(-1)).toBe(1);

    let largestError = 0;
    for (let sample = 0; sample <= 10_000; sample += 1) {
      const progress = sample / 10_000;
      largestError = Math.max(largestError, Math.abs(linearOutputAt(stops, progress) - cubicOutputAt(progress)));
    }
    expect(largestError).toBeLessThan(0.005);
  });
});
