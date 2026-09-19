const express = require('express');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { listPackages, CURRENCY } = require('./packages');
const { securityHeaders, corsMiddleware, auditLog, IS_PRODUCTION } = require('./security');
const { cleanupExpiredCsrfTokens } = require('./helpers');
const { publicRouter, webhookRouter } = require('./routes');
const app = express();
const PORT = process.env.PORT || 3000;
const ROOT = path.join(__dirname, '..');

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

// Expired CSRF tokens are dropped on a timer rather than accumulating forever.
setInterval(cleanupExpiredCsrfTokens, 5 * 60 * 1000).unref?.();

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

// ── API ────────────────────────────────────────────────
// All route handlers live in routes.js; server.js only wires middleware order.
app.use('/api/webhook', webhookRouter);
app.use('/api', publicRouter);

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
