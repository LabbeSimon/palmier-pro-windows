/**
 * Runs async work over a list with a fixed number of workers.
 *
 * The first failure stops the pool: no new item starts, the items already
 * running are left to finish (the caller cancels them if it wants to), and the
 * error is what the pool rejects with. Silently carrying on past a failed
 * slice would hand back a preview with a hole in it.
 */
export async function runPool<T>(
  items: readonly T[],
  jobs: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0
  let failure: { error: unknown } | null = null

  const lane = async () => {
    while (!failure && next < items.length) {
      const index = next++
      try {
        await worker(items[index]!, index)
      } catch (error) {
        failure ??= { error }
      }
    }
  }

  const lanes = Math.max(1, Math.min(jobs, items.length))
  await Promise.all(Array.from({ length: lanes }, lane))
  if (failure) throw (failure as { error: unknown }).error
}
