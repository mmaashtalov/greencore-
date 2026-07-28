import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiSecurity, parseControllerKeys, secureEqual } from '../src/api-security.js';

function request(headers = {}) {
  return { headers };
}

test('required security validates configuration without exposing secrets', () => {
  assert.throws(() => new ApiSecurity({ mode: 'required' }), /ADMIN_API_KEY/);
  assert.throws(() => new ApiSecurity({ mode: 'unknown' }), /Unsupported AUTH_MODE/);
  assert.throws(() => parseControllerKeys('[]'), /JSON object/);

  const security = new ApiSecurity({
    mode: 'required',
    adminKey: 'admin-secret',
    operatorKey: 'operator-secret',
    controllerKeys: { controller_primary: 'controller-secret' },
    publicReadOnly: true,
    publicSimulations: false
  });
  assert.deepEqual(security.status(), {
    mode: 'required',
    public_read_only: true,
    public_simulations: false,
    admin_key_configured: true,
    operator_key_configured: true,
    controller_key_count: 1
  });
  assert.equal(JSON.stringify(security.status()).includes('secret'), false);
});

test('Bearer and x-api-key credentials enforce roles and controller identity', () => {
  const security = new ApiSecurity({
    mode: 'required',
    adminKey: 'admin-secret',
    operatorKey: 'operator-secret',
    controllerKeys: {
      controller_primary: 'primary-secret',
      controller_secondary: 'secondary-secret'
    }
  });

  assert.equal(security.requireOperator(request({ authorization: 'Bearer operator-secret' })).role, 'operator');
  assert.equal(security.requireOperator(request({ 'x-api-key': 'admin-secret' })).role, 'admin');
  assert.equal(
    security.requireController(request({ authorization: 'Bearer primary-secret' }), 'controller_primary').role,
    'controller'
  );
  assert.throws(
    () => security.requireController(request({ authorization: 'Bearer primary-secret' }), 'controller_secondary'),
    error => error.statusCode === 403
  );
  assert.throws(() => security.requireOperator(request()), error => error.statusCode === 401);
  assert.throws(
    () => security.requireOperator(request({ authorization: 'Bearer primary-secret' })),
    error => error.statusCode === 403
  );
});

test('public flags only bypass intended read and simulation operations', () => {
  const security = new ApiSecurity({
    mode: 'required',
    adminKey: 'admin-secret',
    publicReadOnly: true,
    publicSimulations: true
  });
  assert.equal(security.requireRead(request()).role, 'public');
  assert.equal(security.requireSimulation(request()).role, 'public');
  assert.throws(() => security.requireOperator(request()), error => error.statusCode === 401);
  assert.throws(
    () => security.requireController(request(), 'controller_primary'),
    error => error.statusCode === 401
  );
});

test('disabled mode preserves local development compatibility', () => {
  const security = new ApiSecurity();
  assert.equal(security.requireOperator(request()).role, 'disabled');
  assert.equal(security.requireController(request(), 'controller_primary').role, 'disabled');
  assert.equal(security.requireRead(request()).role, 'public');
});

test('constant-time helper preserves exact equality semantics', () => {
  assert.equal(secureEqual('same-token', 'same-token'), true);
  assert.equal(secureEqual('same-token', 'different-token'), false);
  assert.equal(secureEqual('short', 'shorter'), false);
  assert.equal(secureEqual('', ''), true);
});
