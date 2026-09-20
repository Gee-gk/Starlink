'use strict';

/**
 * Unit tests for backend/security.js covering phone normalization, input
 * validation, session handling, CSRF-free primitives, CORS and headers.
 * Run with: npm test
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    validator,
    validateRegistration,
    validateLogin,
    normalizeKenyaPhone,
    maskPhone,
    safeEqual,
    createSession,
    validateSession,
    securityHeaders,
    corsMiddleware,
    rateLimit,
    validateApiSecret,
} = require('../backend/security');

/** Minimal Express-like response double that records headers/status/body. */
function makeRes() {
    return {
        statusCode: 200,
        headers: {},
        body: undefined,
        ended: false,
        setHeader(name, value) {
            this.headers[name] = value;
            return this;
        },
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(payload) {
            this.body = payload;
            return this;
        },
        end() {
            this.ended = true;
            return this;
        },
    };
}

// ── Phone normalization ────────────────────────────────
test('normalizeKenyaPhone accepts all supported Kenyan formats', () => {
    const expected = '+254712345678';
    assert.equal(normalizeKenyaPhone('0712345678'), expected);
    assert.equal(normalizeKenyaPhone('0712 345 678'), expected);
    assert.equal(normalizeKenyaPhone('0712-345-678'), expected);
    assert.equal(normalizeKenyaPhone('+254712345678'), expected);
    assert.equal(normalizeKenyaPhone('254712345678'), expected);
    assert.equal(normalizeKenyaPhone('712345678'), expected);
});

test('normalizeKenyaPhone accepts the 01 (Airtel) prefix', () => {
    assert.equal(normalizeKenyaPhone('0112345678'), '+254112345678');
});

test('normalizeKenyaPhone rejects malformed input', () => {
    for (const bad of [null, undefined, 42, '', '0000', '0812345678', '0712345', 'abcdefghij']) {
        assert.equal(normalizeKenyaPhone(bad), null, `expected null for ${String(bad)}`);
    }
});

test('maskPhone hides the middle digits of a number', () => {
    const masked = maskPhone('0712345678');
    assert.ok(masked.includes('****'), 'expected a mask marker');
    assert.ok(!masked.includes('12345678'), 'raw digits must not survive masking');
    assert.equal(maskPhone(''), '***');
});

// ── Primitive validators ───────────────────────────────
test('pin validator requires exactly four digits', () => {
    assert.equal(validator.pin('1234'), true);
    assert.equal(validator.pin('123'), false);
    assert.equal(validator.pin('12345'), false);
    assert.equal(validator.pin('12a4'), false);
    assert.equal(validator.pin(1234), false);
});

test('method validator only allows Kenyan mobile money providers', () => {
    assert.equal(validator.method('safaricom'), true);
    assert.equal(validator.method('AIRTEL'), true);
    assert.equal(validator.method('mpesa'), false);
    assert.equal(validator.method(''), false);
    assert.equal(validator.method(null), false);
});

test('amount validator accepts positive integers within the ceiling', () => {
    assert.equal(validator.amount(500), true);
    assert.equal(validator.amount('KES 1,299'), true);
    assert.equal(validator.amount(0), false);
    assert.equal(validator.amount(-5), false);
    assert.equal(validator.amount(1000001), false);
});

test('sanitize escapes HTML-significant characters and truncates', () => {
    const out = validator.sanitize('<script>alert("x")</script>');
    assert.ok(!out.includes('<script>'), 'tags must be escaped');
    assert.ok(out.includes('&lt;'), 'angle brackets should be entity-encoded');
    assert.equal(validator.sanitize('abcdef', 3), 'abc');
    assert.equal(validator.sanitize(42), '');
});

test('password validator enforces the 8-128 character range', () => {
    assert.equal(validator.password('longenough'), true);
    assert.equal(validator.password('short'), false);
    assert.equal(validator.password('a'.repeat(129)), false);
});

// ── Registration / login bodies ────────────────────────
test('validateRegistration returns normalized phone and escaped name', () => {
    const result = validateRegistration({
        fullName: 'Ann Wanjiru',
        phone: '0712 345 678',
        password: 'longenough1',
    });
    assert.equal(result.ok, true);
    assert.equal(result.normalizedPhone, '+254712345678');
    assert.equal(result.name, 'Ann Wanjiru');
});

test('validateRegistration reports the first failing field', () => {
    assert.deepEqual(
        validateRegistration({}).field,
        'form',
        'missing required fields should report the form'
    );
    assert.equal(
        validateRegistration({ fullName: 'A', phone: '0712345678', password: 'longenough1' }).field,
        'fullName'
    );
    assert.equal(
        validateRegistration({ fullName: 'Ann Wanjiru', phone: '0000', password: 'longenough1' }).field,
        'phone'
    );
    assert.equal(
        validateRegistration({ fullName: 'Ann Wanjiru', phone: '0712345678', password: 'short' }).field,
        'password'
    );
    assert.equal(
        validateRegistration({
            fullName: 'Ann Wanjiru',
            phone: '0712345678',
            password: 'longenough1',
            confirmPassword: 'different1',
        }).field,
        'confirmPassword'
    );
    assert.equal(
        validateRegistration({
            fullName: 'Ann Wanjiru',
            phone: '0712345678',
            password: 'longenough1',
            terms: false,
        }).field,
        'terms'
    );
});

test('validateLogin requires a valid phone and a password', () => {
    assert.equal(validateLogin({ phone: '0712345678', password: 'x' }).ok, true);
    assert.equal(validateLogin({}).ok, false);
    assert.equal(validateLogin({ phone: '0000', password: 'x' }).field, 'phone');
});

// ── Sessions ───────────────────────────
test('createSession issues a token that validateSession accepts', () => {
    const token = createSession();
    assert.equal(typeof token, 'string');
    assert.equal(token.length, 64, 'expected a 32-byte hex token');
    assert.equal(validateSession(token), true);
});

test('validateSession rejects unknown and malformed tokens', () => {
    assert.equal(validateSession('not-a-real-token'), false);
    assert.equal(validateSession(''), false);
    assert.equal(validateSession(undefined), false);
    assert.equal(validateSession({}), false);
});

// ── Constant-time comparison ───────────────────────────
test('safeEqual compares strings without leaking length', () => {
    assert.equal(safeEqual('secret', 'secret'), true);
    assert.equal(safeEqual('secret', 'secrez'), false);
    assert.equal(safeEqual('secret', 'longer-secret'), false);
    assert.equal(safeEqual(null, 'secret'), false);
    assert.equal(safeEqual('secret', undefined), false);
});

// ── Middleware ─────────────────────────
test('securityHeaders sets hardening headers and no-store for the API', () => {
    const req = { path: '/api/packages' };
    const res = makeRes();
    let called = false;
    securityHeaders(req, res, () => {
        called = true;
    });

    assert.equal(called, true);
    assert.equal(res.headers['X-Content-Type-Options'], 'nosniff');
    assert.equal(res.headers['X-Frame-Options'], 'DENY');
    assert.ok(String(res.headers['Content-Security-Policy']).includes("default-src 'self'"));
    assert.ok(String(res.headers['Cache-Control']).includes('no-store'));
});

test('validateApiSecret rejects a missing or invalid session header', () => {
    const res = makeRes();
    validateApiSecret({ headers: {} }, res, () => {
        throw new Error('next() must not be called without a session');
    });
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.success, false);
});

test('validateApiSecret allows a freshly created session', () => {
    const token = createSession();
    const res = makeRes();
    let called = false;
    validateApiSecret({ headers: { 'x-api-secret': token } }, res, () => {
        called = true;
    });
    assert.equal(called, true);
});

test('corsMiddleware reflects only allow-listed origins', () => {
    const allowed = String(process.env.ALLOWED_ORIGINS || 'http://localhost:3000')
        .split(',')[0]
        .trim();

    const res = makeRes();
    corsMiddleware({ method: 'GET', headers: { origin: allowed } }, res, () => {});
    assert.equal(res.headers['Access-Control-Allow-Origin'], allowed);
    assert.equal(res.headers.Vary, 'Origin');

    const blocked = makeRes();
    corsMiddleware({ method: 'GET', headers: { origin: 'https://evil.example' } }, blocked, () => {});
    assert.equal(blocked.headers['Access-Control-Allow-Origin'], undefined);
});

test('corsMiddleware short-circuits preflight requests with 204', () => {
    const res = makeRes();
    let called = false;
    corsMiddleware({ method: 'OPTIONS', headers: {} }, res, () => {
        called = true;
    });
    assert.equal(called, false, 'OPTIONS must not fall through');
    assert.equal(res.statusCode, 204);
    assert.equal(res.ended, true);
});

test('rateLimit blocks once the per-window maximum is exceeded', () => {
    const limiter = rateLimit({ maxRequests: 2, windowMs: 60000, scope: 'test-scope' });
    const req = { ip: '203.0.113.9', headers: {} };

    const first = makeRes();
    limiter(req, first, () => {});
    assert.equal(first.headers['X-RateLimit-Limit'], 2);

    limiter(req, makeRes(), () => {});

    const third = makeRes();
    limiter(req, third, () => {
        throw new Error('next() must not be called after the limit is hit');
    });
    assert.equal(third.statusCode, 429);
    assert.equal(third.body.success, false);
    assert.ok(third.headers['Retry-After'] >= 0);
});

// ── Rate limiter window semantics (fake clock) ──────────
test('rateLimit resets the counter once the window has elapsed', () => {
    const realNow = Date.now;
    let clock = 1_000_000;
    Date.now = () => clock;
    try {
        const limiter = rateLimit({ maxRequests: 1, windowMs: 1000, scope: 'reset-scope' });
        const req = { ip: '198.51.100.7', headers: {} };

        // First request in the window passes.
        let passed = 0;
        limiter(req, makeRes(), () => { passed++; });
        assert.equal(passed, 1);

        // Second request in the same window is blocked with a Retry-After.
        const blocked = makeRes();
        limiter(req, blocked, () => { throw new Error('must not pass inside the window'); });
        assert.equal(blocked.statusCode, 429);
        assert.ok(blocked.headers['Retry-After'] >= 0, 'Retry-After must be present');

        // Advance past the window: the same key is allowed again.
        clock += 1001;
        const afterReset = makeRes();
        limiter(req, afterReset, () => { passed++; });
        assert.equal(passed, 2, 'counter must reset after the window elapses');
        assert.equal(afterReset.statusCode, 200);
        assert.equal(afterReset.headers['X-RateLimit-Remaining'], 0);
    } finally {
        Date.now = realNow;
    }
});

test('rateLimit tracks separate scopes and clients independently', () => {
    const a = rateLimit({ maxRequests: 1, windowMs: 60000, scope: 'scope-a' });
    const b = rateLimit({ maxRequests: 1, windowMs: 60000, scope: 'scope-b' });
    const alice = { ip: '192.0.2.1', headers: {} };
    const bob = { ip: '192.0.2.2', headers: {} };

    a(alice, makeRes(), () => {});

    // A different scope, and a different client in the same scope, both pass.
    let passed = 0;
    b(alice, makeRes(), () => { passed++; });
    a(bob, makeRes(), () => { passed++; });
    assert.equal(passed, 2, 'scopes and clients must not share a counter');

    // The original client is still blocked within scope-a.
    const blocked = makeRes();
    a(alice, blocked, () => { throw new Error('same client in same scope must be limited'); });
    assert.equal(blocked.statusCode, 429);
});

test('rateLimit emits X-RateLimit-Remaining that decreases per request', () => {
    const limiter = rateLimit({ maxRequests: 3, windowMs: 60000, scope: 'remaining-scope' });
    const req = { ip: '192.0.2.9', headers: {} };

    const first = makeRes();
    limiter(req, first, () => {});
    const second = makeRes();
    limiter(req, second, () => {});

    assert.equal(first.headers['X-RateLimit-Remaining'], 2);
    assert.equal(second.headers['X-RateLimit-Remaining'], 1);
    assert.ok(first.headers['X-RateLimit-Reset'], 'reset timestamp must be set');
});
