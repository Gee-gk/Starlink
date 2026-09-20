'use strict';

/**
 * Shared server-side helpers: one-time CSRF tokens, scrypt password hashing
 * and payment-webhook signature verification.
 *
 * These used to live inline in server.js. They are pure/stateless enough to be
 * reasoned about — and tested — independently of the Express wiring.
 */

const crypto = require('crypto');
const { safeEqual, auditLog } = require('./security');

// ── Password hashing (scrypt, constant-time verify) ───────
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1 };
const SCRYPT_KEYLEN = 64;

/** @returns {string} `scrypt$<saltHex>$<hashHex>` */
function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const derived = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, SCRYPT_OPTIONS);
    return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

/**
 * Constant-time verify of a stored scrypt hash.
 * @returns {boolean}
 */
function verifyPassword(password, stored) {
    if (typeof stored !== 'string') {
        auditLog.write('CORRUPT_PASSWORD_HASH', { reason: 'not_a_string' });
        return false;
    }
    const [scheme, saltHex, hashHex] = stored.split('$');
    if (scheme !== 'scrypt' || !saltHex || !hashHex) {
        // Distinguish a corrupt/migrated hash from a wrong password so data
        // integrity problems surface instead of looking like failed logins.
        auditLog.write('CORRUPT_PASSWORD_HASH', { reason: 'malformed_stored_hash' });
        return false;
    }
    const derived = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), SCRYPT_KEYLEN, SCRYPT_OPTIONS);
    const expected = Buffer.from(hashHex, 'hex');
    if (derived.length !== expected.length) return false;
    return crypto.timingSafeEqual(derived, expected);
}

// Precomputed once at boot: logins for unknown users still pay scrypt cost
// (so timing cannot reveal whether an account exists) without allocating a
// fresh salt and re-deriving on every attempt.
const DUMMY_HASH = hashPassword('dummy-password-for-timing-parity');

// ── CSRF: one-time token bound to a session ───────────────
const CSRF_TTL = 60 * 60 * 1000;
const csrfStore = new Map();

/** Issues a single-use CSRF token bound to the given session token. */
function issueCsrfToken(sessionToken) {
    const token = crypto.randomBytes(32).toString('hex');
    csrfStore.set(token, { sessionToken, createdAt: Date.now() });
    return token;
}

/** Consumes (deletes) a CSRF token, returning true only on an exact match. */
function consumeCsrfToken(sessionToken, csrfToken) {
    if (!sessionToken || !csrfToken) return false;
    const record = csrfStore.get(csrfToken);
    if (!record) return false;
    if (Date.now() - record.createdAt > CSRF_TTL) {
        csrfStore.delete(csrfToken);
        return false;
    }
    if (!safeEqual(record.sessionToken, sessionToken)) return false;
    // Single use: prevents replay of a captured token.
    csrfStore.delete(csrfToken);
    return true;
}

/** Drops CSRF tokens that outlived their TTL. */
function cleanupExpiredCsrfTokens() {
    const now = Date.now();
    for (const [token, record] of csrfStore.entries()) {
        if (now - record.createdAt > CSRF_TTL) csrfStore.delete(token);
    }
}

// ── Webhook signatures ────────────────────
/** @returns {string} Hex HMAC-SHA256 of the JSON-encoded body. */
function webhookSignature(secret, body) {
    return crypto.createHmac('sha256', secret).update(JSON.stringify(body || {})).digest('hex');
}

/**
 * Builds an Express middleware that verifies a provider webhook signature.
 * Fails closed: an unconfigured secret responds 503 rather than accepting.
 */
function verifyWebhook(provider) {
    return (req, res, next) => {
        const secret = process.env[`${provider.toUpperCase()}_WEBHOOK_SECRET`];
        if (!secret) {
            return res.status(503).json({ success: false, message: 'Webhook not configured' });
        }
        const signature = req.headers['x-signature'];
        const expected = webhookSignature(secret, req.body);
        if (!signature || !safeEqual(String(signature), expected)) {
            auditLog.write('WEBHOOK_REJECTED', { provider, ip: req.ip });
            return res.status(401).json({ success: false, message: 'Invalid signature' });
        }
        next();
    };
}

module.exports = {
    hashPassword,
    verifyPassword,
    DUMMY_HASH,
    CSRF_TTL,
    issueCsrfToken,
    consumeCsrfToken,
    cleanupExpiredCsrfTokens,
    webhookSignature,
    verifyWebhook,
};
