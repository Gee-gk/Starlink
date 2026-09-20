/**
 * Starlink Reseller Kenya — legacy frontend entry point.
 *
 * The runtime used to live entirely in this file. It is now split into small
 * single-purpose modules that all attach to the same window.SL namespace, so
 * every existing inline page script keeps working unchanged:
 *
 *   sl-core.js       — session/CSRF + api() + bootstrap helpers
 *   sl-formatters.js — money/phone formatting and escapeHtml
 *   sl-render.js     — renderAuthNav + toast
 *   sl-auth.js       — getUser/setUser/logout
 *
 * Keep this file as the last <script> on the page: it only guarantees the
 * namespace exists and warns loudly if a module did not load.
 */
(function () {
    'use strict';

    // Every module above attaches itself to window.SL. This file no longer
    // re-implements any of them — it only makes the namespace safe to touch on
    // pages that include app.js without the sl-*.js tags.
    window.SL = window.SL || {};

    // Warn (rather than silently break every page) if a module failed to load.
    const required = ['api', 'formatMoney', 'escapeHtml', 'renderAuthNav', 'toast', 'getUser'];
    const missing = required.filter((name) => typeof window.SL[name] !== 'function');
    if (missing.length) {
        console.error('Starlink frontend: missing SL helpers — check the sl-*.js script tags:', missing.join(', '));
    }
})();
