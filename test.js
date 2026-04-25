/**
 * Tempo Terminal · Live API smoke test
 * ────────────────────────────────────
 * Hits a running `node server.js` on http://localhost:3000 and exercises
 * every public endpoint, including the live-billing intents (~$0.20 of
 * real wallet spend). Use `npm run sim` for a free, mocked alternative.
 *
 *   node server.js   # in one terminal
 *   npm test         # in another
 */

'use strict';

const http = require('http');
const BASE = 'http://localhost:3000';

let passed = 0, failed = 0, skipped = 0;

async function req(method, path, body) {
    return new Promise((resolve, reject) => {
        const url = new URL(path, BASE);
        const opts = { hostname: url.hostname, port: url.port, path: url.pathname, method, headers: {} };
        if (body) {
            opts.headers['Content-Type'] = 'application/json';
        }
        const r = http.request(opts, res => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => {
                try { resolve({ status: res.statusCode, data: JSON.parse(d) }); }
                catch { resolve({ status: res.statusCode, data: d }); }
            });
        });
        r.on('error', reject);
        r.setTimeout(30000, () => { r.destroy(); reject(new Error('timeout')); });
        if (body) r.write(JSON.stringify(body));
        r.end();
    });
}

function assert(name, condition, detail) {
    if (condition) { passed++; console.log(`  PASS  ${name}`); }
    else { failed++; console.log(`  FAIL  ${name} — ${detail || 'assertion failed'}`); }
}

async function test(name, fn) {
    try { await fn(); }
    catch (e) { failed++; console.log(`  FAIL  ${name} — ${e.message}`); }
}

async function run() {
    console.log('\n  Tempo Terminal — API Test Suite\n');

    // ═══ GET endpoints ═══
    console.log('  --- GET endpoints ---');

    await test('GET /api/models', async () => {
        const r = await req('GET', '/api/models');
        assert('status 200', r.status === 200);
        assert('has catalog array', Array.isArray(r.data.catalog));
        assert('has 20+ models', r.data.catalog.length >= 20, `got ${r.data.catalog.length}`);
        assert('has current model', typeof r.data.current === 'string');
        assert('models have required fields', r.data.catalog[0].id && r.data.catalog[0].name && r.data.catalog[0].tier !== undefined);
        const tiers = [...new Set(r.data.catalog.map(m => m.tier))];
        assert('has 4 tiers', tiers.length === 4, `got: ${tiers.join(', ')}`);
        assert('has free tier', tiers.includes('free'));
    });

    await test('GET /api/presets', async () => {
        const r = await req('GET', '/api/presets');
        assert('status 200', r.status === 200);
        assert('has presets array', Array.isArray(r.data.presets));
        assert('has 6+ presets', r.data.presets.length >= 6, `got ${r.data.presets.length}`);
        assert('has current preset', typeof r.data.current === 'string');
        assert('presets have id/name/prompt', r.data.presets[0].id && r.data.presets[0].name && r.data.presets[0].prompt);
    });

    await test('GET /api/image-models', async () => {
        const r = await req('GET', '/api/image-models');
        assert('status 200', r.status === 200);
        assert('has models array', Array.isArray(r.data.models));
        assert('has 4 image models', r.data.models.length === 4, `got ${r.data.models.length}`);
        assert('has current', typeof r.data.current === 'string');
        const names = r.data.models.map(m => m.name);
        assert('includes Flux Schnell', names.includes('Flux Schnell'));
        assert('includes NanoBanana', names.includes('NanoBanana 2'));
    });

    await test('GET /api/services', async () => {
        const r = await req('GET', '/api/services');
        assert('status 200', r.status === 200);
        assert('has services array', Array.isArray(r.data.services));
        assert('has 30+ services', r.data.services.length >= 30, `got ${r.data.services.length}`);
        assert('has pricing object', typeof r.data.pricing === 'object');
        assert('pricing has 12 types', Object.keys(r.data.pricing).length >= 12, `got ${Object.keys(r.data.pricing).length}`);
    });

    await test('GET /api/stats', async () => {
        const r = await req('GET', '/api/stats');
        assert('status 200', r.status === 200);
        assert('has total', typeof r.data.total === 'number');
        assert('has daily_spent', typeof r.data.daily_spent === 'number');
        assert('has daily_limit', typeof r.data.daily_limit === 'number');
    });

    // ═══ POST setters ═══
    console.log('\n  --- POST setters ---');

    await test('POST /api/models/set (valid)', async () => {
        const r = await req('POST', '/api/models/set', { model_id: 'openai/gpt-4o-mini' });
        assert('status 200', r.status === 200);
        assert('success true', r.data.success === true);
    });

    await test('POST /api/models/set (invalid)', async () => {
        const r = await req('POST', '/api/models/set', { model_id: 'fake/model' });
        assert('status 400', r.status === 400);
        assert('has error', typeof r.data.error === 'string');
    });

    await test('POST /api/presets/set (valid)', async () => {
        const r = await req('POST', '/api/presets/set', { preset_id: 'coder' });
        assert('status 200', r.status === 200);
        assert('success true', r.data.success === true);
        // Reset to default
        await req('POST', '/api/presets/set', { preset_id: 'default' });
    });

    await test('POST /api/presets/set (invalid)', async () => {
        const r = await req('POST', '/api/presets/set', { preset_id: 'fake' });
        assert('status 400', r.status === 400);
    });

    await test('POST /api/image-models/set (valid)', async () => {
        const r = await req('POST', '/api/image-models/set', { model_id: 'nano-banana' });
        assert('status 200', r.status === 200);
        assert('success true', r.data.success === true);
        // Reset
        await req('POST', '/api/image-models/set', { model_id: 'flux-schnell' });
    });

    // ═══ Validation ═══
    console.log('\n  --- Input validation ---');

    await test('POST /api/chat (empty)', async () => {
        const r = await req('POST', '/api/chat', { message: '' });
        assert('status 400', r.status === 400);
        assert('error message', r.data.error === 'Empty message');
    });

    await test('POST /api/chat (too long)', async () => {
        const r = await req('POST', '/api/chat', { message: 'x'.repeat(5000) });
        assert('status 400', r.status === 400);
        assert('length error', r.data.error?.includes('4000'));
    });

    await test('POST /api/chat (empty command)', async () => {
        const r = await req('POST', '/api/chat', { message: 'draw ' });
        assert('status 200', r.status === 200);
        assert('shows help', r.data.content?.includes('provide input') || r.data.content?.includes('help'));
    });

    await test('POST /api/race (too few models)', async () => {
        const r = await req('POST', '/api/race', { message: 'test', models: ['openai/gpt-4o-mini'] });
        assert('status 400', r.status === 400);
        assert('needs 2+ models', r.data.error?.includes('2'));
    });

    await test('POST /api/race (too many models)', async () => {
        const r = await req('POST', '/api/race', { message: 'test', models: ['a','b','c','d','e','f'] });
        assert('status 400', r.status === 400);
        assert('max 5', r.data.error?.includes('5'));
    });

    // ═══ Live API tests (costs money!) ═══
    console.log('\n  --- Live API tests (uses wallet) ---');

    await test('POST /api/chat — crypto (price of btc)', async () => {
        const r = await req('POST', '/api/chat', { message: 'price of btc' });
        assert('status 200', r.status === 200);
        assert('type text', r.data.type === 'text');
        assert('has BTC in content', r.data.content?.toUpperCase().includes('BTC'));
        assert('has cost', typeof r.data.cost === 'number' && r.data.cost > 0);
    });

    await test('POST /api/chat — wolfram (calc 2+2)', async () => {
        const r = await req('POST', '/api/chat', { message: 'calc 2+2' });
        assert('status 200', r.status === 200);
        assert('type text', r.data.type === 'text');
        assert('answer contains 4', r.data.content?.includes('4'));
    });

    await test('POST /api/chat — translate', async () => {
        const r = await req('POST', '/api/chat', { message: 'translate hello to spanish' });
        assert('status 200', r.status === 200);
        assert('type text', r.data.type === 'text');
        assert('has hola', r.data.content?.toLowerCase().includes('hola'));
    });

    await test('POST /api/chat — weather', async () => {
        const r = await req('POST', '/api/chat', { message: 'weather in London' });
        assert('status 200', r.status === 200);
        assert('type text', r.data.type === 'text');
        assert('has temperature', r.data.content?.includes('°C'));
    });

    await test('POST /api/chat — code execution', async () => {
        const r = await req('POST', '/api/chat', { message: 'run python print(7*6)' });
        assert('status 200', r.status === 200);
        assert('type text', r.data.type === 'text');
        assert('output contains 42', r.data.content?.includes('42'));
    });

    await test('POST /api/chat — TTS', async () => {
        const r = await req('POST', '/api/chat', { message: 'read aloud: hello world' });
        assert('status 200', r.status === 200);
        assert('type audio', r.data.type === 'audio');
        assert('has audio content', r.data.content?.startsWith('data:audio') || r.data.content?.startsWith('http'));
    });

    await test('POST /api/chat — image', async () => {
        const r = await req('POST', '/api/chat', { message: 'draw a red circle' });
        assert('status 200', r.status === 200);
        assert('type image', r.data.type === 'image');
        assert('has image content', typeof r.data.content === 'string' && r.data.content.length > 10);
    });

    // ═══ Summary ═══
    console.log(`\n  ════════════════════════════════════`);
    console.log(`  Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);
    console.log(`  ════════════════════════════════════\n`);

    process.exit(failed > 0 ? 1 : 0);
}

run();
