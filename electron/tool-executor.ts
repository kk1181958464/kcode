import { AsyncQueue } from "./async-queue";

/** Runs a tool operation while coalescing progress updates for the Agent loop. */
export async function* executeWithProgress<T>(
  operation: (report: (output: string) => void) => Promise<T>,
): AsyncGenerator<string, T> {
  const queue = new AsyncQueue<string>();
  let result: T | undefined;
  const report = (output: string) => queue.pushLatest(output);
  void operation(report)
    .then((value) => {
      result = value;
      queue.close();
    })
    .catch((error) => queue.fail(error));
  for await (const output of queue) yield output;
  return result as T;
}
