function positiveInteger(value, field) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${field} must be a positive integer`);
  return value;
}

export class AutomationLoop {
  constructor({
    runtime,
    persist = async () => {},
    onCycle = async () => {},
    intervalMs = 5000,
    now = () => new Date(),
    logger = console,
    setIntervalImpl = setInterval,
    clearIntervalImpl = clearInterval
  }) {
    if (!runtime || typeof runtime.evaluate !== 'function' || typeof runtime.snapshot !== 'function') {
      throw new Error('runtime with evaluate() and snapshot() is required');
    }
    if (typeof persist !== 'function') throw new Error('persist must be a function');
    if (typeof onCycle !== 'function') throw new Error('onCycle must be a function');
    this.runtime = runtime;
    this.persist = persist;
    this.onCycle = onCycle;
    this.intervalMs = positiveInteger(intervalMs, 'intervalMs');
    this.now = now;
    this.logger = logger;
    this.setIntervalImpl = setIntervalImpl;
    this.clearIntervalImpl = clearIntervalImpl;
    this.timer = null;
    this.currentCycle = null;
    this.metrics = {
      cycles: 0,
      skipped_cycles: 0,
      failed_cycles: 0,
      commands_created: 0,
      last_started_at: null,
      last_completed_at: null,
      last_error: null
    };
  }

  get running() {
    return this.timer !== null;
  }

  status() {
    return {
      running: this.running,
      cycle_in_flight: this.currentCycle !== null,
      interval_ms: this.intervalMs,
      ...structuredClone(this.metrics)
    };
  }

  async runCycle() {
    if (this.currentCycle) {
      this.metrics.skipped_cycles += 1;
      return { skipped: true, reason: 'cycle already in flight', commands: [] };
    }
    const operation = this.executeCycle();
    this.currentCycle = operation;
    try {
      return await operation;
    } finally {
      if (this.currentCycle === operation) this.currentCycle = null;
    }
  }

  async executeCycle() {
    const before = this.runtime.snapshot();
    this.metrics.last_started_at = this.now().toISOString();
    try {
      const commands = this.runtime.evaluate();
      const snapshot = this.runtime.snapshot();
      await this.persist(snapshot);
      this.metrics.cycles += 1;
      this.metrics.commands_created += commands.length;
      this.metrics.last_completed_at = this.now().toISOString();
      this.metrics.last_error = null;
      try {
        await this.onCycle({ commands: structuredClone(commands), snapshot, status: this.status() });
      } catch (error) {
        this.logger.error?.('GreenCore automation cycle notification failed', error);
      }
      return { skipped: false, commands };
    } catch (error) {
      this.runtime.restore(before, { logEvent: false });
      this.metrics.failed_cycles += 1;
      this.metrics.last_completed_at = this.now().toISOString();
      this.metrics.last_error = error.message;
      throw error;
    }
  }

  start({ immediate = true } = {}) {
    if (this.running) return false;
    this.timer = this.setIntervalImpl(() => {
      void this.runCycle().catch(error => this.logger.error?.('GreenCore automation cycle failed', error));
    }, this.intervalMs);
    this.timer.unref?.();
    if (immediate) void this.runCycle().catch(error => this.logger.error?.('GreenCore automation cycle failed', error));
    return true;
  }

  async stop() {
    if (this.timer !== null) {
      this.clearIntervalImpl(this.timer);
      this.timer = null;
    }
    if (this.currentCycle) await this.currentCycle.catch(() => {});
  }
}
