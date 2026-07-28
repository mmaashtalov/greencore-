import crypto from 'node:crypto';

const MODES = new Set(['disabled', 'required']);

function authorizationError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function secureEqual(left, right) {
  const first = Buffer.from(left ?? '', 'utf8');
  const second = Buffer.from(right ?? '', 'utf8');
  const length = Math.max(first.length, second.length, 1);
  const paddedFirst = Buffer.alloc(length);
  const paddedSecond = Buffer.alloc(length);
  first.copy(paddedFirst);
  second.copy(paddedSecond);
  return crypto.timingSafeEqual(paddedFirst, paddedSecond) && first.length === second.length;
}

function parseControllerKeys(value) {
  if (value === undefined || value === null || value === '') return {};
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('CONTROLLER_API_KEYS must be a JSON object');
  }
  const keys = {};
  for (const [controllerId, key] of Object.entries(parsed)) {
    const normalizedId = nonEmpty(controllerId);
    const normalizedKey = nonEmpty(key);
    if (!normalizedId || !normalizedKey) throw new Error('Controller API keys must use non-empty strings');
    keys[normalizedId] = normalizedKey;
  }
  return keys;
}

export class ApiSecurity {
  constructor({
    mode = 'disabled',
    adminKey = null,
    operatorKey = null,
    controllerKeys = {},
    publicReadOnly = false,
    publicSimulations = false
  } = {}) {
    if (!MODES.has(mode)) throw new Error(`Unsupported AUTH_MODE: ${mode}`);
    this.mode = mode;
    this.adminKey = nonEmpty(adminKey);
    this.operatorKey = nonEmpty(operatorKey);
    this.controllerKeys = new Map(Object.entries(parseControllerKeys(controllerKeys)));
    this.publicReadOnly = Boolean(publicReadOnly);
    this.publicSimulations = Boolean(publicSimulations);

    if (this.mode === 'required' && !this.adminKey) {
      throw new Error('ADMIN_API_KEY is required when AUTH_MODE=required');
    }
  }

  static fromEnv(env = process.env) {
    return new ApiSecurity({
      mode: env.AUTH_MODE ?? 'disabled',
      adminKey: env.ADMIN_API_KEY,
      operatorKey: env.OPERATOR_API_KEY,
      controllerKeys: env.CONTROLLER_API_KEYS,
      publicReadOnly: env.PUBLIC_READ_ONLY === 'true',
      publicSimulations: env.PUBLIC_SIMULATIONS === 'true'
    });
  }

  status() {
    return {
      mode: this.mode,
      public_read_only: this.publicReadOnly,
      public_simulations: this.publicSimulations,
      admin_key_configured: Boolean(this.adminKey),
      operator_key_configured: Boolean(this.operatorKey),
      controller_key_count: this.controllerKeys.size
    };
  }

  token(request) {
    const authorization = request.headers.authorization;
    if (typeof authorization === 'string') {
      const match = authorization.match(/^Bearer\s+(.+)$/i);
      if (match) return nonEmpty(match[1]);
    }
    const apiKey = request.headers['x-api-key'];
    return Array.isArray(apiKey) ? nonEmpty(apiKey[0]) : nonEmpty(apiKey);
  }

  bypass() {
    return this.mode === 'disabled';
  }

  isAdmin(token) {
    return Boolean(this.adminKey && token && secureEqual(token, this.adminKey));
  }

  isOperator(token) {
    return this.isAdmin(token) || Boolean(this.operatorKey && token && secureEqual(token, this.operatorKey));
  }

  isController(token, controllerId) {
    const key = this.controllerKeys.get(controllerId);
    return this.isAdmin(token) || Boolean(key && token && secureEqual(token, key));
  }

  requireToken(request) {
    const token = this.token(request);
    if (!token) throw authorizationError('Authentication required', 401);
    return token;
  }

  requireAdmin(request) {
    if (this.bypass()) return { role: 'disabled' };
    const token = this.requireToken(request);
    if (!this.isAdmin(token)) throw authorizationError('Administrator access required', 403);
    return { role: 'admin' };
  }

  requireOperator(request) {
    if (this.bypass()) return { role: 'disabled' };
    const token = this.requireToken(request);
    if (!this.isOperator(token)) throw authorizationError('Operator access required', 403);
    return { role: this.isAdmin(token) ? 'admin' : 'operator' };
  }

  requireController(request, controllerId) {
    if (this.bypass()) return { role: 'disabled', controller_id: controllerId };
    if (typeof controllerId !== 'string' || controllerId.length === 0) {
      throw authorizationError('Controller identity is required', 403);
    }
    const token = this.requireToken(request);
    if (!this.isController(token, controllerId)) {
      throw authorizationError(`Controller access denied: ${controllerId}`, 403);
    }
    return { role: this.isAdmin(token) ? 'admin' : 'controller', controller_id: controllerId };
  }

  requireRead(request) {
    if (this.bypass() || this.publicReadOnly) return { role: 'public' };
    return this.requireOperator(request);
  }

  requireSimulation(request) {
    if (this.bypass() || this.publicSimulations) return { role: 'public' };
    return this.requireOperator(request);
  }
}

export { parseControllerKeys, secureEqual };
