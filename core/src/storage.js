import crypto from 'node:crypto';
import path from 'node:path';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';

const STORAGE_SCHEMA_VERSION = 1;

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export class JsonStateStore {
  constructor({ filePath, now = () => new Date() }) {
    if (typeof filePath !== 'string' || filePath.length === 0) {
      throw new Error('State file path is required');
    }
    this.filePath = path.resolve(filePath);
    this.now = now;
    this.queue = Promise.resolve();
  }

  async load() {
    let raw;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return { status: 'missing', state: null };
      throw error;
    }

    try {
      const envelope = JSON.parse(raw);
      if (!isObject(envelope) || envelope.schema_version !== STORAGE_SCHEMA_VERSION) {
        throw new Error('Unsupported state storage schema');
      }
      if (!isObject(envelope.state) || Number.isNaN(new Date(envelope.saved_at).getTime())) {
        throw new Error('Invalid state storage envelope');
      }
      return {
        status: 'loaded',
        state: envelope.state,
        savedAt: envelope.saved_at
      };
    } catch (error) {
      const quarantinePath = await this.quarantine();
      return {
        status: 'corrupt',
        state: null,
        quarantinePath,
        error: error.message
      };
    }
  }

  async save(state) {
    if (!isObject(state)) throw new Error('State must be an object');
    const envelope = {
      schema_version: STORAGE_SCHEMA_VERSION,
      saved_at: this.now().toISOString(),
      state: structuredClone(state)
    };
    const operation = this.queue.catch(() => {}).then(() => this.writeEnvelope(envelope));
    this.queue = operation;
    return operation;
  }

  async writeEnvelope(envelope) {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    let handle;
    try {
      handle = await open(tempPath, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(envelope, null, 2)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(tempPath, this.filePath);
      return { filePath: this.filePath, savedAt: envelope.saved_at };
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      await unlink(tempPath).catch(() => {});
      throw error;
    }
  }

  async quarantine() {
    const suffix = this.now().toISOString().replaceAll(':', '-');
    const target = `${this.filePath}.corrupt-${suffix}-${crypto.randomUUID()}`;
    try {
      await rename(this.filePath, target);
      return target;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async flush() {
    return this.queue;
  }
}
