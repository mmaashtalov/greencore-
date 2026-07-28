const BUCKETS = new Map([
  ['1m', 60],
  ['5m', 300],
  ['15m', 900],
  ['1h', 3600],
  ['6h', 21600],
  ['1d', 86400]
]);

function validDate(value, field) {
  if (value === undefined || value === null || value === '') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${field} must be a valid date`);
  return date.toISOString();
}

function boundedLimit(value, { defaultValue = 500, maximum = 5000 } = {}) {
  if (value === undefined || value === null || value === '') return defaultValue;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`limit must be an integer from 1 to ${maximum}`);
  }
  return parsed;
}

function timeConditions(filters, column = 'timestamp') {
  const clauses = [];
  const parameters = [];
  if (filters.from) {
    clauses.push(`${column} >= ?`);
    parameters.push(validDate(filters.from, 'from'));
  }
  if (filters.to) {
    clauses.push(`${column} <= ?`);
    parameters.push(validDate(filters.to, 'to'));
  }
  return { clauses, parameters };
}

function countsBy(rows, key) {
  return Object.fromEntries(rows.map(row => [row[key], Number(row.count)]));
}

export class HistoryAnalytics {
  constructor({ history }) {
    if (!history?.database) throw new Error('history store with database is required');
    this.history = history;
    this.database = history.database;
  }

  telemetrySeries(filters = {}) {
    if (typeof filters.metric !== 'string' || filters.metric.length === 0) {
      throw new Error('metric is required');
    }
    const bucket = filters.bucket ?? '1h';
    const bucketSeconds = BUCKETS.get(bucket);
    if (!bucketSeconds) throw new Error(`Unsupported bucket: ${bucket}`);
    const limit = boundedLimit(filters.limit, { defaultValue: 500, maximum: 5000 });
    const { clauses, parameters } = timeConditions(filters);
    clauses.unshift('metric = ?');
    parameters.unshift(filters.metric);
    for (const [filter, column] of Object.entries({
      device_id: 'device_id',
      controller_id: 'controller_id',
      quality: 'quality'
    })) {
      const value = filters[filter];
      if (value === undefined || value === null || value === '') continue;
      clauses.push(`${column} = ?`);
      parameters.push(value);
    }

    const rows = this.database.prepare(`
      SELECT
        strftime('%Y-%m-%dT%H:%M:%SZ', CAST(unixepoch(timestamp) / ? AS INTEGER) * ?, 'unixepoch') AS bucket_start,
        metric,
        unit,
        MIN(value) AS min_value,
        MAX(value) AS max_value,
        AVG(value) AS avg_value,
        COUNT(*) AS sample_count
      FROM telemetry_history
      WHERE ${clauses.join(' AND ')}
      GROUP BY bucket_start, metric, unit
      ORDER BY bucket_start ASC
      LIMIT ?
    `).all(bucketSeconds, bucketSeconds, ...parameters, limit);

    return {
      metric: filters.metric,
      bucket,
      bucket_seconds: bucketSeconds,
      points: rows.map(row => ({
        ...row,
        min_value: Number(row.min_value),
        max_value: Number(row.max_value),
        avg_value: Number(row.avg_value),
        sample_count: Number(row.sample_count)
      }))
    };
  }

  latestTelemetry(filters = {}) {
    const limit = boundedLimit(filters.limit, { defaultValue: 50, maximum: 500 });
    const { clauses, parameters } = timeConditions(filters, 't.timestamp');
    if (filters.quality) {
      clauses.push('t.quality = ?');
      parameters.push(filters.quality);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.database.prepare(`
      SELECT t.timestamp, t.controller_id, t.device_id, t.metric, t.value, t.unit, t.quality
      FROM telemetry_history t
      JOIN (
        SELECT metric, MAX(timestamp) AS latest_timestamp
        FROM telemetry_history
        GROUP BY metric
      ) latest ON latest.metric = t.metric AND latest.latest_timestamp = t.timestamp
      ${where}
      ORDER BY t.metric ASC
      LIMIT ?
    `).all(...parameters, limit);
  }

  commandSummary(filters = {}) {
    const { clauses, parameters } = timeConditions(filters, 'issued_at');
    for (const [filter, column] of Object.entries({
      actuator_id: 'actuator_id',
      controller_id: 'controller_id',
      action: 'action',
      mode: 'mode'
    })) {
      const value = filters[filter];
      if (value === undefined || value === null || value === '') continue;
      clauses.push(`${column} = ?`);
      parameters.push(value);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    const byStatusRows = this.database.prepare(`
      SELECT status, COUNT(*) AS count FROM command_history${where} GROUP BY status ORDER BY status
    `).all(...parameters);
    const byActuatorRows = this.database.prepare(`
      SELECT actuator_id, action, COUNT(*) AS count
      FROM command_history${where}
      GROUP BY actuator_id, action
      ORDER BY actuator_id, action
    `).all(...parameters);
    const byStatus = countsBy(byStatusRows, 'status');
    const total = Object.values(byStatus).reduce((sum, count) => sum + count, 0);
    const terminal = ['EXECUTED', 'REJECTED', 'FAILED', 'EXPIRED']
      .reduce((sum, status) => sum + (byStatus[status] ?? 0), 0);
    const executed = byStatus.EXECUTED ?? 0;
    return {
      total,
      terminal,
      executed,
      success_rate_percent: terminal === 0 ? null : Number(((executed / terminal) * 100).toFixed(2)),
      by_status: byStatus,
      by_actuator_action: Object.fromEntries(
        byActuatorRows.map(row => [`${row.actuator_id}:${row.action}`, Number(row.count)])
      )
    };
  }

  alertSummary(filters = {}) {
    const { clauses, parameters } = timeConditions(filters);
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.database.prepare(`
      SELECT type, COUNT(*) AS count, MIN(timestamp) AS first_seen, MAX(timestamp) AS last_seen
      FROM alert_history${where}
      GROUP BY type
      ORDER BY count DESC, type ASC
    `).all(...parameters);
    return {
      total: rows.reduce((sum, row) => sum + Number(row.count), 0),
      types: rows.map(row => ({ ...row, count: Number(row.count) }))
    };
  }

  simulationSummary(filters = {}) {
    const clauses = [];
    const parameters = [];
    if (filters.from) {
      clauses.push('created_at >= ?');
      parameters.push(validDate(filters.from, 'from'));
    }
    if (filters.to) {
      clauses.push('created_at <= ?');
      parameters.push(validDate(filters.to, 'to'));
    }
    if (filters.name) {
      clauses.push('name = ?');
      parameters.push(filters.name);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.database.prepare(`
      SELECT name, type, kind, COUNT(*) AS count,
             SUM(CASE WHEN passed = 1 THEN 1 ELSE 0 END) AS passed_count,
             SUM(CASE WHEN passed = 0 THEN 1 ELSE 0 END) AS failed_count,
             MAX(created_at) AS last_run_at
      FROM simulation_reports${where}
      GROUP BY name, type, kind
      ORDER BY last_run_at DESC
    `).all(...parameters);
    return rows.map(row => ({
      ...row,
      count: Number(row.count),
      passed_count: Number(row.passed_count),
      failed_count: Number(row.failed_count)
    }));
  }

  overview(filters = {}) {
    return {
      generated_at: new Date().toISOString(),
      storage: this.history.stats(),
      latest_telemetry: this.latestTelemetry({ ...filters, quality: filters.quality ?? 'GOOD' }),
      commands: this.commandSummary(filters),
      alerts: this.alertSummary(filters),
      simulations: this.simulationSummary(filters)
    };
  }

  catalog() {
    return {
      telemetry_buckets: Object.fromEntries(BUCKETS),
      endpoints: [
        '/analytics/overview',
        '/analytics/telemetry',
        '/analytics/commands',
        '/analytics/alerts',
        '/analytics/simulations'
      ]
    };
  }
}
