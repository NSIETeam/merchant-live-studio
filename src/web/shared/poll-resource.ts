/** Serial polling with a deadline and cancellation of superseded results. */
export function pollResource<T>(options: {
  read: (signal: AbortSignal) => Promise<T>;
  onValue: (value: T) => void;
  onError: (error: Error) => void;
  intervalMs: number;
  timeoutMs: number;
  timeoutMessage?: string;
}) {
  let stopped = false;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  const cancel = () => {
    generation++;
    clearTimeout(timer);
    clearTimeout(deadline);
    controller?.abort();
  };
  const refresh = () => {
    if (stopped) return;
    cancel();
    const current = generation;
    const request = new AbortController();
    controller = request;
    const finish = (deliver: () => void) => {
      if (stopped || current !== generation) return;
      generation++;
      clearTimeout(deadline);
      request.abort();
      deliver();
      if (!stopped) timer = setTimeout(refresh, options.intervalMs);
    };
    deadline = setTimeout(
      () =>
        finish(() =>
          options.onError(
            new Error(options.timeoutMessage || "讲稿核对超时，请检查网络；重新核对成功后恢复展示。"),
          ),
        ),
      options.timeoutMs,
    );
    void Promise.resolve()
      .then(() => {
        if (stopped || current !== generation) return;
        return options.read(request.signal).then(
          (value) => finish(() => options.onValue(value)),
          (error) =>
            finish(() =>
              options.onError(
                error instanceof Error ? error : new Error(String(error)),
              ),
            ),
        );
      })
      .catch((error) =>
        finish(() =>
          options.onError(
            error instanceof Error ? error : new Error(String(error)),
          ),
        ),
      );
  };
  refresh();
  return {
    refresh,
    pause() {
      cancel();
    },
    stop() {
      stopped = true;
      cancel();
    },
  };
}
