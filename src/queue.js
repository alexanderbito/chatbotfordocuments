/**
 * In-process document-processing queue.
 *
 * Why it exists: running OCR over a scanned document takes tens of seconds to
 * several minutes and is memory-hungry. Processing a batch of uploads in
 * parallel would exhaust a small instance (512 MB RAM, under 1 CPU), restart it,
 * and leave documents stuck in "processing" forever.
 *
 * The queue caps both concurrency and queue depth. At real production volume
 * this should be replaced by a dedicated background worker.
 */

const CONCURRENCY = Number(process.env.WORKER_CONCURRENCY || 1);
const MAX_QUEUE = Number(process.env.WORKER_MAX_QUEUE || 20);

const pending = [];
let running = 0;

export class QueueFullError extends Error {
  constructor() {
    super('The system is busy processing other documents. Please try again in a few minutes.');
    this.name = 'QueueFullError';
  }
}

/**
 * Enqueue a job. Resolves when the job finishes.
 * Throws QueueFullError immediately when the queue is already full.
 */
export function enqueue(label, task) {
  if (pending.length >= MAX_QUEUE) throw new QueueFullError();

  return new Promise((resolve, reject) => {
    pending.push({ label, task, resolve, reject, queuedAt: Date.now() });
    drain();
  });
}

function drain() {
  while (running < CONCURRENCY && pending.length) {
    const job = pending.shift();
    running++;
    Promise.resolve()
      .then(job.task)
      .then(job.resolve, job.reject)
      .finally(() => {
        running--;
        drain();
      });
  }
}

/** Queue state, surfaced on the system-health page. */
export function queueStats() {
  return {
    running,
    waiting: pending.length,
    concurrency: CONCURRENCY,
    max_queue: MAX_QUEUE,
    waiting_labels: pending.slice(0, 10).map((j) => j.label),
  };
}
