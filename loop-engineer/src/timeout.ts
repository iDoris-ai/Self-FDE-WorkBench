/**
 * 超时执行工具（契约 v2 · Q2:每 job 超时上限 → failed）。
 *
 * 给 `fn` 一个 AbortSignal;超过 `ms` 就 abort 它(fn 有责任监听 signal 及时收手,
 * 如 kill 子进程),并等 fn 真正结束(让其 finally 清理 worktree 后)再返回 timedOut。
 * ms ≤ 0 或非有限 → 不设超时(signal 永不 abort)。
 */
export interface TimeoutResult<T> {
  timedOut: boolean;
  value?: T;
  error?: unknown;
}

export async function runWithTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  ms: number,
): Promise<TimeoutResult<T>> {
  const ctrl = new AbortController();
  let timedOut = false;
  const armed = Number.isFinite(ms) && ms > 0;
  const timer = armed
    ? setTimeout(() => {
        timedOut = true;
        ctrl.abort();
      }, ms)
    : undefined;
  try {
    const value = await fn(ctrl.signal);
    return { timedOut: false, value };
  } catch (error) {
    // fn 抛错:若正是我们 abort 触发的,标 timedOut;否则是普通失败
    return { timedOut, error };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
