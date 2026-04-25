/**
 * ═══════════════════════════════════════════════════════════════
 *  TEMPO TERMINAL · Telegram Bot · v3.1.0
 * ═══════════════════════════════════════════════════════════════
 *  · Per-user state & preferences (persistent, atomic writes)
 *  · USDC balance parser (JSON-first, regex fallback) + runway projection
 *  · Context memory for conversations (opt-in)
 *  · Rate limiting (sliding window + min-gap)
 *  · Confirmation flow for spend > $0.05; research / music always confirm
 *  · Resumable async tasks: pending_tasks survives bot restart
 *  · Per-poll spending tracked in CSV; auto-refund on empty results
 *  · Group-chat-aware command regex (/cmd@bot)
 *  · Proactive low-balance alerts
 *  · Graceful error handling & shutdown
 *
 *  Built by Sup Cartel · discord.gg/supc
 * ═══════════════════════════════════════════════════════════════
 */
const VERSION = '3.1.0';

'use strict';

const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

const { runTempo } = require('./tempo-cli');

// ═══════════════════════════════════════════════════════════════
//  1 · Environment & Configuration
// ═══════════════════════════════════════════════════════════════

function parseEnvValue(raw) {
    let v = raw.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        return v.slice(1, -1);
    }
    const hash = v.indexOf(' #');
    if (hash !== -1) v = v.slice(0, hash).trim();
    return v;
}

function loadEnv() {
    if (!fs.existsSync('.env')) return;
    const content = fs.readFileSync('.env', 'utf8');
    for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq === -1) continue;
        const key = trimmed.slice(0, eq).trim();
        const val = parseEnvValue(trimmed.slice(eq + 1));
        if (key && !process.env[key]) process.env[key] = val;
    }
}

loadEnv();

const CONFIG = {
    token:              process.env.TELEGRAM_BOT_TOKEN,
    allowedUsers:       (process.env.ALLOWED_USERS || '').split(',').map(s => s.trim()).filter(Boolean),
    maxDailySpend:      parseFloat(process.env.MAX_DAILY_SPEND       || '3.0'),
    // Operations costing strictly more than this prompt the user before
    // charging. $0.05 catches premium-model chat, multi-URL extract, and
    // anything else that isn't trivially cheap — but research and music
    // always confirm (long-running, easy to misfire).
    confirmThreshold:   parseFloat(process.env.CONFIRM_THRESHOLD     || '0.05'),
    lowBalanceWarn:     parseFloat(process.env.LOW_BALANCE_WARN      || '5.0'),
    lowBalanceCritical: parseFloat(process.env.LOW_BALANCE_CRITICAL  || '1.0'),
    contextWindow:      parseInt  (process.env.CONTEXT_WINDOW        || '6', 10),
    rateLimitSec:       parseFloat(process.env.RATE_LIMIT_SEC        || '2.0'),
    rateLimitMin:       parseInt  (process.env.RATE_LIMIT_MIN        || '20', 10),
    defaultModel:       process.env.LLM_MODEL                        || 'openai/gpt-4o-mini',
    defaultVoice:       process.env.TTS_VOICE                        || 'rachel',
    stateFile:          './bot-state.json',
    logFile:            './bot.log',
    spendingFile:       './spending.csv',
    spendingMaxLines:   10000,
    cliTimeout:         120000,
};

if (!CONFIG.token) {
    console.error('❌ Set TELEGRAM_BOT_TOKEN in .env — get one from @BotFather');
    process.exit(1);
}

// ═══════════════════════════════════════════════════════════════
//  2 · Structured Logger
// ═══════════════════════════════════════════════════════════════

const log = {
    _write(level, args) {
        const ts = new Date().toISOString();
        const parts = args.map(a => {
            if (a instanceof Error) return a.stack || a.message;
            if (typeof a === 'object') { try { return JSON.stringify(a); } catch { return String(a); } }
            return String(a);
        });
        const line = `[${ts}] [${level.padEnd(5)}] ${parts.join(' ')}`;
        console.log(line);
        try { fs.appendFileSync(CONFIG.logFile, line + '\n'); } catch { /* silent */ }
    },
    info:  (...a) => log._write('INFO',  a),
    warn:  (...a) => log._write('WARN',  a),
    error: (...a) => log._write('ERROR', a),
    debug: (...a) => { if (process.env.DEBUG) log._write('DEBUG', a); }
};

// ═══════════════════════════════════════════════════════════════
//  3 · Model Catalog
// ═══════════════════════════════════════════════════════════════

const MODEL_CATALOG = [
    // ── Balanced ──  good quality/price ratio
    { id: 'openai/gpt-4o-mini',                       name: 'GPT-4o mini',          tier: 'balanced', provider: 'OpenAI',     cost: 0.015, desc: 'Fast default · reliable' },
    { id: 'openai/gpt-4.1-mini',                      name: 'GPT-4.1 mini',         tier: 'balanced', provider: 'OpenAI',     cost: 0.012, desc: 'Latest mini · 1M context' },
    { id: 'google/gemini-2.5-flash',                  name: 'Gemini 2.5 Flash',     tier: 'balanced', provider: 'Google',     cost: 0.010, desc: 'Multimodal · audio · video' },
    { id: 'anthropic/claude-haiku-4.5',               name: 'Claude Haiku 4.5',     tier: 'balanced', provider: 'Anthropic',  cost: 0.015, desc: 'Fast Claude · vision' },
    { id: 'mistralai/mistral-small-2603',             name: 'Mistral Small 4',      tier: 'balanced', provider: 'Mistral',    cost: 0.010, desc: 'Vision · reasoning · 262K' },
    { id: 'deepseek/deepseek-chat',                   name: 'DeepSeek V3',          tier: 'balanced', provider: 'DeepSeek',   cost: 0.008, desc: 'Cheap · reasoning · 164K' },
    // ── Premium ──  best quality
    { id: 'anthropic/claude-4.6-sonnet-20260217',    name: 'Claude Sonnet 4.6',    tier: 'premium',  provider: 'Anthropic',  cost: 0.045, desc: 'Top reasoning · code · analysis' },
    { id: 'openai/gpt-4.1',                          name: 'GPT-4.1',              tier: 'premium',  provider: 'OpenAI',     cost: 0.035, desc: 'Flagship · coding · multimodal' },
    { id: 'google/gemini-2.5-pro',                   name: 'Gemini 2.5 Pro',       tier: 'premium',  provider: 'Google',     cost: 0.030, desc: 'Thinking · 1M context' },
    { id: 'deepseek/deepseek-r1',                    name: 'DeepSeek R1',          tier: 'premium',  provider: 'DeepSeek',   cost: 0.025, desc: 'Deep reasoning · 671B MoE' },
    { id: 'x-ai/grok-4.1-fast',                      name: 'Grok 4.1 Fast',        tier: 'premium',  provider: 'xAI',        cost: 0.020, desc: 'Fast reasoning · 2M context' },
    { id: 'mistralai/mistral-large',                  name: 'Mistral Large',        tier: 'premium',  provider: 'Mistral',    cost: 0.025, desc: 'Multilingual · coding · 128K' },
    { id: 'perplexity/sonar-pro',                     name: 'Perplexity Pro',       tier: 'premium',  provider: 'Perplexity', cost: 0.030, desc: 'Search-enhanced · citations' },
    // ── Economy ──  cheapest paid
    { id: 'openai/gpt-4.1-nano',                     name: 'GPT-4.1 nano',         tier: 'economy',  provider: 'OpenAI',     cost: 0.005, desc: 'Cheapest OpenAI · 1M context' },
    { id: 'meta-llama/llama-4-maverick',              name: 'Llama 4 Maverick',     tier: 'economy',  provider: 'Meta',       cost: 0.005, desc: 'Vision · 1M context · MoE' },
    { id: 'meta-llama/llama-4-scout',                 name: 'Llama 4 Scout',        tier: 'economy',  provider: 'Meta',       cost: 0.003, desc: 'Open-source · 328K context' },
    { id: 'google/gemini-2.5-flash-lite',             name: 'Gemini Flash Lite',    tier: 'economy',  provider: 'Google',     cost: 0.003, desc: 'Cheapest Google · 1M context' },
    { id: 'qwen/qwen3-235b-a22b',                    name: 'Qwen3 235B',           tier: 'economy',  provider: 'Qwen',       cost: 0.004, desc: 'Large MoE · reasoning · tools' },
    { id: 'mistralai/mistral-small-3.2-24b-instruct', name: 'Mistral 3.2 24B',     tier: 'economy',  provider: 'Mistral',    cost: 0.003, desc: 'Compact · vision · tools' },
    // ── Free ──  $0, rate-limited (~20/min)
    { id: 'meta-llama/llama-3.3-70b-instruct:free',  name: 'Llama 3.3 70B',        tier: 'free',     provider: 'Meta',       cost: 0, desc: 'Free · 66K · tools' },
    { id: 'google/gemma-4-31b-it:free',               name: 'Gemma 4 31B',          tier: 'free',     provider: 'Google',     cost: 0, desc: 'Free · vision · 262K' },
    { id: 'qwen/qwen3-coder:free',                    name: 'Qwen3 Coder',          tier: 'free',     provider: 'Qwen',       cost: 0, desc: 'Free · coding · 262K' },
    { id: 'nvidia/nemotron-3-super-120b-a12b:free',   name: 'Nemotron 120B',        tier: 'free',     provider: 'NVIDIA',     cost: 0, desc: 'Free · reasoning · 262K' },
    { id: 'moonshotai/kimi-k2.5-0127',                name: 'Kimi K2.5',            tier: 'free',     provider: 'Moonshot',   cost: 0, desc: 'Free · vision · reasoning · 256K' },
];

const MODEL_BY_ID = Object.fromEntries(MODEL_CATALOG.map(m => [m.id, m]));

function getModel(id) {
    return MODEL_BY_ID[id] || MODEL_BY_ID[CONFIG.defaultModel] || MODEL_CATALOG[0];
}

// TTS voices. The legacy IDs (rachel/adam/etc.) come from ElevenLabs and were
// kept for backward-compat in stored user state; each maps to a real Deepgram
// Aura model that gets passed as `model: <dgModel>` in the speak request.
const TTS_VOICES = [
    { id: 'rachel',  name: 'Rachel',  desc: 'Female · friendly',  dgModel: 'aura-asteria-en' },
    { id: 'adam',    name: 'Adam',    desc: 'Male · deep',        dgModel: 'aura-arcas-en'   },
    { id: 'antoni',  name: 'Antoni',  desc: 'Male · warm',        dgModel: 'aura-orion-en'   },
    { id: 'bella',   name: 'Bella',   desc: 'Female · polite',    dgModel: 'aura-luna-en'    },
    { id: 'domi',    name: 'Domi',    desc: 'Female · calm',      dgModel: 'aura-stella-en'  },
    { id: 'elli',    name: 'Elli',    desc: 'Female · mature',    dgModel: 'aura-athena-en'  },
];
const VOICE_BY_ID = Object.fromEntries(TTS_VOICES.map(v => [v.id, v]));
function getVoice(id) { return VOICE_BY_ID[id] || TTS_VOICES[0]; }

// Service pricing reference
const PRICING = {
    chat:      { base: 0.01,    note: 'Parallel search + LLM per-token' },
    image:     { fixed: 0.003,  note: 'Default Flux Schnell (varies by model)' },
    tts:       { fixed: 0.023,  note: 'Deepgram speak' },
    extract:   { per_url: 0.01, note: 'Parallel extract' },
    research:  { fixed: 0.10,   note: 'Parallel Task pro' },
    translate: { fixed: 0.025,  note: 'DeepL translate' },
    weather:   { fixed: 0.011,  note: 'OpenWeather geocode + current' },
    crypto:    { fixed: 0.06,   note: 'CoinGecko simple-price' },
    dune:      { fixed: 0.01,   note: 'LLM-only' },
    wolfram:   { fixed: 0.055,  note: 'Wolfram|Alpha short-answer' },
    code:      { fixed: 0.006,  note: 'Judge0 execute-code' },
    music:     { fixed: 0.105,  note: 'Suno generate-music' },
};

// ═══════════════════════════════════════════════════════════════
//  4 · Persistent State Manager (per-user)
// ═══════════════════════════════════════════════════════════════

// Atomic write: write tmp + rename avoids a half-written JSON blob when
// server.js and telegram-bot.js share the same state file.
function atomicWriteFileSync(target, data) {
    const tmp = target + '.tmp.' + process.pid;
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, target);
}

class StateManager {
    constructor(file) {
        this.file = file;
        this.data = this._load();
        this._saveTimer = null;
    }

    _load() {
        try {
            if (fs.existsSync(this.file)) {
                const raw = fs.readFileSync(this.file, 'utf8');
                const parsed = JSON.parse(raw);
                log.info('State loaded:', Object.keys(parsed.users || {}).length, 'users');
                return parsed;
            }
        } catch (e) {
            log.warn('State load failed, starting fresh:', e.message);
        }
        return {
            users: {},
            daily_spent: 0,
            daily_reset_date: new Date().toDateString(),
        };
    }

    _scheduleSave() {
        if (this._saveTimer) return;
        this._saveTimer = setTimeout(() => {
            this._saveTimer = null;
            this.saveNow();
        }, 2000); // debounce 2s
    }

    saveNow() {
        try {
            atomicWriteFileSync(this.file, JSON.stringify(this.data, null, 2));
            log.debug('State saved');
        } catch (e) {
            log.error('State save failed:', e.message);
        }
    }

    user(userId) {
        const id = String(userId);
        if (!this.data.users[id]) {
            this.data.users[id] = {
                model: CONFIG.defaultModel,
                voice: CONFIG.defaultVoice,
                image_model: 'flux-schnell',
                context_enabled: false,
                context: [],
                last_balance_warn: 0,
                total_requests: 0,
                joined_at: new Date().toISOString(),
            };
            this._scheduleSave();
        }
        return this.data.users[id];
    }

    setUserField(userId, field, value) {
        const u = this.user(userId);
        u[field] = value;
        this._scheduleSave();
    }

    appendContext(userId, role, content) {
        const u = this.user(userId);
        u.context.push({ role, content: String(content).slice(0, 2000), t: Date.now() });
        // Keep only last N
        while (u.context.length > CONFIG.contextWindow * 2) u.context.shift();
        this._scheduleSave();
    }

    clearContext(userId) {
        const u = this.user(userId);
        u.context = [];
        this._scheduleSave();
    }

    incrementRequests(userId) {
        const u = this.user(userId);
        u.total_requests = (u.total_requests || 0) + 1;
        this._scheduleSave();
    }

    dailyState() {
        const today = new Date().toDateString();
        if (this.data.daily_reset_date !== today) {
            this.data.daily_spent = 0;
            this.data.daily_reset_date = today;
            this._scheduleSave();
        }
        return this.data;
    }

    addDailySpend(amount) {
        this.dailyState();
        this.data.daily_spent += amount;
        this._scheduleSave();
    }

    // Atomic check-and-increment. JS is single-threaded so these three lines
    // run without interleaving; this closes the check-then-await-then-charge
    // gap where two concurrent handlers could both pass checkDailyLimit
    // before either added its charge.
    reserveDailySpend(amount) {
        this.dailyState();
        if (this.data.daily_spent + amount > CONFIG.maxDailySpend) {
            throw new TempoError('daily limit',
                `Daily limit $${CONFIG.maxDailySpend} reached (spent $${this.data.daily_spent.toFixed(2)}). Resets at midnight.`,
                'DAILY_LIMIT');
        }
        this.data.daily_spent += amount;
        this._scheduleSave();
    }

    // ── Pending tasks: long-running async work persisted across restarts ──
    // The bot runs research and music as fire-and-forget setTimeout chains.
    // Without persistence, a process restart in the middle of a 1-3 minute
    // research task means the user paid $0.10 and never gets the result.
    // We persist {id, type, ...} to disk; on boot, resumePendingTasks()
    // picks up where polling left off.
    addPendingTask(task) {
        if (!Array.isArray(this.data.pending_tasks)) this.data.pending_tasks = [];
        this.data.pending_tasks.push({ ...task, started_at: Date.now() });
        this.saveNow(); // important: in-flight task must hit disk immediately
    }
    removePendingTask(id) {
        if (!Array.isArray(this.data.pending_tasks)) return;
        const before = this.data.pending_tasks.length;
        this.data.pending_tasks = this.data.pending_tasks.filter(t => t.id !== id);
        if (this.data.pending_tasks.length !== before) this.saveNow();
    }
    getPendingTasks() {
        return Array.isArray(this.data.pending_tasks) ? this.data.pending_tasks : [];
    }
}

const state = new StateManager(CONFIG.stateFile);

// ═══════════════════════════════════════════════════════════════
//  5 · Rate Limiter (per-user sliding window + min gap)
// ═══════════════════════════════════════════════════════════════

class RateLimiter {
    constructor({ minGapSec, maxPerMin }) {
        this.minGap = minGapSec * 1000;
        this.maxPerMin = maxPerMin;
        this.buckets = new Map();
    }

    check(userId) {
        const now = Date.now();
        const bucket = this.buckets.get(userId) || { last: 0, recent: [] };

        // Min gap check
        if (now - bucket.last < this.minGap) {
            return { allowed: false, retryAfter: Math.ceil((this.minGap - (now - bucket.last)) / 1000) };
        }

        // Sliding window (60s)
        bucket.recent = bucket.recent.filter(t => now - t < 60000);
        if (bucket.recent.length >= this.maxPerMin) {
            const oldest = bucket.recent[0];
            return { allowed: false, retryAfter: Math.ceil((60000 - (now - oldest)) / 1000) };
        }

        bucket.recent.push(now);
        bucket.last = now;
        this.buckets.set(userId, bucket);
        return { allowed: true };
    }
}

const rateLimiter = new RateLimiter({
    minGapSec: CONFIG.rateLimitSec,
    maxPerMin: CONFIG.rateLimitMin
});

// ═══════════════════════════════════════════════════════════════
//  6 · Tempo CLI Wrapper with Smart Error Parsing
// ═══════════════════════════════════════════════════════════════

class TempoError extends Error {
    constructor(message, userMessage, code) {
        super(message);
        this.name = 'TempoError';
        this.userMessage = userMessage;
        this.code = code;
    }
}

function parseTempoError(stderr, stdout) {
    const text = (stderr || '') + '\n' + (stdout || '');
    const low = text.toLowerCase();

    if (low.includes('insufficient funds') || low.includes('insufficient balance')) {
        return new TempoError(text, '⚠️ Wallet balance too low. Use `/balance` to check and fund.', 'INSUFFICIENT_FUNDS');
    }
    if (low.includes('no key configured') || low.includes('tempo-moderato')) {
        return new TempoError(text, '🔧 Config error: testnet endpoint detected. Contact admin.', 'WRONG_NETWORK');
    }
    if (low.includes('econnrefused') || low.includes('network') || low.includes('dns')) {
        return new TempoError(text, '🌐 Network issue. Check your internet connection.', 'NETWORK');
    }
    if (low.includes('timeout') || low.includes('timed out')) {
        return new TempoError(text, '⏱ Request timed out. The service may be slow — try again.', 'TIMEOUT');
    }
    if (low.includes('rate limit') || low.includes('429') || low.includes('too many requests')) {
        return new TempoError(text, '🚦 Service rate-limited. Wait a moment and retry.', 'RATE_LIMITED');
    }
    if (/\b(500|502|503|504)\b/.test(low)) {
        return new TempoError(text, '⚠️ Service temporarily down. Try again shortly.', 'SERVICE_DOWN');
    }
    if (low.includes('401') || low.includes('403') || low.includes('unauthorized')) {
        return new TempoError(text, '🔐 Auth error. Run `/balance` to verify wallet state.', 'AUTH');
    }
    if (low.includes('tempo: command not found') || low.includes('tempo: not found')) {
        return new TempoError(text, '🔧 Tempo CLI not installed. See setup docs.', 'CLI_MISSING');
    }

    // Fallback
    return new TempoError(text, `❌ Request failed: ${(text || 'unknown error').slice(0, 200)}`, 'UNKNOWN');
}

async function tempoRequest(url, body) {
    log.debug('tempo call:', url);

    try {
        const { stdout, stderr } = await runTempo(
            ['request', '-X', 'POST', '--json', JSON.stringify(body), url],
            { timeout: CONFIG.cliTimeout }
        );

        if (stderr?.trim()) {
            log.warn('tempo stderr:', stderr.slice(0, 500));
        }

        try {
            return JSON.parse(stdout);
        } catch {
            return { raw: stdout };
        }
    } catch (err) {
        throw parseTempoError(err.stderr, err.stdout || err.message);
    }
}

async function tempoGet(url) {
    log.debug('tempo GET:', url);
    try {
        const { stdout, stderr } = await runTempo(
            ['request', '-X', 'GET', url],
            { timeout: CONFIG.cliTimeout }
        );
        if (stderr?.trim()) log.warn('tempo stderr:', stderr.slice(0, 500));
        try { return JSON.parse(stdout); } catch { return { raw: stdout }; }
    } catch (err) {
        throw parseTempoError(err.stderr, err.stdout || err.message);
    }
}

// ═══════════════════════════════════════════════════════════════
//  7 · Wallet Balance Parser (USDC-native, no ETH)
// ═══════════════════════════════════════════════════════════════

async function getWalletInfo() {
    try {
        const { stdout } = await runTempo(['wallet', 'whoami'], { timeout: 10000 });

        // Tempo CLI ≥1.6 emits JSON by default; older versions printed text.
        // Try JSON first; fall back to regex so this works on either format.
        let address = null, usdc = null, usdcTotal = null, usdcLocked = null;
        let spendingLimit = null, ready = null;

        try {
            const j = JSON.parse(stdout);
            address = j.wallet || null;
            ready = j.ready ?? null;
            if (j.balance) {
                const avail = parseFloat(j.balance.available);
                const total = parseFloat(j.balance.total);
                const locked = parseFloat(j.balance.locked);
                usdc = isFinite(avail) ? avail : (isFinite(total) ? total : null);
                usdcTotal = isFinite(total) ? total : null;
                usdcLocked = isFinite(locked) ? locked : null;
            }
            if (j.key?.spending_limit) {
                const sl = j.key.spending_limit;
                spendingLimit = {
                    limit: parseFloat(sl.limit),
                    remaining: parseFloat(sl.remaining),
                    spent: parseFloat(sl.spent),
                    unlimited: !!sl.unlimited,
                };
            }
        } catch { /* not JSON — fall through to text patterns */ }

        if (usdc == null) {
            const usdcPatterns = [
                /([\d,]+\.?\d*)\s*USDC/i,
                /balance[:\s]+\$?([\d,]+\.?\d*)/i,
                /\$([\d,]+\.?\d*)\s*USDC/i,
                /USDC[:\s]+([\d,]+\.?\d*)/i,
            ];
            for (const pattern of usdcPatterns) {
                const m = stdout.match(pattern);
                if (m) {
                    const v = parseFloat(m[1].replace(/,/g, ''));
                    if (!isNaN(v)) { usdc = v; break; }
                }
            }
        }

        if (!address) {
            const addrMatch = stdout.match(/0x[a-fA-F0-9]{40}/);
            address = addrMatch ? addrMatch[0] : null;
        }

        return { address, usdc, usdcTotal, usdcLocked, spendingLimit, ready, raw: stdout.trim(), available: true };
    } catch (err) {
        log.warn('wallet info unavailable:', err.message);
        return { address: null, usdc: null, usdcTotal: null, usdcLocked: null, spendingLimit: null, ready: null, raw: err.message, available: false };
    }
}

// ═══════════════════════════════════════════════════════════════
//  8 · Spending Tracker with Log Rotation
// ═══════════════════════════════════════════════════════════════

const spending = {
    record(type, cost, query, userId) {
        const sanitizedQuery = String(query)
            .replace(/[\r\n]+/g, ' ')   // newlines break the CSV row structure
            .replace(/"/g, "'")
            .slice(0, 200);
        const row = [
            new Date().toISOString(),
            String(userId),
            type,
            cost.toFixed(4),
            `"${sanitizedQuery}"`,
        ].join(',') + '\n';

        try {
            fs.appendFileSync(CONFIG.spendingFile, row);
            this._maybeRotate();
        } catch (e) {
            log.error('spending write failed:', e.message);
        }
    },

    _maybeRotate() {
        try {
            const stats = fs.statSync(CONFIG.spendingFile);
            if (stats.size < 1024 * 1024) return; // <1MB — skip
            const content = fs.readFileSync(CONFIG.spendingFile, 'utf8').trim().split('\n');
            if (content.length <= CONFIG.spendingMaxLines) return;

            // Keep last 80% of max
            const keep = content.slice(-Math.floor(CONFIG.spendingMaxLines * 0.8));
            const archiveName = `spending.${new Date().toISOString().slice(0, 10)}.csv`;
            fs.writeFileSync(archiveName, content.slice(0, -keep.length).join('\n') + '\n');
            fs.writeFileSync(CONFIG.spendingFile, keep.join('\n') + '\n');
            log.info('Spending rotated, archive:', archiveName);
        } catch (e) {
            log.warn('rotation failed:', e.message);
        }
    },

    summary() {
        try {
            if (!fs.existsSync(CONFIG.spendingFile)) return { total: 0, byType: {}, count: 0, last7d: 0, last7d_days: 0 };
            const lines = fs.readFileSync(CONFIG.spendingFile, 'utf8').trim().split('\n').filter(Boolean);
            const byType = {};
            let total = 0, last7d = 0;
            let earliest7d = Infinity;
            const now = Date.now();
            const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;

            for (const line of lines) {
                const parts = line.split(',');
                const ts = Date.parse(parts[0]);
                const type = parts[2];
                const cost = parseFloat(parts[3]);
                if (!isNaN(cost)) {
                    total += cost;
                    byType[type] = (byType[type] || 0) + cost;
                    if (ts > sevenDaysAgo) {
                        last7d += cost;
                        if (ts < earliest7d) earliest7d = ts;
                    }
                }
            }

            const last7d_days = earliest7d === Infinity ? 0 : (now - earliest7d) / (24 * 60 * 60 * 1000);
            return { total, byType, count: lines.length, last7d, last7d_days };
        } catch (e) {
            log.error('summary failed:', e.message);
            return { total: 0, byType: {}, count: 0, last7d: 0, last7d_days: 0 };
        }
    },
};

// ═══════════════════════════════════════════════════════════════
//  9 · Intent Classifier (RU + EN)
// ═══════════════════════════════════════════════════════════════

function classifyIntent(message) {
    const msg = message.trim();

    // Each verb-prefix pattern uses (\s+|$) so a bare command (no argument)
    // still classifies into the right intent — the per-handler validation
    // then returns a help message instead of silently falling through to
    // chat and charging for an LLM call.

    // Image generation
    if (/^(draw|generate image|create image|image of|picture of|make image)(\s+|$)/i.test(msg)) {
        const prompt = msg.replace(/^(draw|generate image|create image|image of|picture of|make image)\s*/i, '');
        return { type: 'image', prompt };
    }

    // TTS
    if (/^(read aloud|tts|speak|say|voice)([:\s]|$)/i.test(msg)) {
        const text = msg.replace(/^(read aloud|tts|speak|say|voice)[:\s]*/i, '');
        return { type: 'tts', text };
    }

    // URL extract
    if (/(extract from|scrape|parse from|get data from)/i.test(msg) && /https?:\/\//.test(msg)) {
        const urls = msg.match(/https?:\/\/\S+/g) || [];
        return { type: 'extract', urls, objective: msg };
    }

    // Deep research
    if (/(deep research|detailed analysis|in-depth report|comprehensive review)/i.test(msg)) {
        return { type: 'research', query: msg };
    }

    // Translate
    if (/^(translate|translation)(\s|$)/i.test(msg)) {
        let rest = msg.replace(/^(translate|translation)\s*/i, '');
        let target = 'English', text = rest;
        let matched = false;

        const prefixMatch = rest.match(/^(to|into)\s+(\w+)\s*[:\-]?\s*/i);
        if (prefixMatch && (DEEPL_CODES[prefixMatch[2].toLowerCase()] || prefixMatch[2].length === 2)) {
            target = prefixMatch[2];
            text = rest.slice(prefixMatch[0].length);
            matched = true;
        }

        if (!matched) {
            const suffixMatch = rest.match(/\s+(to|into)\s+(\w+)\s*$/i);
            if (suffixMatch) {
                target = suffixMatch[2];
                text = rest.slice(0, suffixMatch.index).trim();
                matched = true;
            }
        }

        if (!matched) {
            const langFirst = rest.match(/^(\w+)\s*[:\-]\s*(.+)/i);
            if (langFirst && DEEPL_CODES[langFirst[1].toLowerCase()]) {
                target = langFirst[1];
                text = langFirst[2];
                matched = true;
            }
        }

        return { type: 'translate', text: text || rest, target };
    }

    // Weather
    if (/^weather(\s+in\s+|\s+|$)/i.test(msg)) {
        return { type: 'weather', location: msg.replace(/^weather(\s+in)?\s*/i, '') };
    }

    // Crypto price
    if (/^(price of|price)(\s+|$)/i.test(msg)) {
        return { type: 'crypto', ticker: msg.replace(/^(price of|price)\s*/i, '').trim().toLowerCase() };
    }

    // Dune / blockchain query
    if (/^(dune|onchain|blockchain)(\s+(query|sql|data|analysis)|$)/i.test(msg)) {
        return { type: 'dune', query: msg.replace(/^(dune|onchain|blockchain)\s*(query|sql|data|analysis)?\s*/i, '') };
    }

    // Code execution
    if (/^(run|execute)(\s+|$)/i.test(msg)) {
        const code = msg.replace(/^(run|execute)\s*(code)?\s*/i, '');
        const langMatch = code.match(/^(python|javascript|js|ruby|go|rust|c|cpp|java|php|swift|kotlin|bash|sh|typescript|ts)\s+/i);
        const lang = langMatch ? langMatch[1].toLowerCase() : 'python';
        const src = langMatch ? code.slice(langMatch[0].length) : code;
        return { type: 'code', source: src, lang };
    }

    // Wolfram|Alpha
    if (/^(wolfram|calculate|calc|compute)(\s+|$)/i.test(msg)) {
        return { type: 'wolfram', query: msg.replace(/^(wolfram|calculate|calc|compute)\s*/i, '') };
    }

    // Music generation
    if (/^(make music|generate music|create song|music)(\s+|$)/i.test(msg)) {
        return { type: 'music', prompt: msg.replace(/^(make music|generate music|create song|music)\s*/i, '') };
    }

    // Default → chat with search
    return { type: 'chat', query: msg };
}

// ═══════════════════════════════════════════════════════════════
//  10 · Telegram Markdown Utilities
// ═══════════════════════════════════════════════════════════════

/** Escape user content so it can be inserted into Markdown safely */
function escapeMd(s) {
    if (!s) return '';
    return String(s).replace(/([_*`\[\]])/g, '\\$1');
}

/** Split long messages at natural boundaries (paragraph > sentence > word) */
function chunkMessage(text, maxLen = 3800) {
    if (text.length <= maxLen) return [text];
    const chunks = [];
    let rest = text;

    while (rest.length > maxLen) {
        let cutAt = maxLen;
        const window = rest.slice(0, maxLen);

        // Prefer paragraph break
        const paraBreak = window.lastIndexOf('\n\n');
        if (paraBreak > maxLen * 0.5) cutAt = paraBreak + 2;
        else {
            // Sentence break
            const sentBreak = Math.max(window.lastIndexOf('. '), window.lastIndexOf('! '), window.lastIndexOf('? '));
            if (sentBreak > maxLen * 0.5) cutAt = sentBreak + 2;
            else {
                // Word break
                const wordBreak = window.lastIndexOf(' ');
                if (wordBreak > maxLen * 0.5) cutAt = wordBreak + 1;
            }
        }

        chunks.push(rest.slice(0, cutAt));
        rest = rest.slice(cutAt);
    }
    if (rest.length) chunks.push(rest);
    return chunks;
}

function progressBar(value, max, width = 10) {
    const pct = Math.min(1, max > 0 ? value / max : 0);
    const filled = Math.round(pct * width);
    return '▰'.repeat(filled) + '▱'.repeat(width - filled);
}

// ═══════════════════════════════════════════════════════════════
//  11 · Access Control
// ═══════════════════════════════════════════════════════════════

function isAllowed(userId) {
    return CONFIG.allowedUsers.length === 0 || CONFIG.allowedUsers.includes(String(userId));
}

// Slash-command guard. Returns true if the user is allowed (and the command
// should proceed). Otherwise sends a clear "Access denied" reply and returns
// false. This unifies UX with the bot.on('message') path, which already
// surfaces the denial — silent drops on /help/etc. used to make users think
// the bot was offline.
async function denyIfNotAllowed(msg) {
    if (isAllowed(msg.from.id)) return false;
    await bot.sendMessage(msg.chat.id,
        `🚫 Access denied.\n\nYour ID: \`${msg.from.id}\`\n\nAsk the wallet owner to whitelist it.`,
        { parse_mode: 'Markdown' }
    ).catch(() => {});
    return true;
}

async function guardMessage(msg) {
    if (!isAllowed(msg.from.id)) {
        await bot.sendMessage(msg.chat.id,
            `🚫 Access denied.\n\nYour ID: \`${msg.from.id}\`\n\nAsk the wallet owner to whitelist it.`,
            { parse_mode: 'Markdown' });
        return false;
    }

    const rate = rateLimiter.check(msg.from.id);
    if (!rate.allowed) {
        await bot.sendMessage(msg.chat.id, `⏱ Slow down — try again in ${rate.retryAfter}s`);
        return false;
    }

    // Daily limit check
    const daily = state.dailyState();
    if (daily.daily_spent >= CONFIG.maxDailySpend) {
        await bot.sendMessage(msg.chat.id,
            `🛑 Daily limit reached: $${daily.daily_spent.toFixed(2)} / $${CONFIG.maxDailySpend}\n\nResets at midnight local time.`);
        return false;
    }

    return true;
}

function checkDailyLimit(cost) {
    const daily = state.dailyState();
    if (daily.daily_spent + cost > CONFIG.maxDailySpend) {
        throw new TempoError('daily limit',
            `Daily limit $${CONFIG.maxDailySpend} reached (spent $${daily.daily_spent.toFixed(2)}). Resets at midnight.`,
            'DAILY_LIMIT');
    }
}

// ═══════════════════════════════════════════════════════════════
//  12 · Confirmation Flow (for expensive operations)
// ═══════════════════════════════════════════════════════════════

const pendingConfirmations = new Map(); // confirmId → { userId, resolve, reject, timer }

function makeConfirmId() {
    return Math.random().toString(36).slice(2, 10);
}

async function requestConfirmation(chatId, userId, cost, action, description) {
    const dailyLeft = CONFIG.maxDailySpend - state.dailyState().daily_spent;
    const pct = Math.round((cost / CONFIG.maxDailySpend) * 100);

    const confirmId = makeConfirmId();

    const message = await bot.sendMessage(chatId,
        `💳 *Confirm:* ${action}\n\n` +
        `${description ? `_${description}_\n\n` : ''}` +
        `*Cost:* $${cost.toFixed(2)} _(${pct}% of daily limit)_\n` +
        `*Daily remaining:* $${dailyLeft.toFixed(2)}\n\n` +
        `This purchase is non-refundable.`,
        {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [[
                    { text: `✓ Spend $${cost.toFixed(2)}`, callback_data: `confirm:${confirmId}:yes` },
                    { text: '✗ Cancel',                    callback_data: `confirm:${confirmId}:no` }
                ]]
            }
        }
    );

    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            pendingConfirmations.delete(confirmId);
            bot.editMessageText('⏱ Confirmation timed out (60s). Request cancelled.',
                { chat_id: chatId, message_id: message.message_id }).catch(() => {});
            resolve(false);
        }, 60000);

        pendingConfirmations.set(confirmId, {
            userId: String(userId),
            chatId,
            messageId: message.message_id,
            cost,
            action,
            resolve,
            timer,
        });
    });
}

// ═══════════════════════════════════════════════════════════════
//  13 · Handlers
// ═══════════════════════════════════════════════════════════════

async function handleChat(chatId, userId, query, msgId) {
    const u = state.user(userId);
    const model = getModel(u.model);
    // chat = parallel search ($0.01) + LLM (model.cost). Both are signed
    // MPP requests; daily-cap accounting must include both or it lags reality.
    const totalCost = model.cost + PRICING.chat.base;
    state.reserveDailySpend(totalCost);

    // Typing indicator loop
    const typingInterval = setInterval(() => bot.sendChatAction(chatId, 'typing').catch(() => {}), 4000);
    await bot.sendChatAction(chatId, 'typing');

    let charged = true;
    try {
        const search = await tempoRequest('https://parallelmpp.dev/api/search', { query, mode: 'one-shot' });

        const messages = [
            { role: 'system', content: 'You are a concise, precise assistant. Answer in the user\'s language. Structure: (1) direct answer in 1–2 sentences, (2) key facts with inline source links [URL]. Use numbers where relevant. Stay within provided data.' }
        ];

        if (u.context_enabled && u.context.length > 0) {
            for (const c of u.context.slice(-CONFIG.contextWindow)) {
                messages.push({ role: c.role, content: c.content });
            }
        }
        messages.push({ role: 'user', content: `Question: ${query}\n\nSearch data: ${JSON.stringify(search).slice(0, 12000)}` });

        const llm = await tempoRequest('https://openrouter.mpp.tempo.xyz/v1/chat/completions', { model: model.id, messages, temperature: 0.3 });
        const answer = llm.choices?.[0]?.message?.content;
        if (!answer) throw new Error('Empty LLM response');

        spending.record('chat', totalCost, query, userId);
        state.incrementRequests(userId);

        if (u.context_enabled) {
            state.appendContext(userId, 'user', query);
            state.appendContext(userId, 'assistant', answer);
        }

        const chunks = chunkMessage(answer, 3800);
        const ctxNote = u.context_enabled ? ' · ctx' : '';
        const footer = `\n\n_via ${escapeMd(model.name)} · $${totalCost.toFixed(3)}${ctxNote}_`;

        for (let i = 0; i < chunks.length; i++) {
            const text = i === chunks.length - 1 ? chunks[i] + footer : chunks[i];
            const replyTo = i === 0 ? msgId : undefined;
            try {
                await bot.sendMessage(chatId, text,
                    { parse_mode: 'Markdown', disable_web_page_preview: true, reply_to_message_id: replyTo });
            } catch {
                // Fallback without parse_mode — but keep the footer (cost/model
                // attribution belongs on the response, formatted or not).
                await bot.sendMessage(chatId, text, { reply_to_message_id: replyTo });
            }
        }

        checkLowBalance(chatId, userId).catch(() => {});
    } catch (err) {
        if (charged) { charged = false; state.addDailySpend(-totalCost); }
        throw err;
    } finally {
        clearInterval(typingInterval);
    }
}

const IMAGE_MODELS = {
    'flux-schnell': { url: 'https://fal.mpp.tempo.xyz/fal-ai/flux/schnell',  name: 'Flux Schnell',  cost: 0.003 },
    'nano-banana':  { url: 'https://fal.mpp.tempo.xyz/fal-ai/nano-banana-2', name: 'NanoBanana 2',  cost: 0.04  },
    'flux-dev':     { url: 'https://fal.mpp.tempo.xyz/fal-ai/flux/dev',      name: 'Flux Dev',      cost: 0.025 },
    // NOTE: subdomain shape differs from the rest of the paywithlocus endpoints
    // ('stability-ai.mpp…' vs 'stability.mpp…'). Verify before production use.
    'stability':    { url: 'https://stability-ai.mpp.paywithlocus.com/stability-ai/generate-core', name: 'Stability AI', cost: 0.034 },
};

async function handleImage(chatId, userId, prompt, msgId) {
    const u = state.user(userId);
    const imgModelId = u.image_model || 'flux-schnell';
    const imgModel = IMAGE_MODELS[imgModelId] || IMAGE_MODELS['flux-schnell'];
    const cost = imgModel.cost;
    state.reserveDailySpend(cost);
    let charged = true;
    const refund = () => { if (charged) { charged = false; state.addDailySpend(-cost); } };

    try {
        await bot.sendChatAction(chatId, 'upload_photo');

        const isStability = imgModelId === 'stability';
        const body = isStability ? { prompt, aspect_ratio: '1:1', output_format: 'png' } : { prompt, image_size: 'square_hd' };
        const result = await tempoRequest(imgModel.url, body);
        const d = result.data || result;
        const imageUrl = d.images?.[0]?.url || d.image_url || d.url;
        const imageB64 = d.image;
        if (!imageUrl && !imageB64) throw new Error('No image returned');

        spending.record('image', cost, prompt, userId);
        state.incrementRequests(userId);

        const caption = `_${escapeMd(prompt.slice(0, 900))}_\n\n_$${cost.toFixed(3)} · ${escapeMd(imgModel.name)}_`;
        const opts = { caption, parse_mode: 'Markdown', reply_to_message_id: msgId };
        if (imageUrl) {
            await bot.sendPhoto(chatId, imageUrl, opts);
        } else {
            await bot.sendPhoto(chatId, Buffer.from(imageB64, 'base64'), opts);
        }
        checkLowBalance(chatId, userId).catch(() => {});
    } catch (err) {
        refund();
        throw err;
    }
}

async function handleTTS(chatId, userId, text, msgId) {
    if (text.length > 2000) {
        await bot.sendMessage(chatId, 'Text too long for TTS (max 2000 chars).', { reply_to_message_id: msgId });
        return;
    }
    const u = state.user(userId);
    const voice = getVoice(u.voice);
    const cost = PRICING.tts.fixed;
    state.reserveDailySpend(cost);
    let charged = true;
    const refund = () => { if (charged) { charged = false; state.addDailySpend(-cost); } };

    try {
        await bot.sendChatAction(chatId, 'upload_voice');

        // Deepgram /speak takes `model` (aura-*-en); the legacy `voice` field
        // is ignored. We pass both for forward-compat.
        const result = await tempoRequest('https://deepgram.mpp.paywithlocus.com/deepgram/speak',
            { text, model: voice.dgModel, voice: voice.id });
        const d = result.data || result;
        const audioUrl = d.audio_url || d.url;
        const audioB64 = d.data || d.audio;
        if (!audioUrl && !audioB64) throw new Error('No audio returned');

        spending.record('tts', cost, text, userId);
        state.incrementRequests(userId);

        const caption = `_${escapeMd(voice.name)} · $${cost.toFixed(3)} · Deepgram_`;
        if (audioUrl) {
            await bot.sendVoice(chatId, audioUrl, { caption, parse_mode: 'Markdown', reply_to_message_id: msgId });
        } else {
            await bot.sendVoice(chatId, Buffer.from(audioB64, 'base64'), { caption, parse_mode: 'Markdown', reply_to_message_id: msgId });
        }
        checkLowBalance(chatId, userId).catch(() => {});
    } catch (err) {
        refund();
        throw err;
    }
}

async function handleExtract(chatId, userId, urls, objective, msgId) {
    if (!urls || urls.length === 0) {
        throw new TempoError('no urls', 'No URLs found in the message. Include at least one http(s) link.', 'NO_URLS');
    }
    const cost = PRICING.extract.per_url * urls.length;
    checkDailyLimit(cost); // preflight check for user-facing error before confirmation

    if (cost > CONFIG.confirmThreshold) {
        const confirmed = await requestConfirmation(chatId, userId, cost, `Extract ${urls.length} URL(s)`, `Parse content from ${urls.length} pages`);
        if (!confirmed) return;
    }

    state.reserveDailySpend(cost);
    let charged = true;
    const refund = () => { if (charged) { charged = false; state.addDailySpend(-cost); } };

    try {
        await bot.sendChatAction(chatId, 'typing');
        const result = await tempoRequest('https://parallelmpp.dev/api/extract', { urls, objective });

        spending.record('extract', cost, urls.join(','), userId);
        state.incrementRequests(userId);

        const output = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
        const chunks = chunkMessage(output, 3800);
        for (const chunk of chunks) {
            await bot.sendMessage(chatId, '```\n' + chunk + '\n```', { parse_mode: 'Markdown', reply_to_message_id: msgId })
                .catch(() => bot.sendMessage(chatId, chunk, { reply_to_message_id: msgId }));
        }
        await bot.sendMessage(chatId, `_Extract · $${cost.toFixed(3)}_`, { parse_mode: 'Markdown' });
        checkLowBalance(chatId, userId).catch(() => {});
    } catch (err) {
        refund();
        throw err;
    }
}

async function handleResearch(chatId, userId, query, msgId) {
    const cost = PRICING.research.fixed;
    checkDailyLimit(cost);

    // Research is async and irreversible — always confirm regardless of threshold.
    const confirmed = await requestConfirmation(chatId, userId, cost,
        'Deep Research', `Parallel Task pro · 1–3 min · $${cost.toFixed(2)}`);
    if (!confirmed) return;

    state.reserveDailySpend(cost);
    let charged = true;
    const refund = () => { if (charged) { charged = false; state.addDailySpend(-cost); } };

    try {
        await bot.sendChatAction(chatId, 'typing');
        const task = await tempoRequest('https://parallelmpp.dev/api/task', { input: query, processor: 'pro' });
        const runId = task.run_id;
        if (!runId) throw new Error('No run_id in task response');

        spending.record('research', cost, query, userId);
        state.incrementRequests(userId);

        const statusMsg = await bot.sendMessage(chatId,
            `*Research started*\n\nTask: \`${runId}\`\nETA: 1–3 min · $${cost.toFixed(2)}\n\n_Polling..._`,
            { parse_mode: 'Markdown', reply_to_message_id: msgId }
        );

        // Persist for resume-on-restart (Group J).
        state.addPendingTask({
            id: runId, type: 'research',
            chatId, statusMsgId: statusMsg.message_id,
            query, cost, userId,
        });

        pollResearch(chatId, statusMsg.message_id, runId, query, cost, userId);
    } catch (err) {
        refund();
        throw err;
    }
}

function formatResearchOutput(raw) {
    if (typeof raw === 'string') {
        // If it's a JSON string, try to parse and format
        try { const parsed = JSON.parse(raw); return formatResearchOutput(parsed); } catch { return raw; }
    }
    if (Array.isArray(raw)) {
        return raw.map((item, i) => typeof item === 'string' ? `• ${item}` : formatResearchOutput(item)).join('\n');
    }
    if (typeof raw === 'object' && raw !== null) {
        return Object.entries(raw).map(([k, v]) => {
            const title = k.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
            if (typeof v === 'string') return `*${title}*\n${v}`;
            if (Array.isArray(v)) {
                const items = v.map(item => {
                    if (typeof item === 'string') return `• ${item}`;
                    if (typeof item === 'object' && item !== null) {
                        // Handle citation objects, key-value items etc.
                        return Object.entries(item).map(([ik, iv]) => `  ${ik}: ${typeof iv === 'string' ? iv : JSON.stringify(iv)}`).join('\n');
                    }
                    return `• ${String(item)}`;
                }).join('\n');
                return `*${title}*\n${items}`;
            }
            if (typeof v === 'object' && v !== null) return `*${title}*\n${formatResearchOutput(v)}`;
            return `*${title}*\n${String(v)}`;
        }).join('\n\n');
    }
    return String(raw);
}

// Error codes that mean further polling is pointless AND potentially expensive.
// Status polls go through the signed tempo CLI; if the wallet is empty or
// unauthorized we must stop rather than keep signing failing requests.
const POLL_STOP_CODES = new Set(['INSUFFICIENT_FUNDS', 'AUTH', 'DAILY_LIMIT', 'WRONG_NETWORK', 'CLI_MISSING']);

// Per-poll wallet cost (USDC.e), verified via `tempo wallet services suno|parallel`.
// We charge each poll into the local daily ledger so spending.csv reflects
// reality, but we DO NOT throw on cap overflow — the parent task is already
// paid and we want to deliver the result to the user.
const POLL_COST = { research: 0.005, music: 0.005 };
function recordPoll(type, userId, taskId) {
    state.addDailySpend(POLL_COST[type]);
    spending.record('poll_' + type, POLL_COST[type], taskId, userId);
}

// If the status message was deleted by the user, Telegram returns
// 'message to edit not found' on editMessageText. Stop polling in that case
// instead of burning attempts (and signed wallet requests) against a DOM
// that nobody sees.
function isMessageMissingError(err) {
    const s = String(err && err.message || err || '').toLowerCase();
    return s.includes('message to edit not found')
        || s.includes('message_id_invalid')
        || s.includes('message to delete not found');
}

function pollResearch(chatId, statusMsgId, runId, originalQuery, cost, userId, attempt = 0) {
    if (attempt > 80) {
        state.removePendingTask(runId);
        bot.editMessageText(`Research timed out.\n\nCheck: https://parallelmpp.dev/api/task/${runId}`,
            { chat_id: chatId, message_id: statusMsgId }).catch(() => {});
        return;
    }

    setTimeout(async () => {
        try {
            // Each poll is a signed MPP request that costs ~$0.005 from the
            // wallet — record it in the spending ledger BEFORE the call, so
            // even on failure the cost is accounted for (Tempo charges on
            // request signing, not on our side's success).
            recordPoll('research', userId, runId);

            const data = await tempoGet(`https://parallelmpp.dev/api/task/${runId}`);

            if (data.status === 'completed') {
                const raw = data.result?.output?.content || data.result?.output || data.output || data.result || data;
                const output = formatResearchOutput(raw);

                if (!output || !output.trim()) {
                    // Refund the parent task — user paid $0.10 and got nothing.
                    state.addDailySpend(-cost);
                    spending.record('research_refund', -cost, runId, userId);
                    state.removePendingTask(runId);
                    await bot.editMessageText(
                        `Research completed but returned empty output. *Refunded $${cost.toFixed(2)}.*`,
                        { chat_id: chatId, message_id: statusMsgId, parse_mode: 'Markdown' }
                    ).catch(() => {});
                    return;
                }

                state.removePendingTask(runId);
                await bot.editMessageText(`*Research complete* · $${cost.toFixed(2)}`,
                    { chat_id: chatId, message_id: statusMsgId, parse_mode: 'Markdown' }).catch(() => {});

                const chunks = chunkMessage(output.slice(0, 50000), 3800);
                for (const chunk of chunks) {
                    try { await bot.sendMessage(chatId, chunk, { parse_mode: 'Markdown', disable_web_page_preview: true }); }
                    catch { await bot.sendMessage(chatId, chunk); }
                }
            } else if (data.status === 'failed') {
                // Upstream failed — refund the parent task.
                state.addDailySpend(-cost);
                spending.record('research_refund', -cost, runId, userId);
                state.removePendingTask(runId);
                await bot.editMessageText(
                    `Research failed: ${data.error || 'unknown'}. *Refunded $${cost.toFixed(2)}.*`,
                    { chat_id: chatId, message_id: statusMsgId, parse_mode: 'Markdown' }
                ).catch(() => {});
            } else {
                const elapsed = ((attempt + 1) * 15);
                try {
                    await bot.editMessageText(`*Research in progress*\n\nTask: \`${runId}\`\nElapsed: ${elapsed}s\n\n_Polling..._`,
                        { chat_id: chatId, message_id: statusMsgId, parse_mode: 'Markdown' });
                } catch (editErr) {
                    if (isMessageMissingError(editErr)) {
                        log.info(`pollResearch: status message gone, stopping ${runId}`);
                        state.removePendingTask(runId);
                        return;
                    }
                }
                pollResearch(chatId, statusMsgId, runId, originalQuery, cost, userId, attempt + 1);
            }
        } catch (err) {
            if (err instanceof TempoError && POLL_STOP_CODES.has(err.code)) {
                log.warn(`pollResearch stopped on ${err.code}: ${runId}`);
                state.removePendingTask(runId);
                bot.editMessageText(`Research halted: ${err.userMessage}\n\nTask: \`${runId}\``,
                    { chat_id: chatId, message_id: statusMsgId, parse_mode: 'Markdown' }).catch(() => {});
                return;
            }
            pollResearch(chatId, statusMsgId, runId, originalQuery, cost, userId, attempt + 1);
        }
    }, 15000);
}

const DEEPL_CODES = { english:'EN', german:'DE', french:'FR', spanish:'ES', portuguese:'PT', italian:'IT', dutch:'NL', polish:'PL', russian:'RU', japanese:'JA', chinese:'ZH', korean:'KO', turkish:'TR', arabic:'AR', czech:'CS', danish:'DA', finnish:'FI', greek:'EL', hungarian:'HU', indonesian:'ID', norwegian:'NB', romanian:'RO', swedish:'SV', ukrainian:'UK' };

async function handleTranslate(chatId, userId, text, target, msgId) {
    const cost = PRICING.translate.fixed;
    state.reserveDailySpend(cost);
    let charged = true;
    const refund = () => { if (charged) { charged = false; state.addDailySpend(-cost); } };

    try {
        await bot.sendChatAction(chatId, 'typing');

        const result = await tempoRequest('https://deepl.mpp.paywithlocus.com/deepl/translate', { text: [text], target_lang: DEEPL_CODES[target.toLowerCase()] || target.toUpperCase().slice(0, 2) });
        const d = result.data || result;
        const translated = d.translations?.[0]?.text || JSON.stringify(d);

        spending.record('translate', cost, text, userId);
        state.incrementRequests(userId);
        await bot.sendMessage(chatId, `*${escapeMd(target)}:*\n${escapeMd(translated)}\n\n_$${cost.toFixed(3)} · DeepL_`, { parse_mode: 'Markdown', reply_to_message_id: msgId });
    } catch (err) {
        refund();
        throw err;
    }
}

async function handleWeather(chatId, userId, location, msgId) {
    const cost = PRICING.weather.fixed;
    state.reserveDailySpend(cost);
    let charged = true;
    const refund = () => { if (charged) { charged = false; state.addDailySpend(-cost); } };

    try {
        await bot.sendChatAction(chatId, 'typing');

        const geo = await tempoRequest('https://openweather.mpp.paywithlocus.com/openweather/geocode', { q: location });
        const gd = geo.data || geo;
        const loc = Array.isArray(gd) ? gd[0] : gd;
        if (!loc?.lat) throw new TempoError('geo', `Location "${location}" not found.`, 'NOT_FOUND');

        const result = await tempoRequest('https://openweather.mpp.paywithlocus.com/openweather/current-weather', { lat: loc.lat, lon: loc.lon, units: 'metric' });
        const w = result.data || result;
        const txt = w.main ? `${w.name || location}: ${w.main.temp}°C, ${w.weather?.[0]?.description || ''}, humidity ${w.main.humidity}%, wind ${w.wind?.speed || 0} m/s` : JSON.stringify(w);

        spending.record('weather', cost, location, userId);
        state.incrementRequests(userId);
        await bot.sendMessage(chatId, `*Weather*\n${escapeMd(txt)}\n\n_$${cost.toFixed(3)} · OpenWeather_`, { parse_mode: 'Markdown', reply_to_message_id: msgId });
    } catch (err) {
        refund();
        throw err;
    }
}

const CRYPTO_ALIASES = { btc:'bitcoin', eth:'ethereum', sol:'solana', bnb:'binancecoin', ada:'cardano', xrp:'ripple', dot:'polkadot', doge:'dogecoin', avax:'avalanche-2', matic:'matic-network', link:'chainlink', uni:'uniswap', atom:'cosmos', near:'near', apt:'aptos', arb:'arbitrum', op:'optimism', sui:'sui', ton:'the-open-network', trx:'tron', shib:'shiba-inu', ltc:'litecoin', usdc:'usd-coin', usdt:'tether' };

async function handleCrypto(chatId, userId, ticker, msgId) {
    const cost = PRICING.crypto.fixed;
    state.reserveDailySpend(cost);
    let charged = true;
    const refund = () => { if (charged) { charged = false; state.addDailySpend(-cost); } };

    try {
        await bot.sendChatAction(chatId, 'typing');

        const coinId = CRYPTO_ALIASES[ticker] || ticker;
        const result = await tempoRequest('https://coingecko.mpp.paywithlocus.com/coingecko/simple-price', { ids: coinId, vs_currencies: 'usd', include_24hr_change: 'true', include_market_cap: 'true' });
        const d = result.data || result;
        const key = Object.keys(d)[0];
        const data = d[key];
        if (!data?.usd) {
            refund(); // don't bill the user for an unrecognized ticker
            await bot.sendMessage(chatId, `Coin "${ticker}" not found. Try full name (e.g. "bitcoin").`, { reply_to_message_id: msgId });
            return;
        }

        spending.record('crypto', cost, ticker, userId);
        state.incrementRequests(userId);

        const change = data.usd_24h_change;
        const changeStr = change != null ? `${change >= 0 ? '+' : ''}${change.toFixed(2)}%` : '—';
        const mcap = data.usd_market_cap ? `$${(data.usd_market_cap / 1e9).toFixed(2)}B` : '—';
        const txt = `${ticker.toUpperCase()} · $${data.usd.toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})}\n24h: ${changeStr}  ·  mcap: ${mcap}`;
        await bot.sendMessage(chatId, `*Crypto*\n${escapeMd(txt)}\n\n_$${cost.toFixed(3)} · CoinGecko_`, { parse_mode: 'Markdown', reply_to_message_id: msgId });
    } catch (err) {
        refund();
        throw err;
    }
}

async function handleDune(chatId, userId, query, msgId) {
    const model = getModel(state.user(userId).model);
    const cost = model.cost + PRICING.dune.fixed;
    state.reserveDailySpend(cost);
    let charged = true;
    const refund = () => { if (charged) { charged = false; state.addDailySpend(-cost); } };

    try {
        await bot.sendChatAction(chatId, 'typing');

        const llm = await tempoRequest('https://openrouter.mpp.tempo.xyz/v1/chat/completions', {
            model: model.id,
            messages: [
                { role: 'system', content: 'You are a blockchain data analyst. Answer onchain/DeFi questions with specific numbers and data.' },
                { role: 'user', content: query }
            ],
            temperature: 0.2
        });

        spending.record('dune', cost, query, userId);
        state.incrementRequests(userId);
        const output = llm.choices?.[0]?.message?.content || 'No data';
        const chunks = chunkMessage(output, 3800);
        for (const chunk of chunks) {
            try { await bot.sendMessage(chatId, chunk, { parse_mode: 'Markdown', disable_web_page_preview: true, reply_to_message_id: msgId }); }
            catch { await bot.sendMessage(chatId, chunk, { reply_to_message_id: msgId }); }
        }
        await bot.sendMessage(chatId, `_$${cost.toFixed(3)} · ${escapeMd(model.name)}_`, { parse_mode: 'Markdown' });
    } catch (err) {
        refund();
        throw err;
    }
}

// ═══════════════════════════════════════════════════════════════
const LANG_IDS = { python:71, javascript:63, js:63, ruby:72, go:60, rust:73, c:50, cpp:54, java:62, php:68, swift:83, kotlin:78, bash:46, sh:46, typescript:74, ts:74 };

async function handleCode(chatId, userId, source, lang, msgId) {
    const cost = PRICING.code.fixed;
    state.reserveDailySpend(cost);
    let charged = true;
    const refund = () => { if (charged) { charged = false; state.addDailySpend(-cost); } };

    try {
        await bot.sendChatAction(chatId, 'typing');
        const langId = LANG_IDS[lang] || 71;
        const result = await tempoRequest('https://judge0.mpp.paywithlocus.com/judge0/execute-code', { source_code: source, language_id: langId });
        const d = result.data || result;
        spending.record('code', cost, source, userId);
        state.incrementRequests(userId);
        const out = d.stdout || d.compile_output || d.stderr || 'No output';
        const status = d.status?.description || '';
        await bot.sendMessage(chatId, `*${escapeMd(lang)}* · ${escapeMd(status)}\n\`\`\`\n${out.trim().slice(0, 3500)}\n\`\`\`\n\n_$${cost.toFixed(3)} · Judge0_`, { parse_mode: 'Markdown', reply_to_message_id: msgId });
    } catch (err) {
        refund();
        throw err;
    }
}

async function handleWolfram(chatId, userId, query, msgId) {
    const cost = PRICING.wolfram.fixed;
    state.reserveDailySpend(cost);
    let charged = true;
    const refund = () => { if (charged) { charged = false; state.addDailySpend(-cost); } };

    try {
        await bot.sendChatAction(chatId, 'typing');
        const result = await tempoRequest('https://wolframalpha.mpp.paywithlocus.com/wolframalpha/short-answer', { i: query });
        const d = result.data || result;
        spending.record('wolfram', cost, query, userId);
        state.incrementRequests(userId);
        const answer = d.text || d.result || (typeof d === 'string' ? d : JSON.stringify(d));
        await bot.sendMessage(chatId, `*Wolfram|Alpha*\n${escapeMd(answer)}\n\n_$${cost.toFixed(3)}_`, { parse_mode: 'Markdown', reply_to_message_id: msgId });
    } catch (err) {
        refund();
        throw err;
    }
}

async function handleMusic(chatId, userId, prompt, msgId) {
    const cost = PRICING.music.fixed;
    checkDailyLimit(cost);

    // Music is async and irreversible — always confirm regardless of threshold.
    const confirmed = await requestConfirmation(chatId, userId, cost,
        'Music Generation', `Suno AI · $${cost.toFixed(2)}`);
    if (!confirmed) return;

    state.reserveDailySpend(cost);
    let charged = true;
    const refund = () => { if (charged) { charged = false; state.addDailySpend(-cost); } };

    try {
    await bot.sendChatAction(chatId, 'typing');
    const result = await tempoRequest('https://suno.mpp.paywithlocus.com/suno/generate-music', { prompt, instrumental: false, customMode: false, model: 'V4' });
    const d = result.data || result;
    spending.record('music', cost, prompt, userId);
    state.incrementRequests(userId);
    const taskId = d.data?.taskId || d.taskId || d.id || d.task_id;
    if (taskId) {
        const statusMsg = await bot.sendMessage(chatId, `*Music generation started*\n\nTask: \`${taskId}\`\n_Suno generates async — 30-60 seconds._\n\n_$${cost.toFixed(2)} · Suno_`, { parse_mode: 'Markdown', reply_to_message_id: msgId });

        // Persist for resume-on-restart (Group J).
        state.addPendingTask({
            id: taskId, type: 'music',
            chatId, statusMsgId: statusMsg.message_id,
            prompt, cost, userId, replyToMsgId: msgId,
        });

        pollMusic(chatId, statusMsg.message_id, taskId, prompt, cost, msgId, userId);
    } else {
        const audioUrl = d.audio_url || d.url || d.songs?.[0]?.audio_url;
        if (audioUrl) {
            await bot.sendAudio(chatId, audioUrl, { caption: `_${escapeMd(prompt.slice(0, 500))}_\n\n_$${cost.toFixed(2)} · Suno_`, parse_mode: 'Markdown', reply_to_message_id: msgId });
        } else {
            await bot.sendMessage(chatId, `Music result:\n\`\`\`\n${JSON.stringify(d, null, 2).slice(0, 3500)}\n\`\`\``, { parse_mode: 'Markdown', reply_to_message_id: msgId });
        }
    }
    } catch (err) {
        refund();
        throw err;
    }
}

function pollMusic(chatId, statusMsgId, taskId, prompt, cost, replyToMsgId, userId, attempt = 0) {
    // 40 attempts × 10s = 400s (~6.5 min) is well beyond Suno's typical 30-60s.
    if (attempt > 40) {
        state.removePendingTask(taskId);
        bot.editMessageText(`Music generation timed out.\n\nTask: \`${taskId}\``, { chat_id: chatId, message_id: statusMsgId, parse_mode: 'Markdown' }).catch(() => {});
        return;
    }
    setTimeout(async () => {
        if (attempt > 0) {
            try {
                await bot.editMessageText(`*Music generating* · ${(attempt + 1) * 10}s\n\nTask: \`${taskId}\``, { chat_id: chatId, message_id: statusMsgId, parse_mode: 'Markdown' });
            } catch (editErr) {
                if (isMessageMissingError(editErr)) {
                    log.info(`pollMusic: status message gone, stopping ${taskId}`);
                    state.removePendingTask(taskId);
                    return;
                }
            }
        }

        try {
            // Each status poll costs ~$0.005 — record it in the ledger.
            recordPoll('music', userId, taskId);

            const result = await tempoRequest('https://suno.mpp.paywithlocus.com/suno/get-music-status', { taskId });
            const d = result.data || result;
            const songs = d.data?.response?.sunoData || d.response?.sunoData || d.sunoData;
            if (songs && songs.length > 0 && songs[0].audioUrl) {
                const s = songs[0];
                state.removePendingTask(taskId);
                await bot.editMessageText(`*Music ready* · $${cost.toFixed(2)}`, { chat_id: chatId, message_id: statusMsgId, parse_mode: 'Markdown' }).catch(() => {});

                const audioCaption = `*${escapeMd(s.title || 'Generated track')}*\n_${escapeMd(prompt.slice(0, 500))}_\n\n_$${cost.toFixed(2)} · Suno_`;
                const audioOpts = { caption: audioCaption, parse_mode: 'Markdown', reply_to_message_id: replyToMsgId };

                // Try with reply_to first; if the original message was deleted,
                // Telegram returns a 400 — retry without reply target so the
                // user still gets the audio they paid for.
                try {
                    await bot.sendAudio(chatId, s.audioUrl, audioOpts);
                } catch (sendErr) {
                    log.warn('sendAudio with reply_to failed, retrying without:', sendErr.message);
                    await bot.sendAudio(chatId, s.audioUrl,
                        { caption: audioCaption, parse_mode: 'Markdown' }).catch(e => log.error('audio delivery failed:', e.message));
                }
                return;
            }
            pollMusic(chatId, statusMsgId, taskId, prompt, cost, replyToMsgId, userId, attempt + 1);
        } catch (err) {
            if (err instanceof TempoError && POLL_STOP_CODES.has(err.code)) {
                log.warn(`pollMusic stopped on ${err.code}: ${taskId}`);
                state.removePendingTask(taskId);
                bot.editMessageText(`Music polling halted: ${err.userMessage}\n\nTask: \`${taskId}\``,
                    { chat_id: chatId, message_id: statusMsgId, parse_mode: 'Markdown' }).catch(() => {});
                return;
            }
            pollMusic(chatId, statusMsgId, taskId, prompt, cost, replyToMsgId, userId, attempt + 1);
        }
    }, 10000);
}

//  14 · Low Balance Monitor
// ═══════════════════════════════════════════════════════════════

async function checkLowBalance(chatId, userId) {
    const wallet = await getWalletInfo();
    if (!wallet.available || wallet.usdc === null) return;

    const u = state.user(userId);
    const now = Date.now();

    // Don't spam — max 1 warning per 4 hours per user
    if (now - (u.last_balance_warn || 0) < 4 * 60 * 60 * 1000) return;

    if (wallet.usdc < CONFIG.lowBalanceCritical) {
        state.setUserField(userId, 'last_balance_warn', now);
        await bot.sendMessage(chatId,
            `🚨 *Critical:* wallet has only $${wallet.usdc.toFixed(2)} USDC left.\n\n` +
            `Fund immediately to keep the bot running.\n\n` +
            `Run in terminal: \`tempo wallet fund\``,
            { parse_mode: 'Markdown' }
        ).catch(() => {});
    } else if (wallet.usdc < CONFIG.lowBalanceWarn) {
        state.setUserField(userId, 'last_balance_warn', now);
        await bot.sendMessage(chatId,
            `⚠️ Wallet is running low: $${wallet.usdc.toFixed(2)} USDC.\n\n` +
            `Consider funding soon: \`tempo wallet fund\``,
            { parse_mode: 'Markdown' }
        ).catch(() => {});
    }
}

// ═══════════════════════════════════════════════════════════════
//  15 · Commands
// ═══════════════════════════════════════════════════════════════

const bot = new TelegramBot(CONFIG.token, {
    polling: {
        interval: 1000,
        autoStart: true,
        params: { timeout: 30 }
    }
});

bot.onText(/^\/start(?:@\w+)?$/i, async (msg) => {
    if (await denyIfNotAllowed(msg)) return;
    const name = msg.from.first_name || 'there';
    bot.sendMessage(msg.chat.id,
        `Hey ${escapeMd(name)}! *Tempo Terminal* here.\n\n` +
        `Pay-as-you-go AI — powered by your Tempo wallet.\n` +
        `No subscriptions. No API keys. Just USDC.\n\n` +
        `Just type anything to get started.\n` +
        `Or tap a button below:`,
        {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [
                [{ text: 'Ask a question', callback_data: 'help:chat' }, { text: 'Generate image', callback_data: 'help:image' }],
                [{ text: 'Choose model', callback_data: 'open:model' }, { text: 'Pricing', callback_data: 'open:pricing' }],
                [{ text: 'All commands · /help', callback_data: 'open:help' }],
            ]}
        }
    );
});

bot.onText(/^\/help(?:@\w+)?$/i, async (msg) => {
    if (await denyIfNotAllowed(msg)) return;
    await bot.sendMessage(msg.chat.id,
        `*Tempo Terminal · reference*\n\n` +
        `*Natural intents* (no prefix needed):\n` +
        `Just type your question — the router picks a service automatically.\n\n` +
        `*Prefixed commands:*\n` +
        `• \`draw [prompt]\` — generate image\n` +
        `• \`read aloud: [text]\` — text-to-speech\n` +
        `• \`extract from [url]\` — parse webpage\n` +
        `• \`deep research [topic]\` — async analysis\n` +
        `• \`translate [text] to [lang]\` — DeepL\n` +
        `• \`weather in [city]\` — OpenWeather\n` +
        `• \`price of [coin]\` — CoinGecko\n` +
        `• \`dune query [topic]\` — onchain data\n` +
        `• \`run python [code]\` — execute code\n` +
        `• \`calc [expression]\` — Wolfram|Alpha\n` +
        `• \`music [prompt]\` — Suno AI\n\n` +
        `*Slash commands:*\n` +
        `/model — switch AI model (per-user)\n` +
        `/image_model — switch image generator\n` +
        `/voice — switch TTS voice\n` +
        `/balance — wallet + runway projection\n` +
        `/stats — spending breakdown\n` +
        `/pricing — full pricing table\n` +
        `/context on|off — toggle conversation memory\n` +
        `/clear — wipe your context\n` +
        `/about — bot info\n\n` +
        `*Safety:*\n` +
        `• Daily cap: $${CONFIG.maxDailySpend} (set via .env)\n` +
        `• Operations >$${CONFIG.confirmThreshold} require confirmation\n` +
        `• Low balance warnings at $${CONFIG.lowBalanceWarn}\n\n` +
        `_Support: [discord.gg/supc](https://discord.gg/supc)_`,
        { parse_mode: 'Markdown', disable_web_page_preview: true }
    );
});

bot.onText(/^\/about(?:@\w+)?$/i, async (msg) => {
    if (await denyIfNotAllowed(msg)) return;
    bot.sendMessage(msg.chat.id,
        `*Tempo Terminal* — Telegram edition\n\n` +
        `A production-grade local AI bot that pays per-request via your own Tempo wallet.\n\n` +
        `*Powered by:*\n` +
        `• Tempo blockchain (stablecoin-native L1)\n` +
        `• Machine Payments Protocol (MPP)\n` +
        `• Parallel · OpenRouter · fal.ai · Deepgram · Suno\n\n` +
        `*This bot runs on:* your machine, polling mode, no VPS required.\n\n` +
        `───\n` +
        `Built by *Sup Cartel*\n` +
        `[discord.gg/supc](https://discord.gg/supc)`,
        { parse_mode: 'Markdown', disable_web_page_preview: true }
    );
});

bot.onText(/^\/balance(?:@\w+)?$/i, async (msg) => {
    if (await denyIfNotAllowed(msg)) return;

    await bot.sendChatAction(msg.chat.id, 'typing');

    const wallet = await getWalletInfo();
    const daily = state.dailyState();
    const u = state.user(msg.from.id);
    const model = getModel(u.model);

    let balanceBlock;
    if (wallet.available && wallet.usdc !== null) {
        // Runway calculations at current model's chat cost
        const capacity = {
            chat:  model.cost > 0 ? Math.floor(wallet.usdc / model.cost) : Infinity,
            image: Math.floor(wallet.usdc / (IMAGE_MODELS[u.image_model || 'flux-schnell'] || IMAGE_MODELS['flux-schnell']).cost),
            tts:   Math.floor(wallet.usdc / PRICING.tts.fixed),
            research: Math.floor(wallet.usdc / PRICING.research.fixed),
        };

        const addrShort = wallet.address
            ? wallet.address.slice(0, 6) + '…' + wallet.address.slice(-4)
            : 'unknown';

        const warn = wallet.usdc < CONFIG.lowBalanceCritical ? '🚨 ' :
                     wallet.usdc < CONFIG.lowBalanceWarn     ? '⚠️ ' : '';

        balanceBlock =
            `*Wallet:* \`${addrShort}\`\n` +
            `*USDC Balance:* ${warn}$${wallet.usdc.toFixed(2)}\n\n` +
            `*Capacity at current model (${escapeMd(model.name)}):*\n` +
            `├─ ~${capacity.chat === Infinity ? 'unlimited' : capacity.chat.toLocaleString()} chat responses\n` +
            `├─ ~${capacity.image.toLocaleString()} images\n` +
            `├─ ~${capacity.tts.toLocaleString()} TTS generations\n` +
            `└─ ~${capacity.research.toLocaleString()} deep research tasks`;
    } else {
        balanceBlock = `⚠️ Could not read wallet info.\nRun \`tempo wallet whoami\` in terminal.`;
    }

    // Runway from last 7d avg (use actual observed days to avoid underestimating
    // pace when the log is young).
    const sum = spending.summary();
    const daysWithData = Math.max(1, Math.min(7, Math.ceil(sum.last7d_days || 7)));
    const avgDaily = sum.last7d / daysWithData;
    const runwayText = (wallet.usdc !== null && avgDaily > 0)
        ? `*At current pace (${avgDaily.toFixed(2)}/day):* ~${Math.floor(wallet.usdc / avgDaily)} days runway`
        : '';

    // Today
    const todayPct = Math.round((daily.daily_spent / CONFIG.maxDailySpend) * 100);
    const todayBar = progressBar(daily.daily_spent, CONFIG.maxDailySpend, 10);

    await bot.sendMessage(msg.chat.id,
        balanceBlock + `\n\n` +
        `*Today:* $${daily.daily_spent.toFixed(2)} / $${CONFIG.maxDailySpend.toFixed(2)}\n` +
        `\`${todayBar}\` ${todayPct}%\n\n` +
        (runwayText ? runwayText + '\n\n' : '') +
        `*Last 7d total:* $${sum.last7d.toFixed(2)}\n` +
        `*All-time total:* $${sum.total.toFixed(2)} _(${sum.count} reqs)_\n\n` +
        `_No gas token needed — Tempo pays fees in USDC._`,
        { parse_mode: 'Markdown' }
    );
});

bot.onText(/^\/stats(?:@\w+)?$/i, async (msg) => {
    if (await denyIfNotAllowed(msg)) return;
    const sum = spending.summary();

    if (sum.count === 0) {
        return bot.sendMessage(msg.chat.id, '_No spending yet._', { parse_mode: 'Markdown' });
    }

    const sorted = Object.entries(sum.byType).sort((a, b) => b[1] - a[1]);
    // Dynamic column width — `poll_research` (13 chars) used to overflow padEnd(9).
    const typeWidth = Math.max(...sorted.map(([t]) => t.length), 9);
    const breakdown = sorted.map(([type, cost]) => {
        const pct = ((cost / sum.total) * 100).toFixed(0);
        return `\`${type.padEnd(typeWidth)}\` $${cost.toFixed(3).padStart(7)} · ${pct.padStart(3)}%`;
    }).join('\n');

    const u = state.user(msg.from.id);
    const daily = state.dailyState();

    bot.sendMessage(msg.chat.id,
        `*Spending breakdown*\n\n${breakdown}\n\n` +
        `───\n` +
        `*Total:* $${sum.total.toFixed(3)} · ${sum.count} reqs\n` +
        `*Last 7d:* $${sum.last7d.toFixed(2)}\n` +
        `*Today:* $${daily.daily_spent.toFixed(2)}\n` +
        `*Your reqs:* ${u.total_requests || 0}`,
        { parse_mode: 'Markdown' }
    );
});

bot.onText(/^\/pricing(?:@\w+)?$/i, async (msg) => {
    if (await denyIfNotAllowed(msg)) return;
    const u = state.user(msg.from.id);
    const m = getModel(u.model);
    const p = PRICING;

    bot.sendMessage(msg.chat.id,
        `*Pricing*\n\n` +
        `*Chat:* $${p.chat.base.toFixed(2)} search + LLM (now: ${m.cost === 0 ? 'Free' : '$' + m.cost.toFixed(3)} · ${escapeMd(m.name)})\n` +
        `*Image:* $${(IMAGE_MODELS[u.image_model||'flux-schnell']||IMAGE_MODELS['flux-schnell']).cost.toFixed(3)} · ${escapeMd((IMAGE_MODELS[u.image_model||'flux-schnell']||IMAGE_MODELS['flux-schnell']).name)}\n` +
        `*TTS:* ~$${p.tts.fixed.toFixed(2)}\n` +
        `*Extract:* $${p.extract.per_url.toFixed(2)}/url\n` +
        `*Research:* $${p.research.fixed.toFixed(2)} · pro\n` +
        `*Translate:* ~$${p.translate.fixed.toFixed(3)}\n` +
        `*Weather:* $${p.weather.fixed.toFixed(3)}\n` +
        `*Crypto:* $${p.crypto.fixed.toFixed(2)}\n` +
        `*Onchain:* $${p.dune.fixed.toFixed(2)} + LLM\n` +
        `*Wolfram:* $${p.wolfram.fixed.toFixed(3)}\n` +
        `*Code:* $${p.code.fixed.toFixed(3)}\n` +
        `*Music:* $${p.music.fixed.toFixed(3)}\n\n` +
        `/model · /voice`,
        { parse_mode: 'Markdown' }
    );
});

bot.onText(/^\/model(?:@\w+)?$/i, async (msg) => {
    if (await denyIfNotAllowed(msg)) return;
    const u = state.user(msg.from.id);
    const m = getModel(u.model);

    bot.sendMessage(msg.chat.id,
        `*Current model:* ${escapeMd(m.name)}\n` +
        `_${escapeMd(m.provider)} · $${m.cost.toFixed(3)} per chat response_\n\n` +
        `Tap to switch:`,
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buildModelKeyboard(u.model) } }
    );
});

bot.onText(/^\/image[_-]?model(?:@\w+)?$/i, async (msg) => {
    if (await denyIfNotAllowed(msg)) return;
    const u = state.user(msg.from.id);
    const current = u.image_model || 'flux-schnell';
    const m = IMAGE_MODELS[current] || IMAGE_MODELS['flux-schnell'];
    bot.sendMessage(msg.chat.id,
        `*Image model:* ${escapeMd(m.name)}\n_$${m.cost.toFixed(3)} per image_\n\nTap to switch:`,
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buildImageModelKeyboard(current) } }
    );
});

bot.onText(/^\/voice(?:@\w+)?$/i, async (msg) => {
    if (await denyIfNotAllowed(msg)) return;
    const u = state.user(msg.from.id);

    bot.sendMessage(msg.chat.id,
        `*TTS voice:* ${escapeMd(u.voice)}\n\nTap to switch:`,
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buildVoiceKeyboard(u.voice) } }
    );
});

bot.onText(/^\/context(?:@\w+)?(?:\s+(on|off|show))?$/i, async (msg, match) => {
    if (await denyIfNotAllowed(msg)) return;
    const u = state.user(msg.from.id);
    const arg = (match[1] || '').toLowerCase();

    if (arg === 'on') {
        state.setUserField(msg.from.id, 'context_enabled', true);
        bot.sendMessage(msg.chat.id, `✓ Context ON — I'll remember last ${CONFIG.contextWindow} exchanges. Use /clear to reset.`);
    } else if (arg === 'off') {
        state.setUserField(msg.from.id, 'context_enabled', false);
        bot.sendMessage(msg.chat.id, '✓ Context OFF — each question is independent.');
    } else if (arg === 'show') {
        if (!u.context.length) return bot.sendMessage(msg.chat.id, '_Context empty._', { parse_mode: 'Markdown' });
        const lines = u.context.slice(-6).map(c =>
            `*${c.role}:* ${escapeMd(c.content.slice(0, 100))}…`
        ).join('\n\n');
        bot.sendMessage(msg.chat.id, `*Recent context:*\n\n${lines}`, { parse_mode: 'Markdown' });
    } else {
        bot.sendMessage(msg.chat.id,
            `*Context mode:* ${u.context_enabled ? 'ON' : 'OFF'} · ${u.context.length} messages stored\n\n` +
            `\`/context on\` — enable memory\n` +
            `\`/context off\` — disable\n` +
            `\`/context show\` — preview stored\n` +
            `\`/clear\` — wipe all`,
            { parse_mode: 'Markdown' }
        );
    }
});

bot.onText(/^\/clear(?:@\w+)?$/i, async (msg) => {
    if (await denyIfNotAllowed(msg)) return;
    state.clearContext(msg.from.id);
    bot.sendMessage(msg.chat.id, '✓ Context cleared.');
});

// ═══════════════════════════════════════════════════════════════
//  16 · Inline Keyboard Builders
// ═══════════════════════════════════════════════════════════════

function buildModelKeyboard(currentId) {
    const tiers = [
        { key: 'balanced', label: '── Balanced ──' },
        { key: 'premium',  label: '── Premium ──'  },
        { key: 'economy',  label: '── Economy ──'  },
        { key: 'free',     label: '── Free ──'     }
    ];

    const keyboard = [];
    for (const tier of tiers) {
        const models = MODEL_CATALOG.filter(m => m.tier === tier.key);
        if (!models.length) continue;
        keyboard.push([{ text: tier.label, callback_data: 'noop' }]);
        for (const m of models) {
            const check = m.id === currentId ? '● ' : '○ ';
            const price = m.cost === 0 ? 'Free' : `$${m.cost.toFixed(3)}`;
            keyboard.push([{
                text: `${check}${m.name}  ·  ${price}`,
                callback_data: `setmodel:${m.id}`
            }]);
        }
    }
    keyboard.push([{ text: '· close ·', callback_data: 'close' }]);
    return keyboard;
}

function buildVoiceKeyboard(currentId) {
    const rows = [];
    for (const v of TTS_VOICES) {
        const check = v.id === currentId ? '● ' : '○ ';
        rows.push([{
            text: `${check}${v.name} · ${v.desc}`,
            callback_data: `setvoice:${v.id}`
        }]);
    }
    rows.push([{ text: '· close ·', callback_data: 'close' }]);
    return rows;
}

function buildImageModelKeyboard(currentId) {
    const rows = [];
    for (const [id, m] of Object.entries(IMAGE_MODELS)) {
        const check = id === currentId ? '● ' : '○ ';
        rows.push([{
            text: `${check}${m.name}  ·  $${m.cost.toFixed(3)}`,
            callback_data: `setimagemodel:${id}`
        }]);
    }
    rows.push([{ text: '· close ·', callback_data: 'close' }]);
    return rows;
}

// ═══════════════════════════════════════════════════════════════
//  17 · Callback Query Router
// ═══════════════════════════════════════════════════════════════

bot.on('callback_query', async (query) => {
    if (!isAllowed(query.from.id)) {
        return bot.answerCallbackQuery(query.id, { text: '🚫 Access denied' }).catch(() => {});
    }

    const data = query.data;
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;

    try {
        if (data === 'noop') {
            return bot.answerCallbackQuery(query.id);
        }

        if (data.startsWith('retry:')) {
            await bot.answerCallbackQuery(query.id, { text: 'Resend your message to retry' });
            await bot.editMessageText('Error cleared. Send your message again.', { chat_id: chatId, message_id: messageId }).catch(() => {});
            return;
        }

        if (data === 'close') {
            await bot.answerCallbackQuery(query.id);
            // Strip the keyboard but keep the message body — preserves the
            // selection/status text as a log entry, and works on messages
            // older than 48h (deleteMessage does not).
            return bot.editMessageReplyMarkup(
                { inline_keyboard: [] },
                { chat_id: chatId, message_id: messageId }
            ).catch(() => {});
        }

        // /start quick buttons
        if (data === 'help:chat') {
            await bot.answerCallbackQuery(query.id, { text: 'Just type your question!' });
            return;
        }
        if (data === 'help:image') {
            await bot.answerCallbackQuery(query.id, { text: 'Type: draw [your prompt]' });
            return;
        }
        if (data === 'open:model') {
            await bot.answerCallbackQuery(query.id);
            const u = state.user(query.from.id);
            return bot.editMessageText('Tap to switch model:', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: buildModelKeyboard(u.model) } });
        }
        if (data === 'open:help') {
            await bot.answerCallbackQuery(query.id);
            const p = PRICING;
            const m = getModel(state.user(query.from.id).model);
            return bot.editMessageText(
                `*Tempo Terminal · reference*\n\n` +
                `*Prefixed commands:*\n` +
                `• \`draw [prompt]\` — image · $${(IMAGE_MODELS[state.user(query.from.id).image_model||'flux-schnell']||IMAGE_MODELS['flux-schnell']).cost.toFixed(3)}\n` +
                `• \`read aloud: [text]\` — TTS · ~$${p.tts.fixed.toFixed(2)}\n` +
                `• \`extract from [url]\` — scrape · $${p.extract.per_url.toFixed(2)}/url\n` +
                `• \`deep research [topic]\` — $${p.research.fixed.toFixed(2)}\n` +
                `• \`translate [text] to [lang]\` — $${p.translate.fixed.toFixed(3)}\n` +
                `• \`weather in [city]\` — $${p.weather.fixed.toFixed(3)}\n` +
                `• \`price of [coin]\` — $${p.crypto.fixed.toFixed(2)}\n` +
                `• \`dune query [topic]\` — $${p.dune.fixed.toFixed(2)} + LLM\n\n` +
                `*Slash commands:*\n` +
                `/model · /voice · /balance · /stats\n` +
                `/pricing · /context · /clear · /about\n\n` +
                `_Model: ${escapeMd(m.name)} · Daily cap: $${CONFIG.maxDailySpend}_`,
                { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown',
                  reply_markup: { inline_keyboard: [[{ text: '← Back', callback_data: 'open:start' }]] } }
            ).catch(() => {});
        }
        if (data === 'open:pricing') {
            await bot.answerCallbackQuery(query.id);
            const p = PRICING;
            const m = getModel(state.user(query.from.id).model);
            return bot.editMessageText(
                `*Pricing*\n\n` +
                `*Chat:* $${p.chat.base.toFixed(2)} search + LLM (${m.cost === 0 ? 'Free' : '$' + m.cost.toFixed(3)} · ${escapeMd(m.name)})\n` +
                `*Image:* $${(IMAGE_MODELS[state.user(query.from.id).image_model||'flux-schnell']||IMAGE_MODELS['flux-schnell']).cost.toFixed(3)}\n` +
                `*TTS:* ~$${p.tts.fixed.toFixed(2)}\n` +
                `*Extract:* $${p.extract.per_url.toFixed(2)}/url\n` +
                `*Research:* $${p.research.fixed.toFixed(2)}\n` +
                `*Translate:* ~$${p.translate.fixed.toFixed(3)}\n` +
                `*Weather:* $${p.weather.fixed.toFixed(3)}\n` +
                `*Crypto:* $${p.crypto.fixed.toFixed(2)}\n` +
                `*Onchain:* $${p.dune.fixed.toFixed(2)} + LLM\n` +
                `*Wolfram:* $${p.wolfram.fixed.toFixed(3)}\n` +
                `*Code:* $${p.code.fixed.toFixed(3)}\n` +
                `*Music:* $${p.music.fixed.toFixed(3)}`,
                { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown',
                  reply_markup: { inline_keyboard: [[{ text: '← Back', callback_data: 'open:start' }]] } }
            ).catch(() => {});
        }
        if (data === 'open:start') {
            await bot.answerCallbackQuery(query.id);
            const name = query.from.first_name || 'there';
            return bot.editMessageText(
                `Hey ${escapeMd(name)}! *Tempo Terminal* here.\n\nPay-as-you-go AI — powered by your Tempo wallet.\nJust type anything to get started.`,
                { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown',
                  reply_markup: { inline_keyboard: [
                    [{ text: 'Ask a question', callback_data: 'help:chat' }, { text: 'Generate image', callback_data: 'help:image' }],
                    [{ text: 'Choose model', callback_data: 'open:model' }, { text: 'Pricing', callback_data: 'open:pricing' }],
                    [{ text: 'All commands', callback_data: 'open:help' }],
                  ]}
                }
            ).catch(() => {});
        }

        if (data.startsWith('setmodel:')) {
            const modelId = data.slice('setmodel:'.length);
            const model = MODEL_BY_ID[modelId];
            if (!model) return bot.answerCallbackQuery(query.id, { text: 'Unknown model' });

            state.setUserField(query.from.id, 'model', modelId);
            await bot.answerCallbackQuery(query.id, { text: `✓ ${model.name} active` });

            await bot.editMessageText(
                `*Model switched to:* ${escapeMd(model.name)}\n` +
                `_${escapeMd(model.provider)} · $${model.cost.toFixed(3)} per response_\n\n` +
                `_${escapeMd(model.desc)}_`,
                {
                    chat_id: chatId,
                    message_id: messageId,
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: buildModelKeyboard(modelId) }
                }
            ).catch(() => {});
            return;
        }

        if (data.startsWith('setvoice:')) {
            const voiceId = data.slice('setvoice:'.length);
            const voice = TTS_VOICES.find(v => v.id === voiceId);
            if (!voice) return bot.answerCallbackQuery(query.id, { text: 'Unknown voice' });

            state.setUserField(query.from.id, 'voice', voiceId);
            await bot.answerCallbackQuery(query.id, { text: `✓ ${voice.name} active` });

            await bot.editMessageText(
                `*Voice switched to:* ${escapeMd(voice.name)}\n_${escapeMd(voice.desc)}_`,
                {
                    chat_id: chatId,
                    message_id: messageId,
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: buildVoiceKeyboard(voiceId) }
                }
            ).catch(() => {});
            return;
        }

        if (data.startsWith('setimagemodel:')) {
            const modelId = data.slice('setimagemodel:'.length);
            const m = IMAGE_MODELS[modelId];
            if (!m) return bot.answerCallbackQuery(query.id, { text: 'Unknown image model' });

            state.setUserField(query.from.id, 'image_model', modelId);
            await bot.answerCallbackQuery(query.id, { text: `✓ ${m.name} active` });

            await bot.editMessageText(
                `*Image model switched to:* ${escapeMd(m.name)}\n_$${m.cost.toFixed(3)} per image_`,
                {
                    chat_id: chatId,
                    message_id: messageId,
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: buildImageModelKeyboard(modelId) }
                }
            ).catch(() => {});
            return;
        }

        if (data.startsWith('confirm:')) {
            const [, confirmId, answer] = data.split(':');
            const pending = pendingConfirmations.get(confirmId);

            if (!pending) {
                return bot.answerCallbackQuery(query.id, { text: 'Expired' });
            }

            if (String(pending.userId) !== String(query.from.id)) {
                return bot.answerCallbackQuery(query.id, { text: 'Not your request' });
            }

            clearTimeout(pending.timer);
            pendingConfirmations.delete(confirmId);

            const accepted = answer === 'yes';
            await bot.answerCallbackQuery(query.id, { text: accepted ? '✓ Confirmed' : '✗ Cancelled' });
            await bot.editMessageText(
                accepted
                    ? `✓ *Confirmed* · ${pending.action} · $${pending.cost.toFixed(2)}`
                    : `✗ *Cancelled* · ${pending.action}`,
                { chat_id: pending.chatId, message_id: pending.messageId, parse_mode: 'Markdown' }
            ).catch(() => {});

            pending.resolve(accepted);
            return;
        }

    } catch (err) {
        log.error('callback handler error:', err);
        bot.answerCallbackQuery(query.id, { text: 'Error' }).catch(() => {});
    }
});

// ═══════════════════════════════════════════════════════════════
//  18 · Main Message Router
// ═══════════════════════════════════════════════════════════════

bot.on('message', async (msg) => {
    if (!msg.text) return;
    if (msg.text.startsWith('/')) return; // commands handled separately

    // Access & rate control
    if (!await guardMessage(msg)) return;

    // Length limit
    if (msg.text.length > 4000) {
        return bot.sendMessage(msg.chat.id, '⚠️ Message too long (max 4000 chars).');
    }

    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const intent = classifyIntent(msg.text);

    // Empty-input guard: bare verbs like `draw`, `translate`, `weather`
    // classify into an intent but the user hasn't supplied an argument.
    // Without this guard the handler runs, hits the upstream API with an
    // empty payload, and either silently produces garbage or fails and
    // refunds — neither is helpful. Server.js has had this guard from day
    // one; telegram-bot.js was missing it.
    const arg = intent.prompt || intent.text || intent.query
              || intent.source || intent.location || intent.ticker || '';
    if (intent.type !== 'chat'
        && intent.type !== 'extract'    // extract validates URLs separately
        && !arg.trim()) {
        return bot.sendMessage(chatId,
            'Please provide input after the command. Type /help for examples.',
            { reply_to_message_id: msg.message_id }
        ).catch(() => {});
    }

    log.info(`request userId=${userId} type=${intent.type} len=${msg.text.length}`);

    try {
        const mid = msg.message_id;
        switch (intent.type) {
            case 'image':     await handleImage(chatId, userId, intent.prompt, mid); break;
            case 'tts':       await handleTTS(chatId, userId, intent.text, mid); break;
            case 'extract':   await handleExtract(chatId, userId, intent.urls, intent.objective, mid); break;
            case 'research':  await handleResearch(chatId, userId, intent.query, mid); break;
            case 'translate': await handleTranslate(chatId, userId, intent.text, intent.target, mid); break;
            case 'weather':   await handleWeather(chatId, userId, intent.location, mid); break;
            case 'crypto':    await handleCrypto(chatId, userId, intent.ticker, mid); break;
            case 'dune':      await handleDune(chatId, userId, intent.query, mid); break;
            case 'code':      await handleCode(chatId, userId, intent.source, intent.lang, mid); break;
            case 'wolfram':   await handleWolfram(chatId, userId, intent.query, mid); break;
            case 'music':     await handleMusic(chatId, userId, intent.prompt, mid); break;
            default:          await handleChat(chatId, userId, intent.query, mid);
        }
    } catch (err) {
        const userMsg = (err instanceof TempoError) ? err.userMessage : `${err.message || 'Unknown error'}`;
        log.error(`handler error userId=${userId} type=${intent.type}:`, err.message);
        bot.sendMessage(chatId, userMsg, {
            reply_to_message_id: msg.message_id,
            reply_markup: { inline_keyboard: [[{ text: 'Retry', callback_data: `retry:${msg.message_id}` }, { text: 'Change model', callback_data: 'open:model' }]] }
        }).catch(() => {});
    }
});

// ═══════════════════════════════════════════════════════════════
//  19 · Error handlers & graceful shutdown
// ═══════════════════════════════════════════════════════════════

bot.on('polling_error', (err) => {
    // Ignore transient polling errors
    if (err.code === 'EFATAL' || /ETELEGRAM.*409/.test(String(err))) {
        log.error('Polling conflict — another bot instance is running. Shutting down.');
        shutdown('polling_conflict');
        return;
    }
    log.warn('polling_error:', err.code || err.message);
});

process.on('unhandledRejection', (err) => log.error('unhandledRejection:', err));
process.on('uncaughtException',  (err) => {
    log.error('uncaughtException — process state may be corrupted, exiting:', err);
    setTimeout(() => process.exit(1), 100).unref();
});

let shuttingDown = false;
async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`${signal} received, shutting down gracefully…`);
    try {
        await bot.stopPolling();
        state.saveNow();
        log.info('Shutdown complete.');
    } catch (e) {
        log.error('shutdown error:', e);
    }
    process.exit(0);
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ═══════════════════════════════════════════════════════════════
//  20 · Boot
// ═══════════════════════════════════════════════════════════════

// Resume any research/music polling that was in flight when the bot was
// last killed. Tasks older than the per-type ceiling are abandoned with a
// user-visible refund — better than silently re-polling something Suno or
// Parallel may have already garbage-collected.
function resumePendingTasks() {
    const tasks = state.getPendingTasks();
    if (!tasks.length) return;
    log.info(`Resuming ${tasks.length} pending task(s) from previous session`);

    const RESEARCH_MAX_AGE = 30 * 60 * 1000; // 30 min — slightly past the 80×15s poll budget
    const MUSIC_MAX_AGE    = 15 * 60 * 1000; // 15 min — past 40×10s

    for (const t of tasks) {
        const age = Date.now() - (t.started_at || 0);
        const maxAge = t.type === 'research' ? RESEARCH_MAX_AGE : MUSIC_MAX_AGE;

        if (age > maxAge) {
            log.warn(`Pending ${t.type} ${t.id} is ${(age/1000).toFixed(0)}s old — abandoning + refunding`);
            state.addDailySpend(-(t.cost || 0));
            spending.record(`${t.type}_refund`, -(t.cost || 0), t.id, t.userId);
            state.removePendingTask(t.id);
            bot.sendMessage(t.chatId,
                `_Pending ${t.type} task expired during restart — refunded $${(t.cost || 0).toFixed(2)}._`,
                { parse_mode: 'Markdown' }
            ).catch(() => {});
            continue;
        }

        log.info(`Resuming ${t.type} ${t.id} (age ${(age/1000).toFixed(0)}s)`);
        if (t.type === 'research') {
            pollResearch(t.chatId, t.statusMsgId, t.id, t.query, t.cost, t.userId, 0);
        } else if (t.type === 'music') {
            pollMusic(t.chatId, t.statusMsgId, t.id, t.prompt, t.cost, t.replyToMsgId, t.userId, 0);
        } else {
            log.warn(`Unknown pending task type ${t.type}, dropping`);
            state.removePendingTask(t.id);
        }
    }
}

(async function boot() {
    const me = await bot.getMe().catch(() => null);
    const handle = me ? `@${me.username}` : '(unknown)';

    console.log(`
═══════════════════════════════════════════════════════════════
  TEMPO TERMINAL · Telegram · v${VERSION}
═══════════════════════════════════════════════════════════════
  ▸ Bot:             ${handle}
  ▸ Mode:            polling (no VPS required)
  ▸ Whitelist:       ${CONFIG.allowedUsers.length ? CONFIG.allowedUsers.join(', ') : '⚠ OPEN — set ALLOWED_USERS in .env'}
  ▸ Default model:   ${getModel(CONFIG.defaultModel).name}
  ▸ Daily cap:       $${CONFIG.maxDailySpend}
  ▸ Confirm over:    $${CONFIG.confirmThreshold}
  ▸ Low balance at:  $${CONFIG.lowBalanceWarn}
  ▸ Context window:  ${CONFIG.contextWindow} msgs (opt-in)
  ▸ Rate limit:      ${CONFIG.rateLimitSec}s gap / ${CONFIG.rateLimitMin} per min
  ▸ State file:      ${CONFIG.stateFile}
  ▸ Log file:        ${CONFIG.logFile}

  Built by Sup Cartel · discord.gg/supc
═══════════════════════════════════════════════════════════════
`);

    if (!CONFIG.allowedUsers.length) {
        log.warn('⚠ No whitelist — anyone finding your bot will drain your wallet!');
        log.warn('  Set ALLOWED_USERS in .env (your ID from @userinfobot)');
    }

    resumePendingTasks();
})();
