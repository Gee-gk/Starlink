'use strict';

/**
 * Unit tests for the package catalog (backend/packages.js).
 * Run with: npm test
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    CURRENCY,
    CATEGORIES,
    PACKAGE_IDS,
    listPackages,
    getPackage,
    isValidPackage,
} = require('../backend/packages');

test('catalog shape: currency, categories and packages are present', () => {
    assert.equal(CURRENCY, 'KES');
    assert.ok(Array.isArray(CATEGORIES));
    assert.ok(CATEGORIES.length > 0);

    const packages = listPackages();
    assert.ok(packages.length > 0);
    // Every declared category must have at least one package.
    const categoryIds = new Set(CATEGORIES.map((c) => c.id));
    for (const pkg of packages) {
        assert.ok(categoryIds.has(pkg.category), `unknown category: ${pkg.category}`);
    }
});

test('every package has a complete, well-typed shape', () => {
    for (const pkg of listPackages()) {
        assert.equal(typeof pkg.id, 'string', 'id');
        assert.equal(typeof pkg.name, 'string', `${pkg.id} name`);
        assert.equal(typeof pkg.duration, 'string', `${pkg.id} duration`);
        assert.ok(Number.isInteger(pkg.price) && pkg.price > 0, `${pkg.id} price`);
        assert.ok(Array.isArray(pkg.features) && pkg.features.length > 0, `${pkg.id} features`);
        assert.equal(pkg.currency, 'KES', `${pkg.id} currency`);
    }
});

test('package ids are unique', () => {
    const ids = listPackages().map((p) => p.id);
    assert.equal(new Set(ids).size, ids.length);
});

test('listPackages exposes our price only — no competitor comparison', () => {
    for (const pkg of listPackages()) {
        assert.equal(pkg.currency, 'KES', `${pkg.id} currency`);
        assert.ok(Number.isInteger(pkg.price) && pkg.price > 0, `${pkg.id} price`);
        // Marketing policy: we never publish a struck-through price, a saving
        // figure, or a named competitor in the catalog payload.
        assert.equal(pkg.compareAt, undefined, `${pkg.id} must not expose compareAt`);
        assert.equal(pkg.compareLabel, undefined, `${pkg.id} must not expose compareLabel`);
        assert.equal(pkg.savings, undefined, `${pkg.id} must not expose savings`);
        assert.equal(pkg.savingsPercent, undefined, `${pkg.id} must not expose savingsPercent`);
    }
});

test('getPackage returns a decorated package and null for unknown ids', () => {
    const known = PACKAGE_IDS[0];
    const found = getPackage(known);
    assert.ok(found, 'expected a package');
    assert.equal(found.id, known);
    assert.equal(typeof found.price, 'number');

    assert.equal(getPackage('does-not-exist'), null);
    assert.equal(getPackage(null), null);
    assert.equal(getPackage(undefined), null);
    assert.equal(getPackage(123), null);
});

test('isValidPackage accepts catalog ids and rejects everything else', () => {
    for (const id of PACKAGE_IDS) {
        assert.equal(isValidPackage(id), true, id);
    }
    assert.equal(isValidPackage('nope'), false);
    assert.equal(isValidPackage(''), false);
    assert.equal(isValidPackage(null), false);
    assert.equal(isValidPackage(undefined), false);
    assert.equal(isValidPackage(42), false);
});

test('PACKAGE_IDS is a frozen snapshot of the catalog', () => {
    assert.ok(Object.isFrozen(PACKAGE_IDS));
    assert.deepEqual([...PACKAGE_IDS], listPackages().map((p) => p.id));
});
