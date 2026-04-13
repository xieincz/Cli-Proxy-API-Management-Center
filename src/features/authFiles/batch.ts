export const MAX_AUTH_FILES_BATCH_CONCURRENCY = 10;

export type BatchProgressState = {
  active: boolean;
  label: string;
  completed: number;
  total: number;
};

export const IDLE_BATCH_PROGRESS_STATE: BatchProgressState = {
  active: false,
  label: '',
  completed: 0,
  total: 0,
};

export type BatchTaskResult<TItem, TResult> =
  | {
      item: TItem;
      index: number;
      status: 'fulfilled';
      value: TResult;
    }
  | {
      item: TItem;
      index: number;
      status: 'rejected';
      reason: unknown;
    };

type RunBatchTasksOptions<TItem, TResult> = {
  items: TItem[];
  worker: (item: TItem, index: number) => Promise<TResult>;
  concurrency?: number;
  onProgress?: (progress: { completed: number; total: number; item: TItem; index: number }) => void;
};

export async function runBatchTasks<TItem, TResult>(
  options: RunBatchTasksOptions<TItem, TResult>
): Promise<Array<BatchTaskResult<TItem, TResult>>> {
  const { items, worker, concurrency = MAX_AUTH_FILES_BATCH_CONCURRENCY, onProgress } = options;

  if (items.length === 0) return [];

  const results = new Array<BatchTaskResult<TItem, TResult>>(items.length);
  const total = items.length;
  const workerCount = Math.max(1, Math.min(total, concurrency));
  let nextIndex = 0;
  let completed = 0;

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        if (currentIndex >= total) return;

        const item = items[currentIndex];

        try {
          const value = await worker(item, currentIndex);
          results[currentIndex] = {
            item,
            index: currentIndex,
            status: 'fulfilled',
            value,
          };
        } catch (reason: unknown) {
          results[currentIndex] = {
            item,
            index: currentIndex,
            status: 'rejected',
            reason,
          };
        } finally {
          completed += 1;
          onProgress?.({ completed, total, item, index: currentIndex });
        }
      }
    })
  );

  return results;
}
