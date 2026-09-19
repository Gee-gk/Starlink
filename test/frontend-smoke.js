// Loads the front-end modules in page order inside a minimal DOM shim and
// asserts that window.SL ends up fully populated. Run: node test/frontend-smoke.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ASSETS = path.join(__dirname, '..', 'assets');
const ORDER = ['sl-formatters.js', 'sl-auth.js', 'sl-render.js', 'sl-core.js', 'app.js'];

const appended = [];
const sandboxConsole = { log() {}, warn() {}, error: (...a) => appended.push(['console.error', a.join(' ')]) };

const document = {
    readyState: 'complete',
    getElementById: () => null,
    createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
    addEventListener() {},
    body: { appendChild() {} },
};

const storage = () => {
    const m = new Map();
    return {
        getItem: (k) => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => m.set(k, String(v)),
        removeItem: (k) => m.delete(k),
    };
};

const sandbox = {
    console: sandboxConsole,
    document,
    sessionStorage: storage(),
    localStorage: storage(),
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    setTimeout,
    clearTimeout,
    Date,
    Math,
    JSON,
    Number,
    String,
    Object,
    Array,
    RegExp,
    Buffer,
    window: {},
};
sandbox.window = sandbox;
vm.createContext(sandbox);

for (const file of ORDER) {
    const code = fs.readFileSync(path.join(ASSETS, file), 'utf8');
    vm.runInContext(code, sandbox, { filename: file });
}

const SL = sandbox.SL;
const required = [
    'CURRENCY', 'api', 'getSessionToken', 'getCsrfToken', 'formatMoney',
    'formatKenyaPhoneInput', 'normalizeKenyaPhone', 'isValidKenyaPhone',
    'escapeHtml', 'getUser', 'setUser', 'logout', 'renderAuthNav', 'toast',
];

const missing = required.filter((k) => SL[k] === undefined);
const wrongType = required.filter((k) => typeof SL[k] === 'function' && typeof SL[k] !== 'function');

let failed = 0;
if (missing.length) {
    console.error('FAIL missing from window.SL:', missing.join(', '));
    failed++;
}
const nonFunctions = required.filter((k) => k !== 'CURRENCY' && typeof SL[k] !== 'function');
if (nonFunctions.length) {
    console.error('FAIL not callable:', nonFunctions.join(', '));
    failed++;
}

// Spot-check behaviour that the pages depend on.
const checks = [
    ['formatMoney(1299)', SL.formatMoney(1299) === 'KES 1,299'],
    ['formatKenyaPhoneInput', SL.formatKenyaPhoneInput('0712345678') === '0712 345 678'],
    ['normalizeKenyaPhone', SL.normalizeKenyaPhone('0712345678') === '+254712345678'],
    ['isValidKenyaPhone bad', SL.isValidKenyaPhone('0000') === false],
    ['escapeHtml', SL.escapeHtml('<b>"x"</b>').includes('&lt;')],
];
for (const [name, ok] of checks) {
    if (!ok) {
        console.error('FAIL check:', name);
        failed++;
    }
}

if (appended.length) {
    console.error('FAIL console.error was emitted:', appended.map((a) => a[1]).join(' | '));
    failed++;
}

if (failed) {
    console.error(`frontend smoke: ${failed} failure(s)`);
    process.exit(1);
}
console.log(`frontend smoke OK — ${required.length} SL exports wired in load order`);
