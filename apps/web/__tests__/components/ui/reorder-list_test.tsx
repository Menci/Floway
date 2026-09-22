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
const List = ({ busy = false, onDrop, onDropError, onReorder, orderable = names.length }: {
  busy?: boolean;
  onDrop?: (from: number, to: number) => Promise<void>;
  onDropError?: (error: unknown, from: number, to: number) => void | Promise<void>;
  onReorder: (from: number, to: number) => void;
  orderable?: number;
}) => {
  const [items, setItems] = useState(names);
  const reorder = useReorderList({
    busy,
    length: orderable,
    onDrop,
    onDropError,
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

const Locked = ({ onReorder }: { onReorder: (from: number, to: number) => void }) => {
  const reorder = useReorderList({ busy: true, length: names.length, onReorder });
  return <ul {...reorder.listProps()}>
    {names.map((name, index) => <Row handle={reorder.handleProps(index)} key={name} name={name} props={reorder.itemProps(index)} rank={reorder.position(index)} />)}
  </ul>;
};

const Row = ({ handle, name, props, rank }: { handle: ReorderHandleProps; name: string; props: object; rank: number }) =>
  <li {...props} data-name={name} data-rank={rank}><ReorderHandle {...handle} label={`Reorder ${name}`} /></li>;

const items = () => [...document.querySelectorAll('li')];
const rendered = () => items().map(item => item.getAttribute('data-name'));
const offsets = () => items().map(item => item.style.transform);
const ranks = () => items().map(item => item.getAttribute('data-rank'));
const edges = () => items().map(item => item.getAttribute('data-reorder-edge'));
const travel = () => document.querySelector<HTMLElement>('[data-reorder-list]')!.style.getPropertyValue('--floway-reorder-drag-y');

const grip = (name: string) => screen.getByRole('button', { name: `Reorder ${name}` });

const press = (element: HTMLElement, clientY: number) =>
  fireEvent.pointerDown(element, { button: 0, clientY, isPrimary: true, pointerId: 1 });

// The gesture reads the window: Escape has to be heard wherever focus is.
const drag = (clientY: number) => fireEvent.pointerMove(window, { clientY, pointerId: 1 });
const release = (clientY: number) => fireEvent.pointerUp(window, { clientY, pointerId: 1 });

describe('drag-to-position reordering', () => {
  it('moves the rows with transforms and leaves the list in its committed order', () => {
    const onReorder = vi.fn();
    renderInApp(<List onReorder={onReorder} />);

    press(grip('alpha'), 20);
    // Picked up but not yet moved: the rows hold their own slots.
    expect(offsets()).toEqual([
      'translateY(var(--floway-reorder-drag-y, 0px))',
      'translateY(0px)',
      'translateY(0px)',
      'translateY(0px)',
    ]);

    // Past the midpoint of the last row, so the item lands after all of them
    // and the three it passed each rise by one row.
    drag(150);
    expect(offsets()).toEqual([
      'translateY(var(--floway-reorder-drag-y, 0px))',
      'translateY(-40px)',
      'translateY(-40px)',
      'translateY(-40px)',
    ]);
    // Nothing has been reordered yet: the rows are where they were, drawn elsewhere.
    expect(rendered()).toEqual(names);
    // The rank travels with the row so the list reads as the drop will commit.
    expect(ranks()).toEqual(['3', '0', '1', '2']);
    // And so does the list's edge, which is what a separator drawn from the ends
    // has to follow once the rows stop matching the markup.
    expect(edges()).toEqual(['last', 'first', null, null]);
  });

  it('tracks the pointer while it is down and clamps the row inside the list', () => {
    renderInApp(<List onReorder={vi.fn()} />);

    press(grip('alpha'), 20);
    expect(travel()).toBe('0px');
    drag(60);
    expect(travel()).toBe('40px');
    // The row cannot leave the list: three rows below it is as far as it goes.
    drag(400);
    expect(travel()).toBe('120px');
    // Clamped where it is painted, so coming back reads from the pointer again.
    drag(70);
    expect(travel()).toBe('50px');
  });

  it('settles the row onto its slot before reporting the move', () => {
    vi.useFakeTimers();
    const onReorder = vi.fn();
    renderInApp(<List onReorder={onReorder} />);

    press(grip('alpha'), 20);
    drag(150);
    release(150);
    // The pointer is gone and the row travels the rest of the way on its own.
    expect(travel()).toBe('120px');
    expect(onReorder).not.toHaveBeenCalled();

    act(() => { vi.advanceTimersByTime(REPOSITION_ANIMATION_MS); });
    expect(onReorder).toHaveBeenCalledExactlyOnceWith(0, 3);
    expect(rendered()).toEqual(['bravo', 'charlie', 'delta', 'alpha']);
    expect(offsets()).toEqual(['', '', '', '']);
  });

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

  it('takes the row it is over only once the pointer is past that row midpoint', () => {
    vi.useFakeTimers();
    const onReorder = vi.fn();
    renderInApp(<List onReorder={onReorder} />);

    press(grip('alpha'), 20);
    drag(55);
    expect(ranks()).toEqual(['0', '1', '2', '3']);

    drag(60);
    expect(ranks()).toEqual(['1', '0', '2', '3']);

    release(60);
    act(() => { vi.advanceTimersByTime(REPOSITION_ANIMATION_MS); });
    expect(onReorder).toHaveBeenCalledExactlyOnceWith(0, 1);
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

  it('travels between the grips on the bare arrows, as a list travels between its items', () => {
    const onReorder = vi.fn();
    renderInApp(<List onReorder={onReorder} />);

    grip('charlie').focus();
    fireEvent.keyDown(grip('charlie'), { key: 'ArrowUp' });
    expect(document.activeElement).toBe(grip('bravo'));
    fireEvent.keyDown(grip('bravo'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(grip('charlie'));

    // The ends hold rather than wrap, and nothing has been reordered.
    grip('alpha').focus();
    fireEvent.keyDown(grip('alpha'), { key: 'ArrowUp' });
    expect(document.activeElement).toBe(grip('alpha'));
    expect(onReorder).not.toHaveBeenCalled();
    expect(rendered()).toEqual(names);
  });

  it('reorders one step on the chord XAML reserves for it', () => {
    const onReorder = vi.fn();
    renderInApp(<List onReorder={onReorder} />);

    fireEvent.keyDown(grip('charlie'), { altKey: true, key: 'ArrowUp', shiftKey: true });
    expect(onReorder).toHaveBeenCalledExactlyOnceWith(2, 1);
    expect(rendered()).toEqual(['alpha', 'charlie', 'bravo', 'delta']);

    // The end of the list, and the chord XAML excludes Control from.
    fireEvent.keyDown(grip('delta'), { altKey: true, key: 'ArrowDown', shiftKey: true });
    fireEvent.keyDown(grip('bravo'), { altKey: true, ctrlKey: true, key: 'ArrowUp', shiftKey: true });
    expect(onReorder).toHaveBeenCalledOnce();
  });

  it('leaves the grip a list has locked reachable but unable to move its row', () => {
    const onReorder = vi.fn();
    renderInApp(<Locked onReorder={onReorder} />);

    grip('charlie').focus();
    fireEvent.keyDown(grip('charlie'), { key: 'ArrowUp' });
    expect(document.activeElement).toBe(grip('bravo'));

    fireEvent.keyDown(grip('bravo'), { altKey: true, key: 'ArrowUp', shiftKey: true });
    expect(onReorder).not.toHaveBeenCalled();
  });

  it('stops at the last ordered item when the list leaves the rest out of its order', () => {
    vi.useFakeTimers();
    const onReorder = vi.fn();
    renderInApp(<List onReorder={onReorder} orderable={2} />);

    expect(grip('charlie').hasAttribute('disabled')).toBe(true);
    // And a disabled grip is not a stop the arrows travel through.
    grip('alpha').focus();
    fireEvent.keyDown(grip('alpha'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(grip('bravo'));
    fireEvent.keyDown(grip('bravo'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(grip('bravo'));

    press(grip('alpha'), 20);
    // Over the unordered rows, which the gesture never measured.
    release(150);
    act(() => { vi.advanceTimersByTime(REPOSITION_ANIMATION_MS); });
    expect(onReorder).toHaveBeenCalledExactlyOnceWith(0, 1);
    expect(rendered()).toEqual(['bravo', 'alpha', 'charlie', 'delta']);
  });
});
