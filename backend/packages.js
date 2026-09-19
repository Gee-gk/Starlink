/**
 * Starlink Reseller Kenya — Package Catalog (single source of truth)
 *
 * Pricing policy: we list our own price only. We do not show a struck-through
 * reference price or name a competitor — customers draw their own comparison.
 * Keep it that way: no `compareAt`, no `savings`, no competitor labels.
 *
 * Currency: KES. Prices are integers (no cents in Kenyan mobile money UX).
 */

const CURRENCY = 'KES';

/** @typedef {'daily'|'weekly'|'monthly'|'unlimited'} Category */

const CATEGORIES = [
    { id: 'daily', name: 'Daily Bundles', tagline: 'Valid 24 hours', icon: 'uil-sun', accent: 'green' },
    { id: 'weekly', name: 'Weekly Bundles', tagline: 'Valid 7 days', icon: 'uil-calendar-alt', accent: 'blue' },
    { id: 'monthly', name: 'Monthly Bundles', tagline: 'Valid 30 days', icon: 'uil-calendar-slash', accent: 'purple' },
    { id: 'unlimited', name: 'Unlimited Monthly', tagline: 'No data caps, 30 days', icon: 'uil-infinity', accent: 'orange' },
];

const PACKAGES = [
    // ── Daily (24 hours) ─────────────────────────────────────────
    {
        id: 'daily-500mb', category: 'daily', name: '500 MB', data: '500 MB', duration: '24 hours',
        price: 20,
        speed: 'Up to 20 Mbps', features: ['500 MB high-speed data', 'Valid for 24 hours', 'Instant activation'],
    },
    {
        id: 'daily-1gb', category: 'daily', name: '1 GB', data: '1 GB', duration: '24 hours',
        price: 49,
        speed: 'Up to 30 Mbps', features: ['1 GB high-speed data', 'Valid for 24 hours', 'Instant activation'],
        popular: true,
    },
    {
        id: 'daily-2gb', category: 'daily', name: '2 GB', data: '2 GB', duration: '24 hours',
        price: 79,
        speed: 'Up to 30 Mbps', features: ['2 GB high-speed data', 'Valid for 24 hours', 'HD streaming'],
    },
    {
        id: 'daily-4gb', category: 'daily', name: '4 GB', data: '4 GB', duration: '24 hours',
        price: 129,
        speed: 'Up to 50 Mbps', features: ['4 GB high-speed data', 'Valid for 24 hours', 'HD streaming'],
    },
    {
        id: 'daily-8gb', category: 'daily', name: '8 GB', data: '8 GB', duration: '24 hours',
        price: 199,
        speed: 'Up to 50 Mbps', features: ['8 GB high-speed data', 'Valid for 24 hours', 'Great for tethering'],
    },
    {
        id: 'daily-unlimited', category: 'daily', name: 'Unlimited', data: 'Unlimited', duration: '24 hours',
        price: 249,
        speed: 'Up to 30 Mbps', features: ['Truly unlimited data', 'Valid for 24 hours', 'No throttling'],
        unlimited: true,
    },

    // ── Weekly (7 days) ──────────────────────────────────────────
    {
        id: 'weekly-1gb', category: 'weekly', name: '1 GB', data: '1 GB', duration: '7 days',
        price: 99,
        speed: 'Up to 30 Mbps', features: ['1 GB high-speed data', 'Valid for 7 days', 'Instant activation'],
    },
    {
        id: 'weekly-3gb', category: 'weekly', name: '3 GB', data: '3 GB', duration: '7 days',
        price: 199,
        speed: 'Up to 30 Mbps', features: ['3 GB high-speed data', 'Valid for 7 days', 'HD streaming'],
        popular: true,
    },
    {
        id: 'weekly-6gb', category: 'weekly', name: '6 GB', data: '6 GB', duration: '7 days',
        price: 349,
        speed: 'Up to 50 Mbps', features: ['6 GB high-speed data', 'Valid for 7 days', 'HD streaming'],
    },
    {
        id: 'weekly-12gb', category: 'weekly', name: '12 GB', data: '12 GB', duration: '7 days',
        price: 549,
        speed: 'Up to 50 Mbps', features: ['12 GB high-speed data', 'Valid for 7 days', 'Priority support'],
    },
    {
        id: 'weekly-unlimited', category: 'weekly', name: 'Unlimited', data: 'Unlimited', duration: '7 days',
        price: 799,
        speed: 'Up to 40 Mbps', features: ['Truly unlimited data', 'Valid for 7 days', 'No throttling'],
        unlimited: true,
    },

    // ── Monthly (30 days, capped) ────────────────────────────────
    {
        id: 'monthly-3gb', category: 'monthly', name: '3 GB', data: '3 GB', duration: '30 days',
        price: 299,
        speed: 'Up to 30 Mbps', features: ['3 GB high-speed data', 'Valid for 30 days', 'Instant activation'],
    },
    {
        id: 'monthly-8gb', category: 'monthly', name: '8 GB', data: '8 GB', duration: '30 days',
        price: 599,
        speed: 'Up to 30 Mbps', features: ['8 GB high-speed data', 'Valid for 30 days', 'HD streaming'],
        popular: true,
    },
    {
        id: 'monthly-15gb', category: 'monthly', name: '15 GB', data: '15 GB', duration: '30 days',
        price: 899,
        speed: 'Up to 50 Mbps', features: ['15 GB high-speed data', 'Valid for 30 days', 'HD streaming'],
    },
    {
        id: 'monthly-30gb', category: 'monthly', name: '30 GB', data: '30 GB', duration: '30 days',
        price: 1299,
        speed: 'Up to 50 Mbps', features: ['30 GB high-speed data', 'Valid for 30 days', 'Priority support'],
    },
    {
        id: 'monthly-60gb', category: 'monthly', name: '60 GB', data: '60 GB', duration: '30 days',
        price: 1899,
        speed: 'Up to 80 Mbps', features: ['60 GB high-speed data', 'Valid for 30 days', '4K streaming'],
    },
    {
        id: 'monthly-100gb', category: 'monthly', name: '100 GB', data: '100 GB', duration: '30 days',
        price: 2499,
        speed: 'Up to 100 Mbps', features: ['100 GB high-speed data', 'Valid for 30 days', '4K streaming', 'Priority support'],
    },

    // ── Unlimited Monthly ────────────────────────────────────────
    {
        id: 'unlimited-lite', category: 'unlimited', name: 'Unlimited Lite', data: 'Unlimited', duration: '30 days',
        price: 1999,
        speed: 'Up to 10 Mbps', features: ['Truly unlimited data', 'Valid for 30 days', 'Up to 10 Mbps', 'Ideal for 1–3 devices'],
        unlimited: true,
    },
    {
        id: 'unlimited-plus', category: 'unlimited', name: 'Unlimited Plus', data: 'Unlimited', duration: '30 days',
        price: 2799,
        speed: 'Up to 30 Mbps', features: ['Truly unlimited data', 'Valid for 30 days', 'Up to 30 Mbps', 'HD streaming on 5+ devices'],
        unlimited: true, popular: true,
    },
    {
        id: 'unlimited-pro', category: 'unlimited', name: 'Unlimited Pro', data: 'Unlimited', duration: '30 days',
        price: 3499,
        speed: 'Up to 60 Mbps', features: ['Truly unlimited data', 'Valid for 30 days', 'Up to 60 Mbps', '4K streaming', 'Priority support'],
        unlimited: true,
    },
];

/** Frozen id set used for O(1) server-side validation. */
const PACKAGE_IDS = Object.freeze(PACKAGES.map((p) => p.id));

/** @returns {object[]} Catalog decorated with the display currency. */
function listPackages() {
    return PACKAGES.map((p) => ({ ...p, currency: CURRENCY }));
}

/** @returns {object|null} Single package by id, or null when unknown. */
function getPackage(id) {
    if (typeof id !== 'string') return null;
    return listPackages().find((p) => p.id === id) || null;
}

/** @returns {boolean} True when the id exists in the catalog. */
function isValidPackage(id) {
    return typeof id === 'string' && PACKAGE_IDS.includes(id);
}

module.exports = { CURRENCY, CATEGORIES, PACKAGE_IDS, listPackages, getPackage, isValidPackage };
