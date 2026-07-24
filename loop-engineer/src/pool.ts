/**
 * W7 — 有界并发池，带「同 key 互斥」（一个 key 同时最多一个任务在跑）。
 *
 * 契约 v2 · B1:v1 默认串行(maxConcurrency=1);一场 Mini 几十个想法可调高并发。
 * 关键安全约束:同一 repo 的 job 绝不并发(worktree / 集成分支会互相踩),故以 repo 作 key,
 * 按 key 串行、跨 key 并行。maxConcurrency 用函数取值 → 运行时可改环境变量即时生效。
 */
export interface PoolTask {
  id: string;
  key: string;
  run: () => Promise<void>;
}

export interface Pool {
  /** 提交一个任务。同 id 已在队/在跑则忽略(幂等)。 */
  submit(task: PoolTask): void;
  /** 在队或在跑。 */
  isActive(id: string): boolean;
  /** 正在跑。 */
  isRunning(id: string): boolean;
  /** 队列位置:0=正在跑/不在队,>=1=排队中的 1-based 名次。 */
  queuePos(id: string): number;
  /** 观测:当前在跑数 / 排队数。 */
  stats(): { running: number; queued: number };
}

export function createPool(maxConcurrency: () => number): Pool {
  const queue: PoolTask[] = [];
  const inFlight = new Set<string>(); // 在跑的 id
  const inFlightKeys = new Set<string>(); // 在跑的 key（同 key 互斥）
  let running = 0;

  function pump(): void {
    const max = Math.max(1, maxConcurrency());
    for (let i = 0; i < queue.length && running < max; ) {
      const item = queue[i];
      if (inFlightKeys.has(item.key)) {
        i++; // 同 key 已在跑 → 跳过,留队里等
        continue;
      }
      queue.splice(i, 1);
      inFlight.add(item.id);
      inFlightKeys.add(item.key);
      running += 1;
      void exec(item);
    }
  }

  async function exec(item: PoolTask): Promise<void> {
    try {
      await item.run();
    } finally {
      running -= 1;
      inFlight.delete(item.id);
      inFlightKeys.delete(item.key);
      pump();
    }
  }

  return {
    submit(task: PoolTask): void {
      if (inFlight.has(task.id) || queue.some((q) => q.id === task.id)) return;
      queue.push(task);
      pump();
    },
    isActive(id: string): boolean {
      return inFlight.has(id) || queue.some((q) => q.id === id);
    },
    isRunning(id: string): boolean {
      return inFlight.has(id);
    },
    queuePos(id: string): number {
      const i = queue.findIndex((q) => q.id === id);
      return i < 0 ? 0 : i + 1;
    },
    stats() {
      return { running, queued: queue.length };
    },
  };
}
