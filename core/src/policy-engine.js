import crypto from 'node:crypto';

const EFFECTS = new Set(['ALLOW', 'DENY']);
const OPERATORS = new Set(['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'in', 'not_in', 'truthy', 'falsy']);

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function pathValue(root, path) {
  if (typeof path !== 'string' || path.trim() === '') return undefined;
  return path.split('.').reduce((current, key) => {
    if (current === null || current === undefined) return undefined;
    return current[key];
  }, root);
}

function resolvedValue(specification, context) {
  if (isObject(specification) && typeof specification.ref === 'string') {
    return pathValue(context, specification.ref);
  }
  return specification;
}

function compare(operator, observed, expected) {
  if (!OPERATORS.has(operator)) throw new Error(`Unsupported policy operator: ${operator}`);
  if (operator === 'eq') return observed === expected;
  if (operator === 'ne') return observed !== expected;
  if (operator === 'lt') return typeof observed === 'number' && typeof expected === 'number' && observed < expected;
  if (operator === 'lte') return typeof observed === 'number' && typeof expected === 'number' && observed <= expected;
  if (operator === 'gt') return typeof observed === 'number' && typeof expected === 'number' && observed > expected;
  if (operator === 'gte') return typeof observed === 'number' && typeof expected === 'number' && observed >= expected;
  if (operator === 'in') return Array.isArray(expected) && expected.includes(observed);
  if (operator === 'not_in') return Array.isArray(expected) && !expected.includes(observed);
  if (operator === 'truthy') return Boolean(observed);
  return !observed;
}

function evaluateCondition(condition, context) {
  if (!isObject(condition)) throw new Error('Policy condition must be an object');

  if (Array.isArray(condition.all)) {
    const children = condition.all.map(item => evaluateCondition(item, context));
    return {
      matched: children.every(item => item.matched),
      evidence: children.flatMap(item => item.evidence)
    };
  }

  if (Array.isArray(condition.any)) {
    const children = condition.any.map(item => evaluateCondition(item, context));
    return {
      matched: children.some(item => item.matched),
      evidence: children.flatMap(item => item.evidence)
    };
  }

  if (condition.not !== undefined) {
    const child = evaluateCondition(condition.not, context);
    return { matched: !child.matched, evidence: child.evidence };
  }

  if (typeof condition.fact !== 'string' || typeof condition.operator !== 'string') {
    throw new Error('Policy leaf condition requires fact and operator');
  }

  const observed = pathValue(context, condition.fact);
  const expected = resolvedValue(condition.value, context);
  const matched = compare(condition.operator, observed, expected);
  return {
    matched,
    evidence: [{
      fact: condition.fact,
      operator: condition.operator,
      observed: clone(observed),
      expected: clone(expected),
      matched
    }]
  };
}

function scopeValue(context, key) {
  const paths = {
    actuator_ids: 'command.actuator_id',
    actuator_types: 'command.actuator_type',
    actions: 'command.action',
    sources: 'command.source',
    modes: 'mode.effective',
    configured_modes: 'mode.configured'
  };
  return pathValue(context, paths[key]);
}

function scopeMatches(scope, context) {
  if (scope === undefined) return true;
  if (!isObject(scope)) throw new Error('Policy scope must be an object');
  for (const [key, allowed] of Object.entries(scope)) {
    if (!Array.isArray(allowed) || allowed.length === 0) throw new Error(`Policy scope ${key} must be a non-empty array`);
    if (!allowed.includes(scopeValue(context, key))) return false;
  }
  return true;
}

function normalizePolicy(policy, index) {
  if (!isObject(policy)) throw new Error(`Policy at index ${index} must be an object`);
  if (typeof policy.id !== 'string' || policy.id.trim() === '') throw new Error(`Policy at index ${index} requires id`);
  if (!EFFECTS.has(policy.effect)) throw new Error(`Policy ${policy.id} has unsupported effect`);
  if (!Number.isFinite(policy.priority)) throw new Error(`Policy ${policy.id} requires numeric priority`);
  if (!isObject(policy.when)) throw new Error(`Policy ${policy.id} requires when condition`);
  return {
    id: policy.id,
    priority: policy.priority,
    effect: policy.effect,
    description: typeof policy.description === 'string' ? policy.description : policy.id,
    alert_type: typeof policy.alert_type === 'string' ? policy.alert_type : null,
    scope: policy.scope === undefined ? undefined : clone(policy.scope),
    when: clone(policy.when)
  };
}

function normalizeConfig(config) {
  if (!isObject(config)) {
    return {
      version: '0.0.0',
      status: 'NO_EXTERNAL_POLICY_SET',
      default_effect: 'ALLOW',
      policies: []
    };
  }
  if (!EFFECTS.has(config.default_effect ?? 'ALLOW')) throw new Error('Policy default_effect must be ALLOW or DENY');
  const policies = Array.isArray(config.policies) ? config.policies.map(normalizePolicy) : [];
  const ids = new Set();
  for (const policy of policies) {
    if (ids.has(policy.id)) throw new Error(`Duplicate policy id: ${policy.id}`);
    ids.add(policy.id);
  }
  policies.sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id));
  return {
    version: typeof config.version === 'string' ? config.version : '0.0.0',
    status: typeof config.status === 'string' ? config.status : 'UNSPECIFIED',
    default_effect: config.default_effect ?? 'ALLOW',
    policies
  };
}

function compactContext(context) {
  return {
    command: clone(context.command),
    mode: clone(context.mode),
    connectivity: clone(context.connectivity),
    actuator: clone(context.actuator),
    required_telemetry_usable: Boolean(context.required_telemetry_usable),
    telemetry: Object.fromEntries(
      Object.entries(context.telemetry ?? {}).map(([metric, state]) => [metric, {
        state: state.state,
        usable: state.usable,
        value: state.value,
        quality: state.quality,
        age_seconds: state.age_seconds
      }])
    )
  };
}

export class PolicyEngine {
  constructor({ config, now = () => new Date(), idFactory = () => crypto.randomUUID() } = {}) {
    this.config = normalizeConfig(config);
    this.now = now;
    this.idFactory = idFactory;
  }

  catalog() {
    return clone(this.config);
  }

  evaluate(context) {
    if (!isObject(context) || !isObject(context.command)) throw new Error('Policy context requires command');
    const matches = [];
    for (const policy of this.config.policies) {
      if (!scopeMatches(policy.scope, context)) continue;
      const result = evaluateCondition(policy.when, context);
      if (!result.matched) continue;
      matches.push({
        policy_id: policy.id,
        priority: policy.priority,
        effect: policy.effect,
        description: policy.description,
        alert_type: policy.alert_type,
        evidence: result.evidence
      });
    }

    const selected = matches[0] ?? null;
    const effect = selected?.effect ?? this.config.default_effect;
    return {
      decision_id: `pdec_${this.idFactory()}`,
      evaluated_at: this.now().toISOString(),
      policy_version: this.config.version,
      policy_status: this.config.status,
      effect,
      policy_id: selected?.policy_id ?? null,
      priority: selected?.priority ?? null,
      summary: selected?.description ?? `Default policy effect: ${effect}`,
      alert_type: selected?.alert_type ?? null,
      evidence: selected?.evidence ?? [],
      matched_policy_ids: matches.map(item => item.policy_id),
      context: compactContext(context)
    };
  }

  validateDecision(decision) {
    if (!isObject(decision)
      || typeof decision.decision_id !== 'string'
      || typeof decision.evaluated_at !== 'string'
      || Number.isNaN(new Date(decision.evaluated_at).getTime())
      || !EFFECTS.has(decision.effect)
      || typeof decision.policy_version !== 'string'
      || typeof decision.summary !== 'string'
      || !Array.isArray(decision.evidence)
      || !Array.isArray(decision.matched_policy_ids)
      || !isObject(decision.context)) {
      throw new Error('Invalid persisted policy decision');
    }
    return clone(decision);
  }
}

export { evaluateCondition, pathValue, scopeMatches };
