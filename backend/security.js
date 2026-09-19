const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { isValidPackage, getPackage } = require('./packages');

// Load .env from project root
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || 'http://localhost:3000,http://localhost:3001';
const RATE_LIMIT_WINDOW = parseInt(process.env.RATE_LIMIT_WINDOW || '60000', 10);
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || '10', 10);

// Refuse to boot in production with a placeholder secret.
const RAW_API_SECRET = process.env.API_SECRET || '';
if (IS_PRODUCTION && (!RAW_API_SECRET || RAW_API_SECRET.length < 32 || /change-me|your-|placeholder/i.test(RAW_API_SECRET))) {
    throw new Error('API_SECRET must be set to a strong value (32+ chars) when NODE_ENV=production');
}

// ── Sessions ──────────────────────────────────────────────────
const sessionStore = new Map();
const SESSION_TTL = 60 * 60 * 1000;

function createSession() {
    const token = crypto.randomBytes(32).toString('hex');
    sessionStore.set(token, { token, createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL });
    cleanupExpiredSessions();
    return token;
}

function validateSession(token) {
    if (!token || typeof token !== 'string') return false;
    const session = sessionStore.get(token);
    if (!session) return false;
    if (Date.now() > session.expiresAt) {
        sessionStore.delete(token);
        return false;
    }
    return true;
}

function cleanupExpiredSessions() {
    const now = Date.now();
    for (const [token, session] of sessionStore.entries()) {
        if (now > session.expiresAt) sessionStore.delete(token);
    }
}

setInterval(cleanupExpiredSessions, 5 * 60 * 1000).unref?.();

/**
 * Constant-time string comparison. Prevents timing oracles on secret compares.
 */
function safeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

// ── Security Headers ──────────────────────────────────────────
const CSP = [
    "default-src 'self'",
    // Inline scripts/styles are required by the current single-file pages.
    "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://unicons.iconscout.com",
    "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://unicons.iconscout.com https://fonts.googleapis.com",
    "font-src 'self' data: https://cdnjs.cloudflare.com https://unicons.iconscout.com https://fonts.gstatic.com",
    "img-src 'self' data: https://www.starlink.com https://flagcdn.com",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
].join('; ');

function securityHeaders(req, res, next) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', CSP);
    if (IS_PRODUCTION) {
        res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    // Never let a proxy or browser cache an authenticated API response.
    if (req.path.startsWith('/api/')) {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
        res.setHeader('Pragma', 'no-cache');
    }
    next();
}

// ── CORS ──────────────────────────────────────────────────────
function corsMiddleware(req, res, next) {
    const origin = req.headers.origin;
    const allowed = ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean);

    if (origin && allowed.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Secret, X-CSRF-Token');
        res.setHeader('Access-Control-Max-Age', '86400');
    }

    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
}

// ── API Secret Validation (session-token based) ────────────────
function validateApiSecret(req, res, next) {
    // Header only. Query strings leak into access logs, proxies and Referer.
    const secret = req.headers['x-api-secret'];

    if (!secret || !validateSession(secret)) {
        return res.status(401).json({ success: false, message: 'Unauthorized: invalid or expired session' });
    }
    next();
}

// ── Rate Limiter ──────────────────────────────────────────────
const rateLimitStore = new Map();

function clientKey(req) {
    // req.ip already respects `trust proxy` when it is configured on the app.
    return req.ip || req.connection?.remoteAddress || 'unknown';
}

function rateLimit(options = {}) {
    const windowMs = options.windowMs || RATE_LIMIT_WINDOW;
    const maxRequests = options.maxRequests || RATE_LIMIT_MAX;
    const keyGenerator = options.keyGenerator || clientKey;
    const scope = options.scope || 'global';

    return (req, res, next) => {
        const key = `${scope}:${keyGenerator(req)}`;
        const now = Date.now();

        if (!rateLimitStore.has(key)) {
            rateLimitStore.set(key, { count: 0, resetTime: now + windowMs });
        }

        const record = rateLimitStore.get(key);

        if (now > record.resetTime) {
            record.count = 0;
            record.resetTime = now + windowMs;
        }

        record.count++;

        if (record.count > maxRequests) {
            const retryAfter = Math.ceil((record.resetTime - now) / 1000);
            res.setHeader('Retry-After', retryAfter);
            return res.status(429).json({
                success: false,
                message: 'Too many requests. Please try again later.',
                retryAfter,
            });
        }

        res.setHeader('X-RateLimit-Limit', maxRequests);
        res.setHeader('X-RateLimit-Remaining', Math.max(0, maxRequests - record.count));
        res.setHeader('X-RateLimit-Reset', new Date(record.resetTime).toISOString());
        next();
    };
}

setInterval(() => {
    const now = Date.now();
    for (const [key, record] of rateLimitStore.entries()) {
        if (now > record.resetTime + 60000) rateLimitStore.delete(key);
    }
}, 60000).unref?.();

// ── Kenya phone helpers ───────────────────────────────────────
/**
 * Kenyan mobile numbers are 07xxxxxxxx or 01xxxxxxxx (9 significant digits
 * after the leading 0). Accepts +254, 254, 0 or bare 9-digit forms.
 * @returns {string|null} E.164 form (+254XXXXXXXXX) or null when invalid.
 */
function normalizeKenyaPhone(input) {
    if (typeof input !== 'string') return null;
    const digitsOnly = input.replace(/[\s\-().]/g, '');
    if (!/^\+?\d+$/.test(digitsOnly)) return null;

    let national = digitsOnly.replace(/^\+/, '');
    if (national.startsWith('254')) national = national.slice(3);
    else if (national.startsWith('0')) national = national.slice(1);

    // Safaricom/Airtel/Telkom mobile prefixes all start 7 or 1.
    if (!/^[71]\d{8}$/.test(national)) return null;
    return `+254${national}`;
}

/** Masks a phone for logs: +254712345678 -> +254 71****678 */
function maskPhone(input) {
    const normalized = normalizeKenyaPhone(input);
    const value = normalized || String(input || '');
    if (value.length < 7) return '***';
    return `${value.slice(0, 7)}****${value.slice(-3)}`;
}

// ── Input Validation ──────────────────────────────────────────
const PROVIDER_NAMES = { safaricom: 'Safaricom M-Pesa', airtel: 'Airtel Money' };

/**
 * Human-readable label for a mobile money provider id.
 * Single source of truth so the UI copy cannot drift between routes.
 */
function providerDisplayName(method) {
    return PROVIDER_NAMES[String(method).toLowerCase()] || 'Unknown';
}

const validator = {
    /** Strict Kenya mobile validation — no permissive fallback. */
    phone: (phone) => normalizeKenyaPhone(phone) !== null,

    normalizePhone: normalizeKenyaPhone,

    /** Mobile money PIN: exactly 4 digits (Safaricom/Airtel standard). */
    pin: (pin) => typeof pin === 'string' && /^\d{4}$/.test(pin),

    otp: (otp) => typeof otp === 'string' && /^\d{4,8}$/.test(otp),

    /** Delegates to the package catalog so ids never drift. */
    package: (pkg) => isValidPackage(pkg),

    /** Kenya supports Airtel Money and Safaricom M-Pesa only. */
    method: (method) => typeof method === 'string' && ['airtel', 'safaricom'].includes(method.toLowerCase()),

    /** Positive integer amount in KES, capped to a sane ceiling. */
    amount: (amount) => {
        const n = typeof amount === 'number' ? amount : parseInt(String(amount).replace(/[^\d]/g, ''), 10);
        return Number.isInteger(n) && n > 0 && n <= 1000000;
    },

    requestId: (id) => typeof id === 'string' && /^REQ-[A-Z0-9]{4,24}$/.test(id),

    /** Escapes HTML-significant characters instead of deleting them. */
    sanitize: (str, maxLength = 200) => {
        if (typeof str !== 'string') return '';
        return str
            .trim()
            .slice(0, maxLength)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    },

    password: (pwd) => typeof pwd === 'string' && pwd.length >= 8 && pwd.length <= 128,

    name: (name) => typeof name === 'string' && /^[\p{L}\p{M}'\- .]{2,60}$/u.test(name.trim()),

    /** Free-text location / confirmation message. */
    text: (value, min = 1, max = 1000) =>
        typeof value === 'string' && value.trim().length >= min && value.trim().length <= max,

    /**
     * Validates a payment body (phone + PIN + method + catalog package).
     * Shared so every payment entry point enforces identical rules.
     * @returns {{ok: true, normalizedPhone: string, package: object, method: string, methodName: string}
     *          | {ok: false, field: string, message: string}}
     */
    paymentDetails: (body = {}) => {
        const { phone, pin, method, package: packageId } = body || {};
        const normalizedPhone = normalizeKenyaPhone(phone);
        if (!normalizedPhone) {
            return { ok: false, field: 'phone', message: 'Enter a valid Kenyan number, e.g. 0712 345 678.' };
        }
        if (!validator.pin(pin)) {
            return { ok: false, field: 'pin', message: 'Enter your 4-digit PIN.' };
        }
        if (!validator.method(method)) {
            return { ok: false, field: 'method', message: 'Choose Safaricom M-Pesa or Airtel Money.' };
        }
        const pkg = getPackage(packageId);
        if (!pkg) {
            return { ok: false, field: 'package', message: 'Unknown package. Please pick a bundle again.' };
        }
        return {
            ok: true,
            normalizedPhone,
            package: pkg,
            method,
            methodName: providerDisplayName(method),
        };
    },

    /**
     * Validates an OTP submission body.
     * @returns {{ok: true, requestId: string, otp: string} | {ok: false, field: string, message: string}}
     */
    otpSubmission: (body = {}) => {
        const { requestId, otp } = body || {};
        if (!validator.requestId(requestId)) {
            return { ok: false, field: 'requestId', message: 'Invalid request reference.' };
        }
        if (!validator.otp(otp)) {
            return { ok: false, field: 'otp', message: 'Enter the code sent to your phone (4\u20138 digits).' };
        }
        return { ok: true, requestId, otp };
    },
};

// ── Audit Logger ──────────────────────────────────────────────
/**
 * Validates a registration body. Pure: no I/O, no user-store lookups.
 * On success it also returns the derived normalizedPhone and sanitized name.
 * @returns {{ok: true, normalizedPhone: string, name: string} | {ok: false, field: string, message: string}}
 */
function validateRegistration(body = {}) {
    const { fullName, phone, password, confirmPassword, terms } = body || {};

    if (!fullName || !phone || !password) {
        return { ok: false, field: 'form', message: 'All fields are required.' };
    }
    if (!validator.name(fullName)) {
        return { ok: false, field: 'fullName', message: 'Enter a valid name (2–60 letters).' };
    }
    if (!validator.normalizePhone(phone)) {
        return { ok: false, field: 'phone', message: 'Enter a valid Kenyan number, e.g. 0712 345 678.' };
    }
    if (!validator.password(password)) {
        return { ok: false, field: 'password', message: 'Password must be 8–128 characters.' };
    }
    if (confirmPassword !== undefined && password !== confirmPassword) {
        return { ok: false, field: 'confirmPassword', message: 'Passwords do not match.' };
    }
    if (terms === false) {
        return { ok: false, field: 'terms', message: 'Please accept the terms of use.' };
    }

    return {
        ok: true,
        normalizedPhone: validator.normalizePhone(phone),
        name: validator.sanitize(fullName, 60),
    };
}

/**
 * Validates a login body. Pure: does not touch the user store.
 * @returns {{ok: true, normalizedPhone: string} | {ok: false, field: string, message: string}}
 */
function validateLogin(body = {}) {
    const { phone, password } = body || {};

    if (!phone || !password) {
        return { ok: false, field: 'form', message: 'All fields are required.' };
    }
    if (!validator.normalizePhone(phone)) {
        return { ok: false, field: 'phone', message: 'Enter a valid Kenyan number, e.g. 0712 345 678.' };
    }

    return { ok: true, normalizedPhone: validator.normalizePhone(phone) };
}

const auditLog = {
    file: path.join(__dirname, '..', 'logs', 'audit.log'),

    init() {
        const logDir = path.dirname(this.file);
        if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    },

    write(action, data = {}) {
        const entry = { timestamp: new Date().toISOString(), action, ...data };
        try {
            fs.appendFileSync(this.file, JSON.stringify(entry) + '\n', 'utf8');
        } catch (err) {
            console.error('Audit log write failed:', err.message);
        }
    },

    /** Phone is masked; PIN and OTP are never written to disk. */
    logPaymentRequest(ip, phone, pkg, method, requestId) {
        this.write('PAYMENT_REQUEST', { ip, phone: maskPhone(phone), package: pkg, method, requestId });
    },

    logOtpSubmit(ip, requestId, success) {
        this.write('OTP_SUBMIT', { ip, requestId, success });
    },

    logStatusCheck(ip, requestId, status) {
        this.write('STATUS_CHECK', { ip, requestId, status });
    },

    logAdminAction(action, requestId, adminId) {
        this.write('ADMIN_ACTION', { action, requestId, adminId: String(adminId) });
    },

    logAuth(action, ip, phone, success, reason) {
        this.write(action, { ip, phone: maskPhone(phone), success, ...(reason ? { reason } : {}) });
    },
};

auditLog.init();

// ── Log rotation ──────────────────────────────
// Rotate by renaming the completed file aside and letting the writer create a
// fresh active log. This never rewrites the live file, so lines appended while
// rotation runs cannot be lost, and the event loop is not blocked by a
// read-everything/write-everything cycle.
const AUDIT_ROTATE_BYTES = parseInt(process.env.AUDIT_ROTATE_BYTES || String(10 * 1024 * 1024), 10);
const AUDIT_RETAIN_DAYS = parseInt(process.env.AUDIT_RETAIN_DAYS || '30', 10);
const AUDIT_ARCHIVE_PATTERN = /^audit-(\d{4}-\d{2}-\d{2})\d*(?:\.\d+)?\.log$/;

/** Deletes archived logs older than AUDIT_RETAIN_DAYS. */
function pruneArchivedLogs() {
    const logDir = path.dirname(auditLog.file);
    const cutoff = Date.now() - AUDIT_RETAIN_DAYS * 24 * 60 * 60 * 1000;
    let removed = 0;
    for (const name of fs.readdirSync(logDir)) {
        const match = AUDIT_ARCHIVE_PATTERN.exec(name);
        if (!match) continue;
        if (new Date(`${match[1]}T00:00:00.000Z`).getTime() >= cutoff) continue;
        try {
            fs.unlinkSync(path.join(logDir, name));
            removed++;
        } catch (err) {
            console.error('Audit archive cleanup failed:', err.message);
        }
    }
    return removed;
}

function rotateAuditLog() {
    try {
        if (!fs.existsSync(auditLog.file)) return;
        if (fs.statSync(auditLog.file).size < AUDIT_ROTATE_BYTES) return;

        const date = new Date().toISOString().slice(0, 10);
        const dir = path.dirname(auditLog.file);
        let target = path.join(dir, `audit-${date}.log`);
        for (let i = 1; fs.existsSync(target); i++) target = path.join(dir, `audit-${date}.${i}.log`);

        // Rename is atomic: the active path becomes free and the next append
        // creates a brand-new file. No content is read or rewritten.
        fs.renameSync(auditLog.file, target);
        const pruned = pruneArchivedLogs();
        console.log(`Rotated audit log -> ${path.basename(target)}${pruned ? ` (pruned ${pruned} old archive(s))` : ''}`);
    } catch (err) {
        console.error('Audit log rotation failed:', err.message);
    }
}

setInterval(rotateAuditLog, 24 * 60 * 60 * 1000).unref?.();

module.exports = {
    securityHeaders,
    corsMiddleware,
    validateApiSecret,
    rateLimit,
    validator,
    providerDisplayName,
    PROVIDER_NAMES,
    validateRegistration,
    validateLogin,
    auditLog,
    createSession,
    validateSession,
    safeEqual,
    normalizeKenyaPhone,
    maskPhone,
    IS_PRODUCTION,
};
