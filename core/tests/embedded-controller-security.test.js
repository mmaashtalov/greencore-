import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiSecurity, controllerKeysFromEnv } from '../src/api-security.js';

test('embedded controller secret is mapped to its controller identity', () => {
  const security = ApiSecurity.fromEnv({
    AUTH_MODE: 'required',
    ADMIN_API_KEY: 'admin-secret',
    EMBEDDED_CONTROLLER_API_KEY: 'embedded-secret',
    EMBEDDED_CONTROLLER_ID: 'controller_demo',
    PUBLIC_READ_ONLY: 'true'
  });

  assert.equal(security.status().controller_key_count, 1);
  assert.equal(security.isController('embedded-secret', 'controller_demo'), true);
  assert.equal(security.isController('embedded-secret', 'controller_primary'), false);
});

test('embedded controller key merges with explicit controller keys', () => {
  const keys = controllerKeysFromEnv({
    CONTROLLER_API_KEYS: '{"controller_secondary":"secondary-secret"}',
    EMBEDDED_CONTROLLER_API_KEY: 'embedded-secret'
  });
  assert.deepEqual(keys, {
    controller_secondary: 'secondary-secret',
    controller_primary: 'embedded-secret'
  });
});

test('conflicting explicit and embedded keys fail fast', () => {
  assert.throws(() => controllerKeysFromEnv({
    CONTROLLER_API_KEYS: '{"controller_primary":"first-secret"}',
    EMBEDDED_CONTROLLER_API_KEY: 'different-secret'
  }), /Controller key conflict/);
});
