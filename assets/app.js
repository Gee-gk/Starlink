/**
 * Starlink Reseller Kenya — shared frontend runtime.
 * Exposes window.SL with API access, formatting and small UI helpers.
 */
(function () {
    'use strict';

    const CURRENCY = 'KES';
    const SESSION_KEY = 'sl_api_token';
    const SESSION_EXP_KEY = 'sl_api_token_expires';
    const AUTH_KEY = 'sl_auth_user';

    // ── Session + CSRF ────────────────────────────────────────
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

    // ── Formatting ────────────────────────────────────────────
    function formatMoney(amount, currency = CURRENCY) {
        const n = Number(amount) || 0;
        return `${currency} ${n.toLocaleString('en-KE')}`;
    }

    /** Formats digits as 0712 345 678 while the user types. */
    function formatKenyaPhoneInput(raw) {
        let digits = String(raw || '').replace(/\D/g, '');
        if (digits.startsWith('254')) digits = '0' + digits.slice(3);
        if (digits && !digits.startsWith('0')) digits = '0' + digits;
        digits = digits.slice(0, 10);
        const parts = [digits.slice(0, 4), digits.slice(4, 7), digits.slice(7, 10)].filter(Boolean);
        return parts.join(' ');
    }

    /** Mirrors the server rule exactly: +254 then 7/1 then 8 digits. */
    function normalizeKenyaPhone(input) {
        if (typeof input !== 'string') return null;
        const compact = input.replace(/[\s\-().]/g, '');
        if (!/^\+?\d+$/.test(compact)) return null;
        let national = compact.replace(/^\+/, '');
        if (national.startsWith('254')) national = national.slice(3);
        else if (national.startsWith('0')) national = national.slice(1);
        if (!/^[71]\d{8}$/.test(national)) return null;
        return `+254${national}`;
    }

    function isValidKenyaPhone(input) {
        return normalizeKenyaPhone(input) !== null;
    }

    function escapeHtml(str) {
        return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
        }[c]));
    }

    // ── Auth state (client-side convenience only) ─────────────
    function getUser() {
        try {
            return JSON.parse(localStorage.getItem(AUTH_KEY) || 'null');
        } catch {
            return null;
        }
    }

    function setUser(user) {
        if (user) localStorage.setItem(AUTH_KEY, JSON.stringify(user));
        else localStorage.removeItem(AUTH_KEY);
    }

    function logout(redirectTo = '/starlink/') {
        setUser(null);
        window.location.href = redirectTo;
    }

    /** Renders the header auth area consistently across pages. */
    function renderAuthNav(containerId = 'auth-nav') {
        const el = document.getElementById(containerId);
        if (!el) return;
        const user = getUser();
        if (user && user.name) {
            const initial = escapeHtml(user.name.trim().charAt(0).toUpperCase());
            el.innerHTML =
                `<span class="hidden md:inline text-xs text-gray-300 mr-1">Hi, ${escapeHtml(user.name.split(' ')[0])}</span>` +
                `<span class="w-7 h-7 rounded-full bg-blue-600 text-white text-xs font-bold flex items-center justify-center" aria-hidden="true">${initial}</span>` +
                `<button type="button" id="sl-logout" class="text-xs font-semibold text-gray-300 hover:text-white ml-2">Log out</button>`;
            const btn = document.getElementById('sl-logout');
            if (btn) btn.addEventListener('click', () => logout());
        } else {
            el.innerHTML =
                `<a href="/starlink/login.html" class="text-xs font-semibold text-gray-300 hover:text-white">Log in</a>` +
                `<a href="/starlink/register.html" class="text-xs font-semibold bg-white text-black px-3 py-1.5 rounded-full hover:bg-gray-200 transition">Sign up</a>`;
        }
    }

    // ── Toast ─────────────────────────────────────────────────
    let toastTimer = null;

    function toast(message, variant = 'info') {
        let el = document.getElementById('sl-toast');
        if (!el) {
            el = document.createElement('div');
            el.id = 'sl-toast';
            el.setAttribute('role', 'status');
            el.setAttribute('aria-live', 'polite');
            el.style.cssText =
                'position:fixed;left:50%;top:20px;transform:translateX(-50%);z-index:100000;' +
                'padding:12px 20px;border-radius:10px;font-size:14px;font-weight:600;color:#fff;' +
                'box-shadow:0 8px 24px rgba(0,0,0,.25);max-width:90vw;text-align:center;display:none;';
            document.body.appendChild(el);
        }
        const colors = { info: '#111827', success: '#15803d', error: '#b91c1c', warn: '#b45309' };
        el.style.background = colors[variant] || colors.info;
        el.textContent = message;
        el.style.display = 'block';
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => {
            el.style.display = 'none';
        }, 3800);
    }

    window.SL = {
        CURRENCY,
        api,
        getSessionToken,
        getCsrfToken,
        formatMoney,
        formatKenyaPhoneInput,
        normalizeKenyaPhone,
        isValidKenyaPhone,
        escapeHtml,
        getUser,
        setUser,
        logout,
        renderAuthNav,
        toast,
    };
})();
