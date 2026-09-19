/**
 * Starlink Reseller Kenya — auth state (client-side convenience only).
 * The server never trusts this; it only drives nav rendering and prefills.
 * Attaches to the shared window.SL namespace created by sl-core.js.
 */
(function () {
    'use strict';

    const SL = (window.SL = window.SL || {});
    const AUTH_KEY = SL.AUTH_KEY || 'sl_auth_user';

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

    SL.getUser = getUser;
    SL.setUser = setUser;
    SL.logout = logout;
})();
