/**
 * Starlink Reseller Kenya — render helpers (DOM only).
 * Header auth area + the shared toast notification.
 * Attaches to the shared window.SL namespace created by sl-core.js.
 */
(function () {
    'use strict';

    const SL = (window.SL = window.SL || {});
    const escape = SL.escapeHtml || ((s) => String(s == null ? '' : s));

    /** Renders the header auth area consistently across pages. */
    function renderAuthNav(containerId = 'auth-nav') {
        const el = document.getElementById(containerId);
        if (!el) return;
        const user = SL.getUser ? SL.getUser() : null;
        if (user && user.name) {
            const initial = escape(user.name.trim().charAt(0).toUpperCase());
            el.innerHTML =
                `<span class="hidden md:inline text-xs text-gray-300 mr-1">Hi, ${escape(user.name.split(' ')[0])}</span>` +
                `<span class="w-7 h-7 rounded-full bg-blue-600 text-white text-xs font-bold flex items-center justify-center" aria-hidden="true">${initial}</span>` +
                `<button type="button" id="sl-logout" class="text-xs font-semibold text-gray-300 hover:text-white ml-2">Log out</button>`;
            const btn = document.getElementById('sl-logout');
            if (btn) btn.addEventListener('click', () => SL.logout());
        } else {
            el.innerHTML =
                `<a href="/starlink/login.html" class="text-xs font-semibold text-gray-300 hover:text-white">Log in</a>` +
                `<a href="/starlink/register.html" class="text-xs font-semibold bg-white text-black px-3 py-1.5 rounded-full hover:bg-gray-200 transition">Sign up</a>`;
        }
    }

    // ── Toast ─────────────────
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

    SL.renderAuthNav = renderAuthNav;
    SL.toast = toast;
})();
