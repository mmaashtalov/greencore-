function positiveInteger(value, field) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${field} must be a positive integer`);
  return parsed;
}

function nonNegativeInteger(value, field) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${field} must be a non-negative integer`);
  return parsed;
}

function overloadedError(retryAfterSeconds) {
  const error = new Error('Simulation service is overloaded');
  error.statusCode = 503;
  error.retryAfterSeconds = retryAfterSeconds;
  return error;
}

export class SimulationScheduler {
  constructor({
    maxConcurrent = 1,
    maxQueued = 4,
    retryAfterSeconds = 2,
    now = () => Date.now(),
    schedule = callback => setImmediate(callback)
  } = {}) {
    this.maxConcurrent = positiveInteger(maxConcurrent, 'maxConcurrent');
    this.maxQueued = nonNegativeInteger(maxQueued, 'maxQueued');
    this.retryAfterSeconds = positiveInteger(retryAfterSeconds, 'retryAfterSeconds');
    this.now = now;
    this.schedule = schedule;
    this.active = 0;
    this.queue = [];
    this.closed = false;
    this.sequence = 0;
    this.metrics = {
      accepted: 0,
      completed: 0,
      failed: 0,
      rejected: 0,
      max_observed_queue: 0,
      last_started_at: null,
      last_completed_at: null,
      last_duration_ms: null,
      last_error: null
    };
  }

  submit(label, task) {
    if (this.closed) {
      const error = new Error('Simulation scheduler is closed');
      error.statusCode = 503;
      error.retryAfterSeconds = this.retryAfterSeconds;
      return Promise.reject(error);
    }
    if (typeof task !== 'function') return Promise.reject(new Error('task must be a function'));
    if (this.active >= this.maxConcurrent && this.queue.length >= this.maxQueued) {
      this.metrics.rejected += 1;
      return Promise.reject(overloadedError(this.retryAfterSeconds));
    }

    const id = ++this.sequence;
    this.metrics.accepted += 1;
    return new Promise((resolve, reject) => {
      this.queue.push({ id, label: String(label ?? 'simulation'), task, resolve, reject, queuedAt: Number(this.now()) });
      this.metrics.max_observed_queue = Math.max(this.metrics.max_observed_queue, this.queue.length);
      this.pump();
    });
  }

  pump() {
    while (!this.closed && this.active < this.maxConcurrent && this.queue.length > 0) {
      const item = this.queue.shift();
      this.active += 1;
      this.schedule(() => void this.execute(item));
    }
  }

  async execute(item) {
    const startedAt = Number(this.now());
    this.metrics.last_started_at = new Date(startedAt).toISOString();
    try {
      const value = await item.task();
      this.metrics.completed += 1;
      this.metrics.last_error = null;
      item.resolve(value);
    } catch (error) {
      this.metrics.failed += 1;
      this.metrics.last_error = error.message;
      item.reject(error);
    } finally {
      const completedAt = Number(this.now());
      this.metrics.last_completed_at = new Date(completedAt).toISOString();
      this.metrics.last_duration_ms = Math.max(0, completedAt - startedAt);
      this.active -= 1;
      this.pump();
    }
  }

  status() {
    return {
      active: this.active,
      queued: this.queue.length,
      max_concurrent: this.maxConcurrent,
      max_queued: this.maxQueued,
      closed: this.closed,
      ...this.metrics
    };
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    const error = new Error('Simulation scheduler closed before task execution');
    error.statusCode = 503;
    while (this.queue.length > 0) this.queue.shift().reject(error);
  }
}

export { overloadedError };
