'use strict';

/**
 * Canonical Kenyan mobile-number normalization — single source of truth.
 *
 * Both the server (backend/security.js) and the browser bundle
 * (assets/sl-formatters.js) must agree on what a valid Kenyan number is. The
 * browser cannot `require`, so sl-formatters.js carries a byte-for-byte mirror
 * of this logic; this module is the definition that mirror follows.
 *
 * Rule: 07xxxxxxxx or 01xxxxxxxx (9 significant digits after the leading 0).
 * Accepts +254, 254, 0 or bare 9-digit forms.
 *
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

module.exports = { normalizeKenyaPhone };
