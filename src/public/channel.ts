/**
 * Bridges push-based producers (custom tool side effects, SDK stream messages)
 * into one ordered async iterable. Tool `execute` callbacks fire from inside the
 * SDK's own loop, so without a buffer their events would race the stream.
 */
export type Channel<T> = {
  emit(value: T): void;
  close(): void;
  stream(): AsyncIterable<T>;
};

export function createChannel<T>(): Channel<T> {
  const pending: T[] = [];
  const waiters: Array<(value: T | null) => void> = [];
  let closed = false;

  return {
    emit(value: T): void {
      if (closed) return;
      const wake = waiters.shift();
      if (wake) {
        wake(value);
        return;
      }
      pending.push(value);
    },

    close(): void {
      closed = true;
      while (waiters.length > 0) waiters.shift()?.(null);
    },

    stream(): AsyncIterable<T> {
      return {
        async *[Symbol.asyncIterator]() {
          for (;;) {
            if (pending.length > 0) {
              yield pending.shift() as T;
              continue;
            }
            if (closed) return;
            const next = await new Promise<T | null>((resolve) =>
              waiters.push(resolve),
            );
            if (next === null) return;
            yield next;
          }
        },
      };
    },
  };
}
