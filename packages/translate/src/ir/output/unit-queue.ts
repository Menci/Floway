// The queue's own link, so the units it carries stay plain values.
interface QueuedNode<T> {
  readonly value: T;
  next?: QueuedNode<T>;
}

// Units wait here until the writer can open them, and are opened in output IR order.
export const createIRUnitQueue = <T>() => {
  let head: QueuedNode<T> | undefined;
  let tail: QueuedNode<T> | undefined;
  return {
    get head(): T | undefined { return head?.value; },
    enqueue: (unit: T): void => {
      const node: QueuedNode<T> = { value: unit };
      if (tail === undefined) head = node;
      else tail.next = node;
      tail = node;
    },
    // Removes the head unit, which the caller has just opened or discarded.
    dropHead: (): void => {
      head = head!.next;
      if (head === undefined) tail = undefined;
    },
  };
};

export type IRUnitQueue<T> = ReturnType<typeof createIRUnitQueue<T>>;
