// Loads the real plans.html over HTTP into a jsdom DOM, executes its scripts,
// and asserts the package grid renders cards (not the "Loading bundles…"
// skeletons). This is the end-to-end check that catches a syntax error in a
// page's inline script — which a module-level test cannot see.
//
// Requires a running server (npm start) and jsdom (npm i -D jsdom).
// Run: BASE=http://localhost:3000 node test/plans-e2e.js
const { JSDOM, VirtualConsole } = require('jsdom');

const BASE = process.env.BASE || 'http://localhost:3999';

async function main() {
    const html = await (await fetch(`${BASE}/starlink/plans.html`)).text();

    if (/'<ul class="pkg-feat"> \+/.test(html)) {
        console.log('FAIL: page still has the unterminated pkg-feat string');
        process.exit(1);
    }

    const errors = [];
    const vc = new VirtualConsole();
    vc.on('jsdomError', (e) => errors.push(String((e && e.message) || e)));
    vc.on('error', (...a) => errors.push(a.join(' ')));

    const dom = new JSDOM(html, {
        url: `${BASE}/starlink/plans.html`,
        runScripts: 'dangerously',
        resources: 'usable',
        pretendToBeVisual: true,
        virtualConsole: vc,
        beforeParse(win) {
            // jsdom has no fetch; hand the page Node's implementation so its
            // window.SL.api() calls reach the running server.
            win.fetch = (u, o) => fetch(new URL(u, `${BASE}/starlink/plans.html`).href, o);
            win.Headers = Headers;
            win.Request = Request;
            win.Response = Response;
        },
    });

    // Give scripts + the /api/packages fetch time to settle.
    await new Promise((r) => setTimeout(r, 4000));

    const doc = dom.window.document;
    const cards = doc.querySelectorAll('#grid .pkg');
    const catTitle = (doc.getElementById('cat-title') || {}).textContent || '';
    const gridHtml = doc.getElementById('grid').innerHTML;
    const errBox = doc.getElementById('grid-error');
    const errHidden = !errBox || errBox.classList.contains('hidden');

    console.log(`render errors: ${errors.length ? errors.join(' | ') : 'none'}`);
    console.log(`#grid .pkg cards : ${cards.length}`);
    console.log(`#cat-title       : ${JSON.stringify(catTitle)}`);
    console.log(`grid contains skeleton: ${/skel/.test(gridHtml)}`);

    let failed = 0;
    if (errors.length) { console.log('FAIL: page emitted script errors'); failed++; }
    if (cards.length === 0) { console.log('FAIL: no package cards rendered'); failed++; }
    if (/Loading bundles/.test(catTitle)) { console.log('FAIL: cat-title still shows loading placeholder'); failed++; }
    if (!errHidden) { console.log('FAIL: grid-error is visible'); failed++; }

    if (failed) {
        console.log(`plans e2e: ${failed} failure(s)`);
        dom.window.close();
        process.exit(1);
    }
    console.log(`plans e2e OK — ${cards.length} package cards rendered`);
    dom.window.close();
}

main().catch((e) => { console.error('e2e crashed:', e); process.exit(1); });
