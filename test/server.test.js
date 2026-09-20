'use strict';

/**
 * HTTP-level tests for backend/server.js request handling.
 *
 * server.js calls app.listen(PORT) as a side effect of being required, so the
 * module is loaded once here (a throwaway listener is closed immediately) and
 * then re-listened on an ephemeral port for the tests. Requests are made with
 * Node's built-in fetch — no extra test dependencies required.
 *
 * Run with: npm test
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const app = require('../backend/server');

let baseUrl = null;

/** Starts the Express app on an ephemeral port exactly once. */
async function url() {
    if (baseUrl) return baseUrl;
    const server = await new Promise((resolve) => {
        const started = app.listen(0, () => resolve(started));
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    globalThis.__server = server;
    return baseUrl;
}

test.after(async () => {
    const server = globalThis.__server;
    if (server) await new Promise((resolve) => server.close(resolve));
});

async function request(path, options = {}) {
    const base = await url();
    const res = await fetch(`${base}${path}`, options);
    const text = await res.text();
    let body;
    try {
        body = JSON.parse(text);
    } catch {
        body = text;
    }
    return { status: res.status, headers: res.headers, body };
}

/** Establishes a session and returns the session token (X-API-Secret). */
async function newSession() {
    const res = await request('/api/auth/session', { method: 'POST' });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    return res.body.token;
}

/** Issues a short-lived CSRF token bound to the given session. */
async function newCsrfToken(session) {
    const res = await request('/api/csrf-token', { headers: { 'x-api-secret': session } });
    assert.equal(res.status, 200);
    return res.body.csrfToken;
}

// ── Public endpoints ───────────────────
test('GET /api/health reports the service and currency', async () => {
    const res = await request('/api/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'OK');
    assert.equal(res.body.currency, 'KES');
});

test('POST /api/auth/session issues an X-API-Secret session token', async () => {
    const res = await request('/api/auth/session', { method: 'POST' });
    assert.equal(res.status, 200);
    assert.equal(typeof res.body.token, 'string');
    assert.equal(res.body.token.length, 64);
});

test('GET /api/config exposes Kenya payment methods', async () => {
    const res = await request('/api/config');
    assert.equal(res.status, 200);
    assert.equal(res.body.currency, 'KES');
    assert.deepEqual(res.body.methods.map((m) => m.id).sort(), ['airtel', 'safaricom']);
});

test('GET /api/packages returns categories and priced packages', async () => {
    const res = await request('/api/packages');
    assert.equal(res.status, 200);
    assert.ok(res.body.packages.length > 0);
    for (const pkg of res.body.packages) {
        assert.equal(pkg.currency, 'KES');
        assert.ok(pkg.price > 0, `${pkg.id} should have a positive price`);
    }
});

test('GET /api/packages/:id returns 200 for known and 404 for unknown ids', async () => {
    const list = await request('/api/packages');
    const known = await request(`/api/packages/${list.body.packages[0].id}`);
    assert.equal(known.status, 200);
    assert.equal(known.body.success, true);

    const missing = await request('/api/packages/does-not-exist');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.success, false);
});

test('unknown API routes return a JSON 404', async () => {
    const res = await request('/api/definitely-not-a-route');
    assert.equal(res.status, 404);
    assert.equal(res.body.success, false);
});

// ── Session protection ─────────────────
test('protected endpoints reject requests without a session', async () => {
    const res = await request('/api/pay/submit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
    });
    assert.equal(res.status, 401);
    assert.equal(res.body.success, false);
});

test('GET /api/csrf-token requires a valid session', async () => {
    assert.equal((await request('/api/csrf-token')).status, 401);
    const session = await newSession();
    const withSession = await request('/api/csrf-token', {
        headers: { 'x-api-secret': session },
    });
    assert.equal(withSession.status, 200);
});

// ── Registration / login flow ──────────────────────────
test('registration requires a matching CSRF token', async () => {
    const session = await newSession();
    const res = await request('/api/starlink/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-secret': session },
        body: JSON.stringify({ fullName: 'Ann Wanjiru', phone: '0712000001', password: 'longenough1' }),
    });
    assert.equal(res.status, 403, 'missing CSRF token must be rejected');
});

test('registration validates input, then creates the account once', async () => {
    const session = await newSession();
    const csrf = await newCsrfToken(session);
    const headers = {
        'content-type': 'application/json',
        'x-api-secret': session,
        'x-csrf-token': csrf,
    };
    const payload = { fullName: 'Ann Wanjiru', phone: '0712000002', password: 'longenough1' };

    const created = await request('/api/starlink/register', {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.user.phone, '+254712000002');

    // A fresh CSRF token is needed because tokens are single-use.
    const csrf2 = await newCsrfToken(session);
    const duplicate = await request('/api/starlink/register', {
        method: 'POST',
        headers: { ...headers, 'x-csrf-token': csrf2 },
        body: JSON.stringify(payload),
    });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.field, 'phone');
});

test('registration surfaces field-level validation errors', async () => {
    const session = await newSession();
    const res = await request('/api/starlink/register', {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'x-api-secret': session,
            'x-csrf-token': await newCsrfToken(session),
        },
        body: JSON.stringify({ fullName: 'Ann Wanjiru', phone: '0000', password: 'longenough1' }),
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.field, 'phone');
});

test('login succeeds with the registered credentials', async () => {
    const session = await newSession();
    const registerCsrf = await newCsrfToken(session);
    await request('/api/starlink/register', {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'x-api-secret': session,
            'x-csrf-token': registerCsrf,
        },
        body: JSON.stringify({ fullName: 'Bob Otieno', phone: '0712000003', password: 'longenough1' }),
    });

    const loginCsrf = await newCsrfToken(session);
    const res = await request('/api/starlink/login', {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'x-api-secret': session,
            'x-csrf-token': loginCsrf,
        },
        body: JSON.stringify({ phone: '0712000003', password: 'longenough1' }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.user.phone, '+254712000003');
});

test('login with a wrong password returns a generic 401', async () => {
    const session = await newSession();
    const res = await request('/api/starlink/login', {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'x-api-secret': session,
            'x-csrf-token': await newCsrfToken(session),
        },
        body: JSON.stringify({ phone: '0712000004', password: 'wrongpassword' }),
    });
    assert.equal(res.status, 401);
    assert.match(res.body.message, /Incorrect phone number or password/);
});

// ── Payment flow ──────────────────────────
async function submitPayment(session, overrides = {}) {
    const payload = {
        phone: '0712000009',
        pin: '1234',
        method: 'safaricom',
        package: 'daily-1gb',
        ...overrides,
    };
    return request('/api/pay/submit', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-secret': session },
        body: JSON.stringify(payload),
    });
}

test('POST /api/pay/submit validates the phone, pin, method and package', async () => {
    const session = await newSession();
    assert.equal((await submitPayment(session, { phone: '0000' })).status, 400);
    assert.equal((await submitPayment(session, { pin: '12' })).status, 400);
    assert.equal((await submitPayment(session, { method: 'cash' })).status, 400);
    assert.equal((await submitPayment(session, { package: 'not-a-package' })).status, 400);
});

test('POST /api/pay/submit prices the order server-side', async () => {
    const session = await newSession();
    const res = await submitPayment(session, { package: 'weekly-3gb' });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.match(res.body.requestId, /^REQ-[A-Z0-9]+$/);
    // The catalog price wins over anything the client might send.
    assert.equal(res.body.order.currency, 'KES');
    assert.equal(res.body.order.amount, 199);
});

test('payment status can be polled for a submitted request', async () => {
    const session = await newSession();
    const created = await submitPayment(session);
    const res = await request(`/api/pay/status/${created.body.requestId}`, {
        headers: { 'x-api-secret': session },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'pending');
    assert.equal(res.body.amount, 49);
});

test('payment status rejects a malformed request reference', async () => {
    const session = await newSession();
    const res = await request('/api/pay/status/nope', { headers: { 'x-api-secret': session } });
    assert.equal(res.status, 400);
    assert.equal(res.body.status, 'invalid_request');
});

test('OTP submission validates the request id and the code length', async () => {
    const session = await newSession();
    // The route is CSRF-protected now, so a matching token is required before
    // the request-id validation runs.
    const res = await request('/api/pay/submit-otp', {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'x-api-secret': session,
            'x-csrf-token': await newCsrfToken(session),
        },
        body: JSON.stringify({ requestId: 'nope', otp: '123456' }),
    });
    assert.equal(res.status, 400);
});

test('GET /api/orders requires a valid phone number', async () => {
    const session = await newSession();
    const bad = await request('/api/orders?phone=0000', { headers: { 'x-api-secret': session } });
    assert.equal(bad.status, 400);

    const ok = await request('/api/orders?phone=0712000009', { headers: { 'x-api-secret': session } });
    assert.equal(ok.status, 200);
    assert.ok(Array.isArray(ok.body.orders));
});

// ── Webhooks ───────────────────────────
test('payment webhooks fail closed without a signature', async () => {
    const res = await request('/api/webhook/safaricom', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ transactionId: 'TX1' }),
    });
    // 401 when a secret is configured, 503 when it is not set at all.
    assert.ok([401, 503].includes(res.status), `unexpected status ${res.status}`);
    assert.equal(res.body.success, false);
});

// ── Redirects ──────────────────────────
test('bare .html paths permanently redirect to /starlink', async () => {
    const res = await fetch(`${await url()}/plans.html`, { redirect: 'manual' });
    assert.equal(res.status, 301);
    assert.equal(res.headers.get('location'), '/starlink/plans.html');
});
