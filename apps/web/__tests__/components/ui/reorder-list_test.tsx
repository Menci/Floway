import { act, fireEvent, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { moveItem, ReorderHandle, type ReorderHandleProps, useReorderList } from '../../../src/components/ui/reorder-list';
import { REPOSITION_ANIMATION_MS } from '../../../src/winui/motion';
import { renderInApp } from '../../render';

const ROW = 40;

// happy-dom lays nothing out, so the boxes the gesture measures are stated
// here: a strip of equal rows starting at the top of the list. The DOM order
// never changes under a gesture, so an element's own position stands for it.
const rect = (top: number, height: number) =>
  ({ bottom: top + height, height, left: 0, right: 0, top, width: 0, x: 0, y: top }) as DOMRect;

const original = Element.prototype.getBoundingClientRect;

function boxes(this: Element) {
  if (this.hasAttribute('data-reorder-list')) return rect(0, ROW * this.children.length);
  const parent = this.parentElement;
  if (this.hasAttribute('data-reorder-item') && parent) return rect([...parent.children].indexOf(this) * ROW, ROW);
  return original.call(this);
}

beforeAll(() => { Element.prototype.getBoundingClientRect = boxes; });
afterAll(() => { Element.prototype.getBoundingClientRect = original; });
afterEach(() => { vi.useRealTimers(); });

const names = ['alpha', 'bravo', 'charlie', 'delta'];

/** `orderable` is how many leading items the list lets the operator order. */
const List = ({ busy = false, onDrop, onDropError, onDragStart, onReorder, orderable = names.length }: {
  busy?: boolean;
  onDrop?: (from: number, to: number) => Promise<void>;
  onDropError?: (error: unknown, from: number, to: number) => void | Promise<void>;
  onDragStart?: () => void;
  onReorder: (from: number, to: number) => void;
  orderable?: number;
}) => {
  const [items, setItems] = useState(names);
  const reorder = useReorderList({
    busy,
    length: orderable,
    onDrop,
    onDropError,
    onDragStart,
    onReorder: (from, to) => { setItems(current => moveItem(current, from, to)); onReorder(from, to); },
  });
  return <ul {...reorder.listProps()}>
    {items.map((name, index) => <Row
      handle={reorder.handleProps(index < orderable ? index : -1)}
      key={name}
      name={name}
      props={index < orderable ? reorder.itemProps(index) : {}}
      rank={reorder.position(index)}
    />)}
  </ul>;
};

const Row = ({ handle, name, props, rank }: { handle: ReorderHandleProps; name: string; props: object; rank: number }) =>
  <li {...props} data-name={name} data-rank={rank}><ReorderHandle {...handle} label={`Reorder ${name}`} /></li>;

const items = () => [...document.querySelectorAll('li')];
const rendered = () => items().map(item => item.getAttribute('data-name'));
const offsets = () => items().map(item => item.style.transform);
const ranks = () => items().map(item => item.getAttribute('data-rank'));

const travel = () => document.querySelector<HTMLElement>('[data-reorder-list]')!.style.getPropertyValue('--floway-reorder-drag-y');

const grip = (name: string) => screen.getByRole('button', { name: `Reorder ${name}` });

const press = (element: HTMLElement, clientY: number) =>
  fireEvent.pointerDown(element, { button: 0, clientY, isPrimary: true, pointerId: 1 });

// The gesture reads the window: Escape has to be heard wherever focus is.
const drag = (clientY: number) => fireEvent.pointerMove(window, { clientY, pointerId: 1 });
const release = (clientY: number) => fireEvent.pointerUp(window, { clientY, pointerId: 1 });

describe('drag-to-position reordering', () => {
  it('starts an asynchronous write at release and holds the settled preview until it succeeds', async () => {
    vi.useFakeTimers();
    let resolveWrite!: () => void;
    const write = new Promise<void>(resolve => { resolveWrite = resolve; });
    const onDrop = vi.fn(() => write);
    const onReorder = vi.fn();
    const view = renderInApp(<List onDrop={onDrop} onReorder={onReorder} />);

    press(grip('alpha'), 20);
    drag(150);
    release(150);
    expect(onDrop).toHaveBeenCalledExactlyOnceWith(0, 3);

    view.rerender(<List busy onDrop={onDrop} onReorder={onReorder} />);
    expect(grip('alpha').hasAttribute('aria-disabled')).toBe(false);

    await act(async () => { vi.advanceTimersByTime(REPOSITION_ANIMATION_MS); });
    expect(onReorder).not.toHaveBeenCalled();
    expect(rendered()).toEqual(names);
    expect(travel()).toBe('120px');

    await act(async () => { resolveWrite(); });
    expect(onReorder).toHaveBeenCalledExactlyOnceWith(0, 3);
    expect(rendered()).toEqual(['bravo', 'charlie', 'delta', 'alpha']);
    expect(offsets()).toEqual(['', '', '', '']);
  });

  it('rolls the preview back only when the asynchronous write fails', async () => {
    vi.useFakeTimers();
    let rejectWrite!: (error: Error) => void;
    const write = new Promise<void>((_, reject) => { rejectWrite = reject; });
    const onDropError = vi.fn();
    const onReorder = vi.fn();
    renderInApp(<List onDrop={() => write} onDropError={onDropError} onReorder={onReorder} />);

    press(grip('alpha'), 20);
    drag(150);
    release(150);
    const failure = new Error('write failed');
    rejectWrite(failure);
    await act(async () => { vi.advanceTimersByTime(REPOSITION_ANIMATION_MS); });

    expect(onDropError).toHaveBeenCalledExactlyOnceWith(failure, 0, 3);
    expect(onReorder).not.toHaveBeenCalled();
    expect(rendered()).toEqual(names);
    expect(offsets()).toEqual(['', '', '', '']);
  });

  it('abandons the previewed move on Escape and commits nothing', () => {
    vi.useFakeTimers();
    const onReorder = vi.fn();
    renderInApp(<List onReorder={onReorder} />);

    press(grip('alpha'), 20);
    drag(150);
    expect(offsets()[1]).toBe('translateY(-40px)');

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(offsets()).toEqual(['', '', '', '']);
    expect(travel()).toBe('');

    release(150);
    act(() => { vi.advanceTimersByTime(REPOSITION_ANIMATION_MS); });
    expect(onReorder).not.toHaveBeenCalled();
    expect(rendered()).toEqual(names);
  });
});

it('keeps the grabbed point after the start callback moves the list', () => {
  let shift = 200;
  const measurements = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this.hasAttribute('data-reorder-list')) return rect(shift, ROW * names.length);
    const item = this.closest('[data-reorder-item]');
    if (item !== null) return rect(shift + [...item.parentElement!.children].indexOf(item) * ROW, this === item ? ROW : 24);
    return original.call(this);
  });
  try {
    renderInApp(<List onDragStart={() => { shift = 0; }} onReorder={vi.fn()} />);
    press(grip('charlie'), 200 + ROW * 2 + 12);
    drag(ROW + 12);
    expect(travel()).toBe('-40px');
    expect(ranks()).toEqual(['0', '2', '1', '3']);
    fireEvent.keyDown(window, { key: 'Escape' });
  } finally { measurements.mockRestore(); }
});

it('does not reorder when a start callback collapses content above the row without pointer travel', () => {
  const [name, index] = ['charlie', 2] as const;
  vi.useFakeTimers();
  let gap = 200;
  const measurements = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this.hasAttribute('data-reorder-list')) return rect(0, ROW * names.length);
    const item = this.closest('[data-reorder-item]');
    if (item !== null) {
      const itemIndex = [...item.parentElement!.children].indexOf(item);
      const top = itemIndex * ROW + (itemIndex > 0 ? gap : 0);
      return rect(top, this === item ? ROW : 24);
    }
    return original.call(this);
  });
  try {
    const onReorder = vi.fn();
    renderInApp(<List onDragStart={() => { gap = 0; }} onReorder={onReorder} />);
    const pointerY = index * ROW + 200 + 12;
    press(grip(name), pointerY);
    release(pointerY);
    act(() => { vi.advanceTimersByTime(REPOSITION_ANIMATION_MS); });
    expect(onReorder).not.toHaveBeenCalled();
    expect(rendered()).toEqual(names);
  } finally { measurements.mockRestore(); }
});
