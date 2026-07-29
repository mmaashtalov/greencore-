import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const TERMINAL_COMMAND_EVENTS = new Map([
  ['COMMAND_EXPIRED_WITHOUT_ACK', 'EXPIRED'],
  ['COMMAND_DROPPED_ON_RESTORE_EXPIRED', 'EXPIRED']
]);

function positiveInteger(value, field) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${field} must be a positive integer`);
  return value;
}

function validDate(value, field) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`${field} must be a valid date`);
  return parsed.toISOString();
}

function json(value) {
  return JSON.stringify(value ?? null);
}

function parseJson(value) {
  return value === null || value === undefined ? null : JSON.parse(value);
}

function normalizeLimit(value, { defaultValue = 100, maximum = 1000 } = {}) {
  if (value === undefined || value === null) return defaultValue;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`limit must be an integer from 1 to ${maximum}`);
  }
  return parsed;
}

function queryConditions(filters, mapping) {
  const clauses = [];
  const parameters = [];
  for (const [filterName, columnName] of Object.entries(mapping)) {
    const value = filters[filterName];
    if (value === undefined || value === null || value === '') continue;
    clauses.push(`${columnName} = ?`);
    parameters.push(value);
  }
  if (filters.from) {
    clauses.push('timestamp >= ?');
    parameters.push(validDate(filters.from, 'from'));
  }
  if (filters.to) {
    clauses.push('timestamp <= ?');
    parameters.push(validDate(filters.to, 'to'));
  }
  return {
    sql: clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '',
    parameters
  };
}

export class SqliteHistoryStore {
  constructor({
    filePath,
    now = () => new Date(),
    limits = {}
  }) {
    if (typeof filePath !== 'string' || filePath.length === 0) throw new Error('filePath is required');
    this.filePath = filePath;
    this.now = now;
    this.limits = {
      telemetry: positiveInteger(limits.telemetry ?? 250000, 'telemetry limit'),
      events: positiveInteger(limits.events ?? 100000, 'events limit'),
      alerts: positiveInteger(limits.alerts ?? 50000, 'alerts limit'),
      commands: positiveInteger(limits.commands ?? 100000, 'commands limit'),
      policyDecisions: positiveInteger(limits.policyDecisions ?? 100000, 'policy decisions limit'),
      simulations: positiveInteger(limits.simulations ?? 1000, 'simulations limit')
    };
    this.lastError = null;
    this.lastCaptureAt = null;
    this.closed = false;

    if (filePath !== ':memory:') fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.database = new DatabaseSync(filePath);
    this.configure();
    this.migrate();
    this.prepareStatements();
  }

  configure() {
    this.database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA synchronous = NORMAL;
      PRAGMA journal_mode = WAL;
    `);
  }

  migrate() {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);
    let current = Number(this.database.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations').get().version);
    if (current < 1) {
      this.transaction(() => {
        this.database.exec(`
        CREATE TABLE telemetry_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp TEXT NOT NULL,
          received_at TEXT NOT NULL,
          controller_id TEXT,
          device_id TEXT NOT NULL,
          metric TEXT NOT NULL,
          value REAL NOT NULL,
          unit TEXT NOT NULL,
          quality TEXT NOT NULL,
          simulation_time TEXT,
          sample_json TEXT NOT NULL,
          UNIQUE(timestamp, device_id, metric)
        );
        CREATE INDEX telemetry_metric_timestamp_idx ON telemetry_history(metric, timestamp DESC);
        CREATE INDEX telemetry_device_timestamp_idx ON telemetry_history(device_id, timestamp DESC);

        CREATE TABLE event_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp TEXT NOT NULL,
          type TEXT NOT NULL,
          details_json TEXT NOT NULL,
          UNIQUE(timestamp, type, details_json)
        );
        CREATE INDEX event_type_timestamp_idx ON event_history(type, timestamp DESC);

        CREATE TABLE alert_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp TEXT NOT NULL,
          type TEXT NOT NULL,
          details_json TEXT NOT NULL,
          UNIQUE(timestamp, type, details_json)
        );
        CREATE INDEX alert_type_timestamp_idx ON alert_history(type, timestamp DESC);

        CREATE TABLE command_history (
          command_id TEXT PRIMARY KEY,
          controller_id TEXT,
          actuator_id TEXT NOT NULL,
          action TEXT NOT NULL,
          issued_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          status TEXT NOT NULL,
          reason TEXT,
          mode TEXT,
          acknowledged_at TEXT,
          details_json TEXT,
          command_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX command_status_issued_idx ON command_history(status, issued_at DESC);
        CREATE INDEX command_actuator_issued_idx ON command_history(actuator_id, issued_at DESC);

        CREATE TABLE simulation_reports (
          report_id TEXT PRIMARY KEY,
          created_at TEXT NOT NULL,
          type TEXT NOT NULL,
          kind TEXT NOT NULL,
          name TEXT NOT NULL,
          description TEXT,
          passed INTEGER,
          report_json TEXT NOT NULL
        );
        CREATE INDEX simulation_created_idx ON simulation_reports(created_at DESC);
        CREATE INDEX simulation_name_created_idx ON simulation_reports(name, created_at DESC);
        `);
        this.database.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)')
          .run(1, this.now().toISOString());
      });
      current = 1;
    }

    if (current < 2) {
      this.transaction(() => {
        this.database.exec(`
          CREATE TABLE policy_decision_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            decision_id TEXT NOT NULL UNIQUE,
            evaluated_at TEXT NOT NULL,
            captured_at TEXT NOT NULL,
            effect TEXT NOT NULL,
            policy_id TEXT,
            policy_version TEXT NOT NULL,
            summary TEXT NOT NULL,
            alert_type TEXT,
            actuator_id TEXT,
            action TEXT,
            source TEXT,
            command_json TEXT NOT NULL,
            evidence_json TEXT NOT NULL,
            decision_json TEXT NOT NULL
          );
          CREATE INDEX policy_decision_evaluated_idx ON policy_decision_history(evaluated_at DESC);
          CREATE INDEX policy_decision_effect_idx ON policy_decision_history(effect, evaluated_at DESC);
          CREATE INDEX policy_decision_policy_idx ON policy_decision_history(policy_id, evaluated_at DESC);
        `);
        this.database.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)')
          .run(2, this.now().toISOString());
      });
    }
  }

  prepareStatements() {
    this.statements = {
      insertTelemetry: this.database.prepare(`
        INSERT OR IGNORE INTO telemetry_history(
          timestamp, received_at, controller_id, device_id, metric, value, unit, quality, simulation_time, sample_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      insertEvent: this.database.prepare(`
        INSERT OR IGNORE INTO event_history(timestamp, type, details_json) VALUES (?, ?, ?)
      `),
      insertAlert: this.database.prepare(`
        INSERT OR IGNORE INTO alert_history(timestamp, type, details_json) VALUES (?, ?, ?)
      `),
      upsertPolicyDecision: this.database.prepare(`
        INSERT INTO policy_decision_history(
          decision_id, evaluated_at, captured_at, effect, policy_id, policy_version,
          summary, alert_type, actuator_id, action, source, command_json, evidence_json, decision_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(decision_id) DO UPDATE SET
          evaluated_at = excluded.evaluated_at,
          captured_at = excluded.captured_at,
          effect = excluded.effect,
          policy_id = excluded.policy_id,
          policy_version = excluded.policy_version,
          summary = excluded.summary,
          alert_type = excluded.alert_type,
          actuator_id = excluded.actuator_id,
          action = excluded.action,
          source = excluded.source,
          command_json = excluded.command_json,
          evidence_json = excluded.evidence_json,
          decision_json = excluded.decision_json
      `),
      upsertCommand: this.database.prepare(`
        INSERT INTO command_history(
          command_id, controller_id, actuator_id, action, issued_at, expires_at, status,
          reason, mode, acknowledged_at, details_json, command_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(command_id) DO UPDATE SET
          controller_id = excluded.controller_id,
          actuator_id = excluded.actuator_id,
          action = excluded.action,
          issued_at = excluded.issued_at,
          expires_at = excluded.expires_at,
          status = excluded.status,
          reason = excluded.reason,
          mode = excluded.mode,
          acknowledged_at = COALESCE(excluded.acknowledged_at, command_history.acknowledged_at),
          details_json = COALESCE(excluded.details_json, command_history.details_json),
          command_json = excluded.command_json,
          updated_at = excluded.updated_at
      `),
      expireCommand: this.database.prepare(`
        UPDATE command_history SET status = ?, updated_at = ? WHERE command_id = ?
      `),
      upsertSimulation: this.database.prepare(`
        INSERT INTO simulation_reports(
          report_id, created_at, type, kind, name, description, passed, report_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(report_id) DO UPDATE SET
          created_at = excluded.created_at,
          type = excluded.type,
          kind = excluded.kind,
          name = excluded.name,
          description = excluded.description,
          passed = excluded.passed,
          report_json = excluded.report_json
      `)
    };
  }

  transaction(operation) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.database.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  upsertCommand(command, status, { acknowledgedAt = null, details = null } = {}) {
    if (!command?.command_id || !command?.actuator_id || !command?.action || !command?.issued_at || !command?.expires_at) return;
    this.statements.upsertCommand.run(
      command.command_id,
      command.controller_id ?? null,
      command.actuator_id,
      command.action,
      command.issued_at,
      command.expires_at,
      status,
      command.reason ?? null,
      command.mode ?? null,
      acknowledgedAt,
      details === null ? null : json(details),
      json(command),
      this.now().toISOString()
    );
  }

  upsertPolicyDecision(decision) {
    if (!decision?.decision_id || !decision?.evaluated_at || !decision?.effect || !decision?.policy_version || !decision?.summary) return;
    const command = decision.context?.command ?? {};
    this.statements.upsertPolicyDecision.run(
      decision.decision_id,
      decision.evaluated_at,
      this.now().toISOString(),
      decision.effect,
      decision.policy_id ?? null,
      decision.policy_version,
      decision.summary,
      decision.alert_type ?? null,
      command.actuator_id ?? null,
      command.action ?? null,
      command.source ?? null,
      json(command),
      json(decision.evidence ?? []),
      json(decision)
    );
  }

  captureRuntimeSnapshot(snapshot) {
    try {
      const capturedAt = this.now().toISOString();
      this.transaction(() => {
        for (const decision of snapshot?.policy_decisions ?? []) {
          this.upsertPolicyDecision(decision);
        }

        for (const sample of Object.values(snapshot?.telemetry ?? {})) {
          this.statements.insertTelemetry.run(
            sample.timestamp,
            capturedAt,
            snapshot?.device_owners?.[sample.device_id] ?? null,
            sample.device_id,
            sample.metric,
            sample.value,
            sample.unit,
            sample.quality,
            sample.simulation_time ?? null,
            json(sample)
          );
        }

        for (const event of snapshot?.events ?? []) {
          this.statements.insertEvent.run(event.timestamp, event.type, json(event.details));
          const terminalStatus = TERMINAL_COMMAND_EVENTS.get(event.type);
          const commandId = event.details?.command_id;
          if (terminalStatus && commandId) {
            this.statements.expireCommand.run(terminalStatus, capturedAt, commandId);
          }
        }

        for (const alert of snapshot?.alerts ?? []) {
          this.statements.insertAlert.run(alert.timestamp, alert.type, json(alert.details));
        }

        for (const command of snapshot?.pending_commands ?? []) {
          this.upsertCommand(command, command.delivery_status ?? 'QUEUED');
        }

        for (const completed of snapshot?.completed_command_acks ?? []) {
          this.upsertCommand(completed.command, completed.status, {
            acknowledgedAt: completed.acknowledged_at,
            details: completed.details
          });
        }

        this.pruneRuntimeHistory();
      });
      this.lastError = null;
      this.lastCaptureAt = capturedAt;
      return true;
    } catch (error) {
      this.lastError = error.message;
      return false;
    }
  }

  pruneById(table, limit) {
    this.database.prepare(`
      DELETE FROM ${table}
      WHERE id <= COALESCE((SELECT id FROM ${table} ORDER BY id DESC LIMIT 1 OFFSET ?), 0)
    `).run(limit);
  }

  pruneRuntimeHistory() {
    this.pruneById('telemetry_history', this.limits.telemetry);
    this.pruneById('event_history', this.limits.events);
    this.pruneById('alert_history', this.limits.alerts);
    this.pruneById('policy_decision_history', this.limits.policyDecisions);
    this.database.prepare(`
      DELETE FROM command_history
      WHERE command_id NOT IN (
        SELECT command_id FROM command_history ORDER BY issued_at DESC LIMIT ?
      )
    `).run(this.limits.commands);
  }

  saveSimulationSnapshot(snapshot) {
    if (!snapshot || snapshot.state_version !== 1 || !Array.isArray(snapshot.reports)) {
      throw new Error('Invalid simulation snapshot');
    }
    try {
      this.transaction(() => {
        for (const report of snapshot.reports) {
          this.statements.upsertSimulation.run(
            report.report_id,
            report.created_at,
            report.type,
            report.kind,
            report.name,
            report.description ?? null,
            report.passed === undefined || report.passed === null ? null : report.passed ? 1 : 0,
            json(report)
          );
        }
        this.database.prepare(`
          DELETE FROM simulation_reports
          WHERE report_id NOT IN (
            SELECT report_id FROM simulation_reports ORDER BY created_at DESC LIMIT ?
          )
        `).run(Math.min(snapshot.max_reports ?? this.limits.simulations, this.limits.simulations));
      });
      this.lastError = null;
    } catch (error) {
      this.lastError = error.message;
      throw error;
    }
  }

  loadSimulationSnapshot({ maxReports = 50 } = {}) {
    const bounded = Math.min(positiveInteger(maxReports, 'maxReports'), this.limits.simulations);
    const rows = this.database.prepare(`
      SELECT report_json FROM simulation_reports ORDER BY created_at DESC LIMIT ?
    `).all(bounded).reverse();
    return {
      state_version: 1,
      max_reports: bounded,
      reports: rows.map(row => parseJson(row.report_json))
    };
  }

  telemetry(filters = {}) {
    const limit = normalizeLimit(filters.limit, { defaultValue: 200, maximum: 5000 });
    const where = queryConditions(filters, {
      metric: 'metric',
      device_id: 'device_id',
      controller_id: 'controller_id',
      quality: 'quality'
    });
    const rows = this.database.prepare(`
      SELECT timestamp, received_at, controller_id, device_id, metric, value, unit, quality, simulation_time
      FROM telemetry_history${where.sql}
      ORDER BY timestamp DESC, id DESC LIMIT ?
    `).all(...where.parameters, limit);
    return rows;
  }

  events(filters = {}) {
    return this.eventLike('event_history', filters);
  }

  alerts(filters = {}) {
    return this.eventLike('alert_history', filters);
  }

  eventLike(table, filters) {
    const limit = normalizeLimit(filters.limit, { defaultValue: 200, maximum: 5000 });
    const where = queryConditions(filters, { type: 'type' });
    return this.database.prepare(`
      SELECT timestamp, type, details_json FROM ${table}${where.sql}
      ORDER BY timestamp DESC, id DESC LIMIT ?
    `).all(...where.parameters, limit).map(row => ({
      timestamp: row.timestamp,
      type: row.type,
      details: parseJson(row.details_json)
    }));
  }

  commands(filters = {}) {
    const limit = normalizeLimit(filters.limit, { defaultValue: 200, maximum: 5000 });
    const clauses = [];
    const parameters = [];
    for (const [filter, column] of Object.entries({
      status: 'status',
      actuator_id: 'actuator_id',
      controller_id: 'controller_id',
      action: 'action'
    })) {
      const value = filters[filter];
      if (value === undefined || value === null || value === '') continue;
      clauses.push(`${column} = ?`);
      parameters.push(value);
    }
    if (filters.from) {
      clauses.push('issued_at >= ?');
      parameters.push(validDate(filters.from, 'from'));
    }
    if (filters.to) {
      clauses.push('issued_at <= ?');
      parameters.push(validDate(filters.to, 'to'));
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    return this.database.prepare(`
      SELECT command_id, controller_id, actuator_id, action, issued_at, expires_at, status,
             reason, mode, acknowledged_at, details_json, command_json, updated_at
      FROM command_history${where}
      ORDER BY issued_at DESC LIMIT ?
    `).all(...parameters, limit).map(row => ({
      ...row,
      details: parseJson(row.details_json),
      command: parseJson(row.command_json),
      details_json: undefined,
      command_json: undefined
    }));
  }

  stats() {
    const counts = {};
    for (const table of ['telemetry_history', 'event_history', 'alert_history', 'policy_decision_history', 'command_history', 'simulation_reports']) {
      counts[table] = Number(this.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count);
    }
    const telemetryRange = this.database.prepare(`
      SELECT MIN(timestamp) AS oldest, MAX(timestamp) AS newest FROM telemetry_history
    `).get();
    const page = this.database.prepare('PRAGMA page_count').get();
    const pageSize = this.database.prepare('PRAGMA page_size').get();
    return {
      healthy: this.lastError === null,
      last_error: this.lastError,
      last_capture_at: this.lastCaptureAt,
      database_path: this.filePath,
      schema_version: 2,
      counts,
      telemetry_range: telemetryRange,
      approximate_bytes: Number(page.page_count) * Number(pageSize.page_size)
    };
  }

  policyDecisions(filters = {}) {
    const limit = normalizeLimit(filters.limit, { defaultValue: 100, maximum: 5000 });
    const clauses = [];
    const parameters = [];
    for (const [filter, column] of Object.entries({
      effect: 'effect',
      policy_id: 'policy_id',
      actuator_id: 'actuator_id',
      action: 'action'
    })) {
      const value = filters[filter];
      if (value === undefined || value === null || value === '') continue;
      clauses.push(`${column} = ?`);
      parameters.push(value);
    }
    if (filters.from) {
      clauses.push('evaluated_at >= ?');
      parameters.push(validDate(filters.from, 'from'));
    }
    if (filters.to) {
      clauses.push('evaluated_at <= ?');
      parameters.push(validDate(filters.to, 'to'));
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    return this.database.prepare(`
      SELECT decision_json, captured_at
      FROM policy_decision_history${where}
      ORDER BY evaluated_at DESC, id DESC LIMIT ?
    `).all(...parameters, limit).map(row => ({
      ...parseJson(row.decision_json),
      captured_at: row.captured_at
    }));
  }

  close() {
    if (this.closed) return;
    try { this.database.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch {}
    this.database.close();
    this.closed = true;
  }
}
