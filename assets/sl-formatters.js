/**
 * Starlink Reseller Kenya — pure formatting + phone helpers.
 * No DOM access, no network: safe to unit-test and reuse anywhere.
 * Attaches to the shared window.SL namespace created by sl-core.js.
 */
(function () {
    'use strict';

    const SL = (window.SL = window.SL || {});
    const CURRENCY = SL.CURRENCY || 'KES';

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

    SL.formatMoney = formatMoney;
    SL.formatKenyaPhoneInput = formatKenyaPhoneInput;
    SL.normalizeKenyaPhone = normalizeKenyaPhone;
    SL.isValidKenyaPhone = isValidKenyaPhone;
    SL.escapeHtml = escapeHtml;
})();
