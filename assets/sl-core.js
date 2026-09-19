/**
 * Starlink Reseller Kenya — shared frontend runtime core.
 *
 * Holds the cross-cutting concerns used by every page and by the feature
 * modules in this folder: session/CSRF handling, the fetch wrapper, the single
 * `window.SL` namespace object and page-bootstrap helpers.
 *
 * Load order (see the <script> tags in each page):
 *   1. assets/sl-core.js        — this file, defines window.SL
 *   2. assets/sl-formatters.js  — SL.formatMoney / phone helpers / escapeHtml
 *   3. assets/sl-render.js      — SL.renderAuthNav, SL.toast
 *   4. assets/sl-auth.js        — SL.getUser / setUser / logout
 *   5. assets/app.js            — legacy filename, kept as a thin loader
 *
 * Keeping the namespace on a single object means every existing inline page
 * script (`window.SL.api(...)`) keeps working unchanged.
 */
(function () {
    'use strict';

    const CURRENCY = 'KES';
    const SESSION_KEY = 'sl_api_token';
    const SESSION_EXP_KEY = 'sl_api_token_expires';
    const AUTH_KEY = 'sl_auth_user';

    const SL = {
        CURRENCY,
        SESSION_KEY,
        SESSION_EXP_KEY,
        AUTH_KEY,
    };

    window.SL = SL;

    // ── Session + CSRF ────────────────────────
    let sessionPromise = null;

    async function getSessionToken(forceNew) {
        if (forceNew) {
            sessionStorage.removeItem(SESSION_KEY);
            sessionStorage.removeItem(SESSION_EXP_KEY);
            sessionPromise = null;
        }

        const cached = sessionStorage.getItem(SESSION_KEY);
        const expires = parseInt(sessionStorage.getItem(SESSION_EXP_KEY) || '0', 10);
        // 30s safety margin so a token cannot expire mid-request.
        if (cached && Date.now() < expires - 30000) return cached;

        if (!sessionPromise) {
            sessionPromise = fetch('/api/auth/session', { method: 'POST' })
                .then((r) => r.json())
                .then((data) => {
                    if (!data || !data.success || !data.token) throw new Error('Session unavailable');
                    sessionStorage.setItem(SESSION_KEY, data.token);
                    sessionStorage.setItem(SESSION_EXP_KEY, String(Date.now() + (data.expiresIn || 3600000)));
                    return data.token;
                })
                .finally(() => {
                    sessionPromise = null;
                });
        }
        return sessionPromise;
    }

    async function getCsrfToken() {
        const token = await getSessionToken();
        const res = await fetch('/api/csrf-token', { headers: { 'X-API-Secret': token } });
        if (res.status === 401) {
            const fresh = await getSessionToken(true);
            const retry = await fetch('/api/csrf-token', { headers: { 'X-API-Secret': fresh } });
            const retryData = await retry.json();
            return { sessionToken: fresh, csrfToken: retryData.csrfToken };
        }
        const data = await res.json();
        if (!data || !data.csrfToken) throw new Error('Security token unavailable');
        return { sessionToken: token, csrfToken: data.csrfToken };
    }

    /** GET/POST helper that attaches the session token and parses JSON safely. */
    async function api(pathname, options = {}) {
        const { method = 'GET', body, auth = true, csrf = false } = options;
        const headers = { Accept: 'application/json' };
        if (body !== undefined) headers['Content-Type'] = 'application/json';

        let sessionToken = null;
        if (auth || csrf) sessionToken = await getSessionToken();

        if (csrf) {
            const pair = await getCsrfToken();
            sessionToken = pair.sessionToken;
            headers['X-CSRF-Token'] = pair.csrfToken;
        }
        if (sessionToken) headers['X-API-Secret'] = sessionToken;

        const res = await fetch(pathname, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
        });

        let data = null;
        try {
            data = await res.json();
        } catch {
            data = null;
        }
        return { ok: res.ok, status: res.status, data: data || {} };
    }

    SL.getSessionToken = getSessionToken;
    SL.getCsrfToken = getCsrfToken;
    SL.api = api;

    // ── Bootstrap ─────────────────────────────
    /** Runs `fn` once the DOM is parsed (immediately when already ready). */
    SL.ready = function ready(fn) {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', fn, { once: true });
        } else {
            fn();
        }
    };

    /** Paints contact details from /api/config into the footer links. */
    SL.loadSupportDetails = async function loadSupportDetails() {
        const res = await api('/api/config', { auth: false });
        if (!res.ok) return null;
        const { supportEmail, supportPhone, methods } = res.data;
        if (supportEmail) {
            const el = document.getElementById('footEmail');
            if (el) {
                el.textContent = supportEmail;
                el.href = `mailto:${supportEmail}`;
            }
        }
        if (supportPhone) {
            const el = document.getElementById('footPhone');
            if (el) el.textContent = supportPhone;
        }
        return { supportEmail, supportPhone, methods };
    };
})();
