/**
 * Hàng đợi xử lý tài liệu, chạy trong tiến trình web.
 *
 * Vì sao cần: OCR một tài liệu scan mất vài chục giây đến vài phút và tốn bộ nhớ.
 * Nếu nhiều file được tải lên cùng lúc mà xử lý song song, instance Render Free
 * (512 MB RAM, dưới 1 CPU) sẽ hết bộ nhớ và bị khởi động lại, làm tài liệu
 * treo mãi ở trạng thái "đang xử lý".
 *
 * Hàng đợi này giới hạn số việc chạy đồng thời và độ dài hàng chờ. Khi lên
 * production thật nên thay bằng Background Worker riêng trên Render.
 */

const CONCURRENCY = Number(process.env.WORKER_CONCURRENCY || 1);
const MAX_QUEUE = Number(process.env.WORKER_MAX_QUEUE || 20);

const pending = [];
let running = 0;

export class QueueFullError extends Error {
  constructor() {
    super('Hệ thống đang xử lý nhiều tài liệu khác. Vui lòng thử lại sau vài phút.');
    this.name = 'QueueFullError';
  }
}

/**
 * Đưa một việc vào hàng đợi. Trả về Promise kết thúc khi việc chạy xong.
 * Ném QueueFullError ngay nếu hàng chờ đã đầy.
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

/** Trạng thái hàng đợi, dùng cho trang sức khoẻ hệ thống. */
export function queueStats() {
  return {
    running,
    waiting: pending.length,
    concurrency: CONCURRENCY,
    max_queue: MAX_QUEUE,
    waiting_labels: pending.slice(0, 10).map((j) => j.label),
  };
}
