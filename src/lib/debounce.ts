// A trailing debouncer with explicit flush/cancel — used to coalesce issue-body
// PATCHes (~3s after the last state change). Kept tiny and injectable so it can
// be driven by fake timers in tests.

export interface Debouncer {
  schedule(): void;
  flush(): void;
  cancel(): void;
  pending(): boolean;
}

export function createDebouncer(fn: () => void, ms: number): Debouncer {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  return {
    schedule() {
      clear();
      timer = setTimeout(() => {
        timer = undefined;
        fn();
      }, ms);
    },
    flush() {
      if (timer !== undefined) {
        clear();
        fn();
      }
    },
    cancel: clear,
    pending: () => timer !== undefined,
  };
}
