/**
 * Tempo Terminal — Telegram bot simulation harness
 *
 * Loads telegram-bot.js with mock TelegramBot and tempo-cli, fires synthetic
 * messages and callback queries, observes bot behavior. The intent is to
 * exercise every documented user flow and surface mismatches between what the
 * bot does and what a user reasonably expects.
 *
 * Run:  node sim.js
 *
 * Severity: C = critical (money / lost feature) · M = medium · L = low (cosmetic)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

// ════════════════════════════════════════════════════════════════════════
//  1 · Sandboxed cwd so .env / state / spending stay out of the real repo
// ════════════════════════════════════════════════════════════════════════
const SANDBOX = path.join(__dirname, '.sim-sandbox');
fs.rmSync(SANDBOX, { recursive: true, force: true });
fs.mkdirSync(SANDBOX, { recursive: true });
process.chdir(SANDBOX);

process.env.TELEGRAM_BOT_TOKEN  = 'mock-token';
process.env.ALLOWED_USERS       = '12345';
process.env.MAX_DAILY_SPEND     = '3.0';
process.env.CONFIRM_THRESHOLD   = '0.50';
process.env.LOW_BALANCE_WARN    = '5.0';
process.env.LOW_BALANCE_CRITICAL = '1.0';
process.env.RATE_LIMIT_SEC      = '0';   // no gap during sim
process.env.RATE_LIMIT_MIN      = '999';
process.env.CONTEXT_WINDOW      = '6';
delete process.env.DEBUG;

// ════════════════════════════════════════════════════════════════════════
//  2 · Mocks
// ════════════════════════════════════════════════════════════════════════
const captured = { tg: null };
const tempoResponses = new Map();   // url → response | { _error: {...} }
const tempoCalls = [];              // [{ method, url, body }]

function setTempo(url, resp)   { tempoResponses.set(url, resp); }
function failTempo(url, opts)  { tempoResponses.set(url, { _error: opts || { stderr: 'mock failure' } }); }

class MockTelegramBot {
    constructor(token) {
        this.token = token;
        this._textHandlers = [];
        this._eventHandlers = {};
        this._msgIdCounter = 1000;
        this.sent = [];
        this.edited = [];
        this.deleted = [];
        this.answers = [];
        this.actions = [];
        captured.tg = this;
    }
    onText(regex, cb)            { this._textHandlers.push([regex, cb]); }
    on(event, cb)                { (this._eventHandlers[event] = this._eventHandlers[event] || []).push(cb); }
    async getMe()                { return { username: 'sim_bot', id: 1 }; }
    async stopPolling()          { return true; }
    async sendChatAction(c, a)   { this.actions.push({ chat: c, action: a }); return true; }
    async sendMessage(chatId, text, opts = {}) {
        const id = ++this._msgIdCounter;
        this.sent.push({ kind: 'message', chatId, text, opts, id });
        return { message_id: id, chat: { id: chatId } };
    }
    async sendPhoto(chatId, photo, opts = {}) {
        const id = ++this._msgIdCounter;
        this.sent.push({ kind: 'photo', chatId, photo, opts, id });
        return { message_id: id };
    }
    async sendVoice(chatId, voice, opts = {}) {
        const id = ++this._msgIdCounter;
        this.sent.push({ kind: 'voice', chatId, voice, opts, id });
        return { message_id: id };
    }
    async sendAudio(chatId, audio, opts = {}) {
        const id = ++this._msgIdCounter;
        this.sent.push({ kind: 'audio', chatId, audio, opts, id });
        return { message_id: id };
    }
    async editMessageText(text, opts = {}) {
        this.edited.push({ kind: 'text', text, opts });
        return true;
    }
    async editMessageReplyMarkup(markup, opts = {}) {
        this.edited.push({ kind: 'replyMarkup', markup, opts });
        return true;
    }
    async deleteMessage(chatId, msgId) {
        this.deleted.push({ chatId, msgId });
        return true;
    }
    async answerCallbackQuery(id, opts = {}) {
        this.answers.push({ id, opts });
        return true;
    }

    // Harness helpers
    _fireMessage(msg) {
        // /commands route through onText handlers; everything still hits 'message'
        if (msg.text && msg.text.startsWith('/')) {
            for (const [regex, cb] of this._textHandlers) {
                const m = msg.text.match(regex);
                if (m) cb(msg, m);
            }
        }
        for (const cb of (this._eventHandlers.message || [])) cb(msg);
    }
    _fireCallback(query) {
        for (const cb of (this._eventHandlers.callback_query || [])) cb(query);
    }
    _reset() {
        this.sent = []; this.edited = []; this.deleted = []; this.answers = []; this.actions = [];
    }
}

const mockTempoCli = {
    findTempo: async () => ({ binary: 'tempo', useWsl: false }),
    runTempo: async (args) => {
        if (args[0] === 'wallet' && args[1] === 'whoami') {
            return {
                stdout: JSON.stringify({
                    ready: true,
                    wallet: '0x' + 'a'.repeat(40),
                    balance: { available: '20.0', total: '21.0', locked: '1.0', symbol: 'USDC.e' },
                    key: { spending_limit: { limit: '100', remaining: '95', spent: '5', unlimited: false } }
                }),
                stderr: ''
            };
        }
        if (args[0] === 'request') {
            // ['request', '-X', 'POST', '--json', body, url]  or
            // ['request', '-X', 'GET',  url]
            const method = args[2] || 'POST';
            let body = null, url;
            if (args[3] === '--json') {
                body = JSON.parse(args[4]);
                url  = args[5];
            } else {
                url = args[3];
            }
            tempoCalls.push({ method, url, body });
            const resp = tempoResponses.get(url);
            if (!resp) {
                const err = new Error('No mock');
                err.stderr = 'no mock for ' + url;
                err.stdout = '';
                throw err;
            }
            if (resp._error) {
                const err = new Error(resp._error.msg || 'mock error');
                err.stderr = resp._error.stderr || '';
                err.stdout = resp._error.stdout || '';
                throw err;
            }
            return { stdout: JSON.stringify(resp), stderr: '' };
        }
        return { stdout: '', stderr: '' };
    }
};

// ════════════════════════════════════════════════════════════════════════
//  3 · Inject mocks before telegram-bot.js loads
// ════════════════════════════════════════════════════════════════════════
const origRequire = Module.prototype.require;
Module.prototype.require = function(name) {
    if (name === 'node-telegram-bot-api')   return MockTelegramBot;
    if (name === './tempo-cli')             return mockTempoCli;
    return origRequire.apply(this, arguments);
};

// Track setTimeout calls (for polling verification). Don't actually fire them
// during sim — we only care about the SETUP, not the polling loop itself.
const scheduled = [];
const origSetTimeout = global.setTimeout;
global.setTimeout = (cb, ms, ...rest) => {
    if (typeof cb === 'function' && ms >= 5000) {
        scheduled.push({ ms, cb });
        return { _sim: true };
    }
    return origSetTimeout(cb, ms, ...rest);
};

// Suppress the bot's loud boot banner
const origLog = console.log;
console.log = () => {};

require(path.join(__dirname, 'telegram-bot.js'));

console.log = origLog;
const bot = captured.tg;

// ════════════════════════════════════════════════════════════════════════
//  4 · Scenario runner
// ════════════════════════════════════════════════════════════════════════
const findings = [];
let scenarios = 0, passed = 0, failed = 0;

const COLOR = {
    pass:   '\x1b[32m✓\x1b[0m',
    fail:   '\x1b[31m✗\x1b[0m',
    warn:   '\x1b[33m⚠\x1b[0m',
    head:   (s) => '\x1b[1m\x1b[36m' + s + '\x1b[0m',
    dim:    (s) => '\x1b[2m'        + s + '\x1b[0m',
    sev:    { C: '\x1b[1m\x1b[31mC\x1b[0m', M: '\x1b[33mM\x1b[0m', L: '\x1b[2mL\x1b[0m' }
};

function expect(name, condition, severity, expected, actual) {
    if (condition) {
        passed++;
        process.stdout.write(`     ${COLOR.pass} ${name}\n`);
    } else {
        failed++;
        findings.push({ scenario: currentScenario, name, severity, expected, actual });
        process.stdout.write(`     ${COLOR.fail} ${name}  ${COLOR.dim('[' + severity + ']')}\n`);
        if (expected) process.stdout.write(`        ${COLOR.dim('expected: ' + expected)}\n`);
        if (actual)   process.stdout.write(`        ${COLOR.dim('actual:   ' + actual)}\n`);
    }
}

let currentScenario = '';
async function scenario(name, fn) {
    scenarios++;
    currentScenario = name;
    bot._reset();
    tempoCalls.length = 0;
    scheduled.length = 0;
    resetCsv();
    process.stdout.write(`\n${COLOR.head('▸ ' + name)}\n`);
    try { await fn(); }
    catch (e) {
        failed++;
        findings.push({ scenario: name, name: 'threw', severity: 'C', actual: e.message });
        process.stdout.write(`     ${COLOR.fail} threw: ${e.message}\n`);
    }
}

function makeMsg(text, userId = 12345, chatId = 99999) {
    return {
        message_id: Math.floor(Math.random() * 1e9),
        from: { id: userId, first_name: 'Alice', is_bot: false },
        chat: { id: chatId, type: 'private' },
        text,
        date: Math.floor(Date.now() / 1000)
    };
}

function makeCallback(data, userId = 12345, chatId = 99999, msgId = 1001) {
    return {
        id: 'cbq_' + Math.random().toString(36).slice(2),
        from: { id: userId, first_name: 'Alice' },
        message: { message_id: msgId, chat: { id: chatId } },
        data
    };
}

const wait = (ms) => new Promise(r => origSetTimeout(r, ms));

function dailySpent() {
    try { return JSON.parse(fs.readFileSync('./bot-state.json', 'utf8')).daily_spent || 0; }
    catch { return 0; }
}
function spendingRows() {
    if (!fs.existsSync('./spending.csv')) return [];
    return fs.readFileSync('./spending.csv', 'utf8').trim().split('\n').filter(Boolean);
}
// spending.csv is appended synchronously per charge — most reliable signal.
function totalCharged(typeFilter) {
    return spendingRows()
        .filter(r => !typeFilter || r.split(',')[2] === typeFilter)
        .reduce((s, r) => s + (parseFloat(r.split(',')[3]) || 0), 0);
}
function resetCsv() { try { fs.unlinkSync('./spending.csv'); } catch {} }
function resetState() {
    try { fs.unlinkSync('./bot-state.json'); } catch {}
    try { fs.unlinkSync('./spending.csv');    } catch {}
    // Force StateManager to re-read by mutating its data directly via the
    // fact that we required telegram-bot.js once — simpler: restart sim.
    // For this harness we accept that scenarios share state and only verify
    // DELTAS where it matters.
}

// ════════════════════════════════════════════════════════════════════════
//  5 · Scenarios
// ════════════════════════════════════════════════════════════════════════
(async () => {
    // Boot settles
    await wait(50);
    bot._reset();

    // ── Group 1: Slash commands ────────────────────────────────────────
    await scenario('S1 · /start (private, whitelisted)', async () => {
        bot._fireMessage(makeMsg('/start'));
        await wait(20);
        expect('responds with welcome', bot.sent.length === 1, 'C',
            '1 message', `${bot.sent.length} messages`);
        expect('has inline keyboard', bot.sent[0]?.opts?.reply_markup?.inline_keyboard, 'L');
    });

    await scenario('S2 · /start@SimBot (group-style with @suffix)', async () => {
        bot._fireMessage(makeMsg('/start@some_bot'));
        await wait(20);
        expect('responds in group context', bot.sent.length >= 1, 'C',
            'welcome message',
            bot.sent.length === 0 ? 'silent (regex /^\\/start$/ rejects @-suffix)' : 'OK');
    });

    await scenario('S3 · /start from non-whitelisted user', async () => {
        bot._fireMessage(makeMsg('/start', /* userId */ 99999));
        await wait(20);
        const text = (bot.sent[0]?.text || '').toLowerCase();
        const isAccessDenied = /access denied|denied/i.test(text);
        const isWelcome = /pay.as.you.go|tempo terminal|just type/i.test(text);
        expect('blocks unauthorized welcome', !isWelcome, 'C',
            'either silent or "Access denied"',
            isWelcome ? 'sent welcome to non-whitelisted user' : 'OK');
        expect('shows Access denied for parity with on(message)',
            bot.sent.length === 0 || isAccessDenied, 'C');
    });

    await scenario('S4 · /help from non-whitelisted user', async () => {
        bot._fireMessage(makeMsg('/help', 99999));
        await wait(20);
        expect('consistent UX (says something)', bot.sent.length > 0, 'M',
            '"Access denied" message (parity with bot.on(message))',
            'silent — user thinks bot is dead');
    });

    await scenario('S5 · /balance@SimBot (group)', async () => {
        bot._fireMessage(makeMsg('/balance@sim_bot'));
        await wait(50);
        expect('responds to /balance@bot in groups', bot.sent.length >= 1, 'C',
            'balance message',
            bot.sent.length === 0 ? 'silent (regex without (@\\w+)? alt)' : 'OK');
    });

    await scenario('S6 · /context badarg (lazy regex)', async () => {
        bot._fireMessage(makeMsg('/context badarg blah'));
        await wait(20);
        const txt = bot.sent[0]?.text || '';
        expect('rejects bad arg or shows help', !txt.includes('badarg'), 'M',
            'either error or generic help',
            'matched as if no arg, shows status');
    });

    await scenario('S7 · /contextxxx (no separator)', async () => {
        bot._fireMessage(makeMsg('/contextxxx'));
        await wait(20);
        expect('does not match /context regex', bot.sent.length === 0, 'M',
            'no response (regex should anchor)',
            bot.sent.length > 0 ? '/^\\/context(?:\\s+...)?/i matches /contextxxx — missing $' : 'OK');
    });

    // ── Group 2: Plain message intents ──────────────────────────────────
    await scenario('S8 · "hello" (plain chat)', async () => {
        setTempo('https://parallelmpp.dev/api/search', { results: [{ title: 't', url: 'u' }] });
        setTempo('https://openrouter.mpp.tempo.xyz/v1/chat/completions',
            { choices: [{ message: { content: 'Hi there.' } }] });
        bot._fireMessage(makeMsg('hello'));
        await wait(50);
        const charged = totalCharged('chat');
        expect('charge includes search base ($0.01)', charged >= 0.025, 'C',
            '$0.025 (LLM 0.015 + search 0.01)',
            `$${charged} — chat.base ($0.01) NOT included in totalCost`);
        expect('records spending row', spendingRows().filter(r => r.includes(',chat,')).length >= 1, 'M');
    });

    await scenario('S9 · "draw " (empty image prompt)', async () => {
        setTempo('https://fal.mpp.tempo.xyz/fal-ai/flux/schnell', { images: [{ url: 'http://x' }] });
        bot._fireMessage(makeMsg('draw '));
        await wait(50);
        const charged = totalCharged('image');
        const lastSent = bot.sent[bot.sent.length - 1];
        expect('does NOT charge for empty prompt', charged === 0, 'C',
            '$0 + help message',
            `charged $${charged} — fal.ai actually called with empty prompt`);
        expect('returns helpful message (server.js has this guard, telegram-bot.js does not)',
            (lastSent?.text || lastSent?.opts?.caption || '').match(/provide|help|prompt|input/i), 'C',
            '"Please provide input after the command"',
            `last msg: "${(lastSent?.text || lastSent?.opts?.caption || '').slice(0, 60)}"`);
    });

    await scenario('S10 · "translate" (alone)', async () => {
        setTempo('https://deepl.mpp.paywithlocus.com/deepl/translate',
            { translations: [{ text: '' }] });
        bot._fireMessage(makeMsg('translate'));
        await wait(50);
        expect('does NOT charge for empty translate', totalCharged('translate') === 0, 'C',
            '$0 + help', `charged $${totalCharged('translate')}`);
    });

    await scenario('S11 · "weather" (alone, no city)', async () => {
        setTempo('https://openweather.mpp.paywithlocus.com/openweather/geocode', []);
        bot._fireMessage(makeMsg('weather'));
        await wait(50);
        expect('does NOT charge for empty location', totalCharged('weather') === 0, 'C',
            '$0 + help', `charged $${totalCharged('weather')}`);
    });

    await scenario('S12 · "deep research crypto regulation" — confirm + polling', async () => {
        setTempo('https://parallelmpp.dev/api/task', { run_id: 'task_abc' });
        bot._fireMessage(makeMsg('deep research crypto regulation'));
        await wait(50);
        const charged = totalCharged('research');
        const confirmMsg = bot.sent.find(m => /confirm/i.test(m.text || ''));
        expect('asks for confirmation on $0.10 task', !!confirmMsg, 'C',
            'confirmation prompt before charging',
            `no confirmation, immediate charge $${charged}`);

        // Now click Yes and verify polling kicks off + parent task is charged
        if (!confirmMsg) return;
        const yesBtn = confirmMsg.opts.reply_markup.inline_keyboard[0]
            .find(b => /spend|✓/i.test(b.text));
        bot._fireCallback({ ...makeCallback(yesBtn.callback_data),
            message: { message_id: confirmMsg.id, chat: { id: 99999 } } });
        await wait(80);
        expect('after Yes → research charged $0.10', totalCharged('research') === 0.10, 'C',
            '$0.10', `$${totalCharged('research')}`);
        expect('after Yes → pollResearch scheduled (15s)',
            scheduled.some(s => s.ms === 15000), 'L');
    });

    await scenario('S13 · "music chill beat" — confirm + polling', async () => {
        setTempo('https://suno.mpp.paywithlocus.com/suno/generate-music',
            { data: { taskId: 'mus_abc' } });
        bot._fireMessage(makeMsg('music chill beat'));
        await wait(50);
        const confirmMsg = bot.sent.find(m => /confirm/i.test(m.text || ''));
        expect('asks for confirmation on $0.105 task', !!confirmMsg, 'C',
            'confirmation prompt', `no confirmation`);

        if (!confirmMsg) return;
        const yesBtn = confirmMsg.opts.reply_markup.inline_keyboard[0]
            .find(b => /spend|✓/i.test(b.text));
        bot._fireCallback({ ...makeCallback(yesBtn.callback_data),
            message: { message_id: confirmMsg.id, chat: { id: 99999 } } });
        await wait(80);
        expect('after Yes → music charged $0.105',
            Math.abs(totalCharged('music') - 0.105) < 1e-6, 'C');
        expect('pollMusic scheduled (10s)',
            scheduled.some(s => s.ms === 10000), 'L');
    });

    await scenario('S14 · "extract from https://a.com" (1 URL = $0.01)', async () => {
        setTempo('https://parallelmpp.dev/api/extract', 'extracted');
        bot._fireMessage(makeMsg('extract from https://example.com'));
        await wait(50);
        const charged = totalCharged('extract');
        expect('charges per URL ($0.01)', Math.abs(charged - 0.01) < 1e-6, 'L',
            '$0.01', `$${charged}`);
    });

    // ── Group 3: Voice / image-model UX ─────────────────────────────────
    await scenario('S15 · /voice picker → setvoice:adam → handleTTS uses voice?', async () => {
        bot._fireMessage(makeMsg('/voice'));
        await wait(20);
        const voiceMenu = bot.sent[0];
        expect('voice menu opens', voiceMenu?.opts?.reply_markup?.inline_keyboard, 'L');

        // Click adam
        bot._fireCallback(makeCallback('setvoice:adam'));
        await wait(20);

        // Now invoke TTS and inspect what gets sent to Deepgram
        setTempo('https://deepgram.mpp.paywithlocus.com/deepgram/speak',
            { audio_url: 'http://audio' });
        bot._reset();
        tempoCalls.length = 0;
        bot._fireMessage(makeMsg('read aloud: hi'));
        await wait(50);
        const ttsCall = tempoCalls.find(c => c.url.includes('deepgram/speak'));
        expect('voice param is passed to Deepgram', ttsCall?.body?.voice === 'adam', 'C',
            '{ text, voice: "adam" }',
            `body sent: ${JSON.stringify(ttsCall?.body)}  — /voice setting is dead code`);
    });

    await scenario('S16 · No /image_model command', async () => {
        bot._fireMessage(makeMsg('/image_model'));
        await wait(20);
        bot._fireMessage(makeMsg('/imagemodel'));
        await wait(20);
        expect('there is a way to switch image model in Telegram', bot.sent.length > 0, 'C',
            'a menu like /model',
            'no handler — Telegram users are stuck on flux-schnell');
    });

    // ── Group 4: Confirmation flow ──────────────────────────────────────
    await scenario('S17 · Threshold=$0.50: only multi-URL extract triggers confirm', async () => {
        const urls = Array.from({ length: 60 }, (_, i) => `https://a${i}.com`);
        setTempo('https://parallelmpp.dev/api/extract', 'ok');
        bot._fireMessage(makeMsg('extract from ' + urls.join(' ')));
        await wait(50);
        const confirmMsgs = bot.sent.filter(m => /confirm/i.test(m.text || ''));
        expect('60-URL extract ($0.60) DOES ask confirmation',
            confirmMsgs.length > 0, 'L', 'confirmation', `none seen (sent ${bot.sent.length} msgs)`);
    });

    // ── Group 5: Markdown / fallback / footer ───────────────────────────
    await scenario('S18 · Chat: LLM returns broken Markdown — fallback drops footer', async () => {
        setTempo('https://parallelmpp.dev/api/search', { results: [] });
        setTempo('https://openrouter.mpp.tempo.xyz/v1/chat/completions',
            { choices: [{ message: { content: 'Use _foo to call __bar' } }] });
        // Patch sendMessage to fail on parse_mode:Markdown
        const origSend = bot.sendMessage.bind(bot);
        bot.sendMessage = async function(chatId, text, opts = {}) {
            if (opts.parse_mode === 'Markdown' && /__|\*\*/.test(text)) {
                throw new Error('Bad Request: can\'t parse entities');
            }
            return origSend(chatId, text, opts);
        };
        bot._fireMessage(makeMsg('what about underscores _x_'));
        await wait(50);
        bot.sendMessage = origSend;
        const last = bot.sent[bot.sent.length - 1];
        expect('fallback sends content', last?.text?.includes('Use _foo'), 'L');
        expect('fallback includes cost footer',
            (last?.text || '').includes('$0.015') || (last?.text || '').includes('via'), 'M',
            'footer with cost/model preserved',
            'footer dropped on Markdown fallback');
    });

    // ── Group 6: Translate Markdown safety ──────────────────────────────
    await scenario('S19 · Translate: target language with special chars', async () => {
        setTempo('https://deepl.mpp.paywithlocus.com/deepl/translate',
            { translations: [{ text: '*hello*' }] });
        const origSend = bot.sendMessage.bind(bot);
        let mdFail = 0;
        bot.sendMessage = async function(chatId, text, opts = {}) {
            if (opts.parse_mode === 'Markdown' && /\*hello\*/.test(text)) {
                mdFail++;
                throw new Error('parse error');
            }
            return origSend(chatId, text, opts);
        };
        bot._fireMessage(makeMsg('translate hi to spanish'));
        await wait(50);
        bot.sendMessage = origSend;
        expect('handleTranslate has Markdown fallback', mdFail === 0 || bot.sent.length > 0,
            'M', 'either escapeMd works OR fallback resends without parse_mode',
            'no fallback in handleTranslate — outer catch fires "Retry" with refund');
    });

    // ── Group 7: Refund on edge cases ───────────────────────────────────
    await scenario('S20 · Crypto: unknown ticker → refund', async () => {
        setTempo('https://coingecko.mpp.paywithlocus.com/coingecko/simple-price', {});
        bot._fireMessage(makeMsg('price of fakecoin'));
        await wait(50);
        expect('does not record charge for unknown ticker', totalCharged('crypto') === 0, 'L',
            '$0', `$${totalCharged('crypto')}`);
    });

    await scenario('S21 · MPP error → refund + retry button', async () => {
        failTempo('https://parallelmpp.dev/api/search', { stderr: 'insufficient funds' });
        bot._fireMessage(makeMsg('what is btc'));
        await wait(50);
        const lastErr = bot.sent[bot.sent.length - 1];
        expect('does not record charge on MPP failure', totalCharged('chat') === 0, 'L');
        expect('shows retry button',
            lastErr?.opts?.reply_markup?.inline_keyboard?.flat()?.some(b => /retry/i.test(b.text)), 'L');
    });

    // ── Group 8: Callbacks (model picker / close) ───────────────────────
    await scenario('S22 · /model → setmodel:claude → menu stays', async () => {
        bot._fireMessage(makeMsg('/model'));
        await wait(20);
        bot._reset();
        bot._fireCallback(makeCallback('setmodel:anthropic/claude-haiku-4.5'));
        await wait(20);
        expect('switch confirmed via toast', bot.answers.length > 0, 'L');
        expect('keeps keyboard so user can pick another',
            bot.edited.some(e => e.opts?.reply_markup?.inline_keyboard), 'L');
    });

    await scenario('S23 · close button on /model menu — destroys context', async () => {
        bot._fireMessage(makeMsg('/model'));
        await wait(20);
        bot._reset();
        bot._fireCallback(makeCallback('close', 12345, 99999, 1001));
        await wait(20);
        expect('preserves header text (status of selection)',
            bot.deleted.length === 0, 'M',
            'editMessageReplyMarkup({ inline_keyboard: [] }) — keep history',
            'deleteMessage — entire menu vanishes, including the "Current model:" text');
    });

    await scenario('S24 · close on a >48h-old message: deleteMessage fails silently', async () => {
        const origDelete = bot.deleteMessage.bind(bot);
        bot.deleteMessage = async () => { throw new Error('Bad Request: message can\'t be deleted'); };
        bot._fireCallback(makeCallback('close'));
        await wait(20);
        bot.deleteMessage = origDelete;
        expect('falls back to remove keyboard',
            bot.edited.some(e => e.kind === 'replyMarkup'), 'M',
            'editMessageReplyMarkup as fallback',
            'silent .catch(()=>{}) — keyboard hangs forever, buttons unresponsive');
    });

    // ── Group 9: Confirmation race ──────────────────────────────────────
    await scenario('S25 · Confirmation: cancel button works', async () => {
        setTempo('https://parallelmpp.dev/api/extract', 'ok');
        const big = Array.from({ length: 60 }, (_, i) => `https://a${i}.com`).join(' ');
        bot._fireMessage(makeMsg('extract from ' + big));
        await wait(30);
        const confirm = bot.sent.find(m => /confirm/i.test(m.text || ''));
        expect('confirm message sent', !!confirm, 'L');
        if (!confirm) return;
        const noBtn = confirm.opts.reply_markup.inline_keyboard[0]
            .find(b => /cancel|✗/i.test(b.text));
        expect('cancel button present', !!noBtn, 'L');
        bot._fireCallback({ ...makeCallback(noBtn.callback_data), message: { message_id: confirm.id, chat: { id: 99999 } } });
        await wait(20);
        expect('cancel does not record charge', totalCharged('extract') === 0, 'C',
            '$0', `$${totalCharged('extract')}`);
    });

    // ── Group 10: Polling cost tracking ─────────────────────────────────
    await scenario('S26 · Research polling cost recorded in spending.csv', async () => {
        const code = fs.readFileSync(path.join(__dirname, 'telegram-bot.js'), 'utf8');
        // Look anywhere in the file (recordPoll helper or inline call).
        const callsPollSpending = /spending\.record\(\s*['"]poll_research['"]/.test(code)
            || /recordPoll\(\s*['"]research['"]/.test(code);
        expect('pollResearch records each poll cost', callsPollSpending, 'C',
            'spending.record/recordPoll for poll_research',
            'no per-poll ledger entry');
    });

    await scenario('S27 · Music polling cost recorded in spending.csv', async () => {
        const code = fs.readFileSync(path.join(__dirname, 'telegram-bot.js'), 'utf8');
        const callsPollSpending = /spending\.record\(\s*['"]poll_music['"]/.test(code)
            || /recordPoll\(\s*['"]music['"]/.test(code);
        expect('pollMusic records each poll cost', callsPollSpending, 'C');
    });

    // ── Group 11: Empty research result → refund ────────────────────────
    await scenario('S28 · Research empty output triggers refund', async () => {
        const code = fs.readFileSync(path.join(__dirname, 'telegram-bot.js'), 'utf8');
        // Look 600 chars BEFORE and AFTER the empty-output sentinel: the
        // refund must live near the branch that detects emptiness.
        const idx = code.indexOf('returned empty output');
        const block = idx < 0 ? '' : code.slice(Math.max(0, idx - 600), idx + 600);
        const hasRefund = /addDailySpend\(\s*-|research_refund/.test(block);
        expect('refund logic on empty output', hasRefund, 'C',
            'state.addDailySpend(-cost) near "returned empty output"',
            'no refund — user pays for nothing');
    });

    // ── Group 12: Bot restart resumes polling ───────────────────────────
    await scenario('S29 · pending_tasks in bot-state survives restart', async () => {
        const code = fs.readFileSync(path.join(__dirname, 'telegram-bot.js'), 'utf8');
        const hasQueue = /pending_tasks|addPendingTask|resumePendingTasks/.test(code);
        expect('persistent task queue exists', hasQueue, 'C',
            'bot-state.json holds in-flight polling tasks',
            'all polling in setTimeout closures');
    });

    // ── Group 13: Whoami parser still works (regression check) ──────────
    await scenario('S30 · /balance parses JSON whoami (post-fix regression)', async () => {
        bot._fireMessage(makeMsg('/balance'));
        await wait(50);
        const txt = bot.sent[0]?.text || '';
        expect('shows USDC amount', /\$20\.00/.test(txt), 'L',
            '$20.00', txt.slice(0, 100));
        expect('shows wallet address (truncated)',
            /0xa+…?a*/.test(txt) || /0x[a]{4,}/.test(txt), 'L',
            'address shown truncated', txt.match(/0x[a-f]+\S*/)?.[0]);
    });

    // ── Group 14: Additional UX scenarios ───────────────────────────────
    await scenario('S31 · /stats — column alignment for long type names', async () => {
        // Synthesize spending rows of varying name lengths
        fs.appendFileSync('./spending.csv',
            `${new Date().toISOString()},12345,chat,0.025,"a"\n` +
            `${new Date().toISOString()},12345,poll_research,0.005,"x"\n`);
        bot._fireMessage(makeMsg('/stats'));
        await wait(80);
        // /stats is async (await denyIfNotAllowed); the breakdown lives in
        // the message that contains both type names. Find it.
        const txt = (bot.sent.find(m =>
            (m.text || '').includes('chat') && (m.text || '').includes('poll_research')
        )?.text) || '';
        const lines = txt.split('\n').filter(l => /\`[a-z_]+\s*\`\s+\$/.test(l));
        const dollarPositions = lines.map(l => l.indexOf('$'));
        const aligned = dollarPositions.length >= 2
            && dollarPositions.every(p => p === dollarPositions[0]);
        expect('$ amounts column-aligned (dynamic padEnd)', aligned, 'L',
            'all rows have $ at the same column',
            `lines:${lines.length}  positions:${JSON.stringify(dollarPositions)}`);
    });

    await scenario('S32 · Error message references model — /change-model retry button', async () => {
        failTempo('https://parallelmpp.dev/api/search', { stderr: 'rate limit' });
        bot._fireMessage(makeMsg('hi'));
        await wait(50);
        const errMsg = bot.sent[bot.sent.length - 1];
        const buttons = errMsg?.opts?.reply_markup?.inline_keyboard?.flat() || [];
        expect('error UI offers Retry + Change model',
            buttons.some(b => /retry/i.test(b.text)) &&
            buttons.some(b => /model|change/i.test(b.text)), 'L');
    });

    await scenario('S33 · /context show with empty context', async () => {
        bot._fireMessage(makeMsg('/context show'));
        await wait(20);
        const txt = bot.sent[0]?.text || '';
        expect('says "Context empty" cleanly', /empty/i.test(txt), 'L',
            'graceful empty state', txt.slice(0, 80));
    });

    await scenario('S34 · close button on /voice removes keyboard cleanly', async () => {
        bot._fireMessage(makeMsg('/voice'));
        await wait(20);
        const menu = bot.sent[0];
        const closeBtn = menu?.opts?.reply_markup?.inline_keyboard
            ?.flat()?.find(b => b.callback_data === 'close');
        expect('close button present', !!closeBtn, 'L');
        bot._fireCallback(makeCallback('close'));
        await wait(20);
        // Post-fix: close calls editMessageReplyMarkup (preserves text, works
        // on >48h messages). The OLD broken behaviour was deleteMessage.
        const stripped = bot.edited.some(e => e.kind === 'replyMarkup'
            && Array.isArray(e.markup?.inline_keyboard)
            && e.markup.inline_keyboard.length === 0);
        expect('close strips keyboard via editMessageReplyMarkup', stripped, 'L',
            'editMessageReplyMarkup({ inline_keyboard: [] })',
            `deleted=${bot.deleted.length}, edited=${bot.edited.length}`);
    });

    await scenario('S35 · /clear silences if context is empty (no error spam)', async () => {
        bot._fireMessage(makeMsg('/clear'));
        await wait(20);
        const txt = bot.sent[0]?.text || '';
        expect('confirms clear succinctly', /clear/i.test(txt), 'L');
    });

    await scenario('S36 · Plain message exceeding 4000 chars', async () => {
        const long = 'x'.repeat(5000);
        bot._fireMessage(makeMsg(long));
        await wait(20);
        const txt = bot.sent[0]?.text || '';
        expect('rejects with length error', /too long|4000/i.test(txt), 'L',
            'length warning', txt.slice(0, 80));
    });

    await scenario('S37 · /context off, then chat — context not added', async () => {
        bot._fireMessage(makeMsg('/context off'));
        await wait(20);
        bot._reset();
        setTempo('https://parallelmpp.dev/api/search', { results: [] });
        setTempo('https://openrouter.mpp.tempo.xyz/v1/chat/completions',
            { choices: [{ message: { content: 'A.' } }] });
        bot._fireMessage(makeMsg('test'));
        await wait(50);
        // Verify context is NOT being passed in LLM messages
        const llmCall = tempoCalls.find(c => c.url.includes('chat/completions'));
        const messages = llmCall?.body?.messages || [];
        const hasOldContext = messages.some(m => m.role === 'user' && /test/.test(m.content) && messages.indexOf(m) < messages.length - 1);
        expect('does not send prior turns when context off', !hasOldContext, 'L');
    });

    // ════════════════════════════════════════════════════════════════════
    //  6 · Final report
    // ════════════════════════════════════════════════════════════════════
    process.stdout.write(`
${COLOR.head('═══════════════════════════════════════════════════════════════')}
${COLOR.head('  RESULTS')}
${COLOR.head('═══════════════════════════════════════════════════════════════')}
  Scenarios:  ${scenarios}
  Assertions: ${passed + failed}   (${COLOR.pass}${passed} pass${COLOR.fail.replace('✗','')}  ${COLOR.fail}${failed} fail)

`);

    if (findings.length) {
        process.stdout.write(`${COLOR.head('FINDINGS BY SEVERITY')}\n\n`);
        const order = { C: 0, M: 1, L: 2 };
        findings.sort((a, b) => order[a.severity] - order[b.severity]);
        for (const f of findings) {
            process.stdout.write(`  ${COLOR.sev[f.severity]}  ${f.scenario}\n`);
            process.stdout.write(`     ${f.name}\n`);
            if (f.expected) process.stdout.write(`     ${COLOR.dim('expected: ' + f.expected)}\n`);
            if (f.actual)   process.stdout.write(`     ${COLOR.dim('actual:   ' + f.actual)}\n`);
            process.stdout.write('\n');
        }
    }

    // Counts by severity
    const counts = { C: 0, M: 0, L: 0 };
    for (const f of findings) counts[f.severity]++;
    process.stdout.write(`${COLOR.head('SEVERITY TALLY')}    `);
    process.stdout.write(`${COLOR.sev.C}: ${counts.C}   ${COLOR.sev.M}: ${counts.M}   ${COLOR.sev.L}: ${counts.L}\n\n`);

    process.exit(failed > 0 ? 1 : 0);
})();
