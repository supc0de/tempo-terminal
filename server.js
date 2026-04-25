/**
 * ═══════════════════════════════════════════════════════════════
 *  TEMPO TERMINAL · Web UI Backend · v3.1.0
 * ═══════════════════════════════════════════════════════════════
 *  · Per-session model / preset / image-model preferences (cookie-bound LRU)
 *  · Pay-per-request via Tempo CLI (signed MPP), refund on failure
 *  · Multi-model racing with response scoring
 *  · Async task polling (research, music) with daily-cap accounting
 *  · Smart error parsing → user-friendly messages
 *  · Structured logging + atomic state writes + spending CSV rotation
 *  · Graceful shutdown
 *  · Shared state file with telegram-bot.js (atomic writes)
 *
 *  Built by Sup Cartel · discord.gg/supc
 * ═══════════════════════════════════════════════════════════════
 */
const VERSION = '3.1.0';

'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');

const { runTempo } = require('./tempo-cli');

// ═══════════════════════════════════════════════════════════════
//  1 · Environment
// ═══════════════════════════════════════════════════════════════
function parseEnvValue(raw) {
    let v = raw.trim();
    // Handle "quoted" and 'quoted' values — preserve inner whitespace.
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        return v.slice(1, -1);
    }
    // Strip inline comment from unquoted values: KEY=value  # comment
    const hash = v.indexOf(' #');
    if (hash !== -1) v = v.slice(0, hash).trim();
    return v;
}

if (fs.existsSync('.env')) {
    fs.readFileSync('.env', 'utf8').split('\n').forEach(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return;
        const eq = trimmed.indexOf('=');
        if (eq === -1) return;
        const key = trimmed.slice(0, eq).trim();
        const val = parseEnvValue(trimmed.slice(eq + 1));
        if (key && !process.env[key]) process.env[key] = val;
    });
}

const CONFIG = {
    port:               parseInt(process.env.PORT || '3000', 10),
    bindHost:           process.env.BIND_HOST || '127.0.0.1',
    maxDailySpend:      parseFloat(process.env.MAX_DAILY_SPEND || '3.0'),
    defaultModel:       process.env.LLM_MODEL || 'openai/gpt-4o-mini',
    stateFile:          './bot-state.json',
    logFile:            './bot.log',
    spendingFile:       './spending.csv',
    spendingMaxLines:   10000,
    cliTimeout:         120000,
};

// ═══════════════════════════════════════════════════════════════
//  2 · Logger
// ═══════════════════════════════════════════════════════════════
const log = {
    _write(level, args) {
        const ts = new Date().toISOString();
        const parts = args.map(a => {
            if (a instanceof Error) return a.stack || a.message;
            if (typeof a === 'object') { try { return JSON.stringify(a); } catch { return String(a); } }
            return String(a);
        });
        const line = `[${ts}] [${level.padEnd(5)}] [WEB  ] ${parts.join(' ')}`;
        console.log(line);
        try { fs.appendFileSync(CONFIG.logFile, line + '\n'); } catch {}
    },
    info:  (...a) => log._write('INFO',  a),
    warn:  (...a) => log._write('WARN',  a),
    error: (...a) => log._write('ERROR', a),
};

// ═══════════════════════════════════════════════════════════════
//  3 · Model catalog (shared with Telegram bot)
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

const DEFAULT_MODEL = MODEL_BY_ID[CONFIG.defaultModel] ? CONFIG.defaultModel : MODEL_CATALOG[0].id;
function getModel(id) { return MODEL_BY_ID[id] || MODEL_BY_ID[CONFIG.defaultModel] || MODEL_CATALOG[0]; }

const SYSTEM_PRESETS = {
    default:  { name: 'Default',   desc: 'Balanced assistant', prompt: 'You are a concise, precise assistant. Answer in user\'s language. Structure: (1) direct answer in 1–2 sentences, (2) key facts with inline source links [URL]. Use numbers. Stay within data.' },
    coder:    { name: 'Coder',     desc: 'Code-focused',       prompt: 'You are an expert programmer. Write clean, production-ready code. Always include language labels in code blocks. Explain logic briefly. Prefer working examples over theory.' },
    analyst:  { name: 'Analyst',   desc: 'Data & research',    prompt: 'You are a senior data analyst. Structure responses with clear sections, tables, and bullet points. Quantify everything. Cite sources. Compare alternatives objectively.' },
    creative: { name: 'Creative',  desc: 'Writing & ideas',    prompt: 'You are a creative writer and brainstormer. Think outside the box. Use vivid language, metaphors, and storytelling. Generate multiple ideas when asked.' },
    direct:   { name: 'Direct',    desc: 'No fluff, just answers', prompt: 'Answer in the fewest words possible. No filler, no preamble, no disclaimers. Just the answer. Use bullet points for multiple items.' },
    expert:   { name: 'Expert',    desc: 'Deep technical',     prompt: 'You are a domain expert. Assume the user has advanced knowledge. Skip basics. Go deep into implementation details, edge cases, and tradeoffs. Use precise terminology.' },
};
const DEFAULT_PRESET = 'default';
const DEFAULT_IMAGE_MODEL = 'flux-schnell';

// ── Per-session preferences ──
// Stored in memory; survives the tab via a cookie. LRU-evicted.
const MAX_SESSIONS = 200;
const sessions = new Map(); // sid → { model, preset, imageModel, lastSeen }

function makeSessionId() {
    return require('crypto').randomBytes(16).toString('hex');
}

function newSession() {
    return { model: DEFAULT_MODEL, preset: DEFAULT_PRESET, imageModel: DEFAULT_IMAGE_MODEL, lastSeen: Date.now() };
}

function getSession(req, res) {
    const raw = req.headers.cookie || '';
    const match = /(?:^|;\s*)ttid=([a-f0-9]{32})(?:;|$)/.exec(raw);
    let sid = match ? match[1] : null;
    let sess = sid ? sessions.get(sid) : null;
    if (!sess) {
        sid = makeSessionId();
        sess = newSession();
        sessions.set(sid, sess);
        if (res && !res.headersSent) {
            res.setHeader('Set-Cookie', `ttid=${sid}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly`);
        }
    }
    sess.lastSeen = Date.now();
    // LRU eviction
    if (sessions.size > MAX_SESSIONS) {
        let oldestId = null, oldestSeen = Infinity;
        for (const [id, s] of sessions) {
            if (s.lastSeen < oldestSeen) { oldestSeen = s.lastSeen; oldestId = id; }
        }
        if (oldestId && oldestId !== sid) sessions.delete(oldestId);
    }
    return sess;
}

const PRICING = {
    chat:      { base: 0.01 },           // Parallel search + LLM per-token
    image:     { fixed: 0.003 },          // Default Flux Schnell (varies by model)
    tts:       { fixed: 0.023 },          // Deepgram speak
    extract:   { per_url: 0.01 },         // Parallel extract
    research:  { fixed: 0.10 },           // Parallel Task pro
    translate: { fixed: 0.025 },          // DeepL translate
    weather:   { fixed: 0.011 },          // OpenWeather geocode + current
    crypto:    { fixed: 0.06 },           // CoinGecko simple-price
    dune:      { fixed: 0.01 },           // LLM-only
    wolfram:   { fixed: 0.055 },          // Wolfram|Alpha short-answer
    code:      { fixed: 0.006 },          // Judge0 execute-code
    music:     { fixed: 0.105 },          // Suno generate-music
};

const SERVICES_CATALOG = [
    { id: 'openrouter',   name: 'OpenRouter',     category: 'AI · LLM',        endpoint: 'openrouter.mpp.tempo.xyz',   desc: '300+ AI models · chat completions' },
    { id: 'anthropic',    name: 'Anthropic',      category: 'AI · LLM',        endpoint: 'anthropic.mpp.tempo.xyz',    desc: 'Claude models · direct API' },
    { id: 'openai',       name: 'OpenAI',         category: 'AI · LLM',        endpoint: 'openai.mpp.tempo.xyz',       desc: 'GPT models · DALL-E · Whisper' },
    { id: 'gemini',       name: 'Google Gemini',  category: 'AI · LLM',        endpoint: 'gemini.mpp.tempo.xyz',       desc: 'Gemini models · Veo · Imagen' },
    { id: 'deepseek',     name: 'DeepSeek',       category: 'AI · LLM',        endpoint: 'deepseek.mpp.paywithlocus.com', desc: 'DeepSeek V3/R1 · direct' },
    { id: 'mistral',      name: 'Mistral AI',     category: 'AI · LLM',        endpoint: 'mistral.mpp.paywithlocus.com', desc: 'Mistral models · direct' },
    { id: 'grok',         name: 'Grok',           category: 'AI · LLM',        endpoint: 'grok.mpp.paywithlocus.com',  desc: 'xAI Grok · direct' },
    { id: 'perplexity',   name: 'Perplexity',     category: 'AI · Search',     endpoint: 'perplexity.mpp.paywithlocus.com', desc: 'Search-enhanced AI' },
    { id: 'fal',          name: 'fal.ai',         category: 'AI · Media',      endpoint: 'fal.mpp.tempo.xyz',          desc: 'Image · video · audio · 600+ models' },
    { id: 'stablestudio', name: 'StableStudio',   category: 'AI · Media',      endpoint: 'stablestudio.dev',           desc: 'Flux · Sora · Veo · Grok image' },
    { id: 'deepgram',     name: 'Deepgram',       category: 'AI · Audio',      endpoint: 'deepgram.mpp.paywithlocus.com', desc: 'Speech-to-text · TTS' },
    { id: 'judge0',       name: 'Judge0',         category: 'Compute · Code',  endpoint: 'judge0.mpp.paywithlocus.com', desc: 'Code execution · 60+ languages' },
    { id: 'suno',         name: 'Suno',           category: 'AI · Music',      endpoint: 'suno.mpp.paywithlocus.com',  desc: 'Music generation' },
    { id: 'groq',         name: 'Groq',           category: 'AI · Inference',  endpoint: 'groq.mpp.paywithlocus.com',  desc: 'Ultra-fast LLM inference' },
    { id: 'replicate',    name: 'Replicate',      category: 'AI · Media',      endpoint: 'replicate.mpp.paywithlocus.com', desc: 'Open-source AI models' },
    { id: 'parallel',     name: 'Parallel',       category: 'Search · Web',    endpoint: 'parallelmpp.dev',            desc: 'Web search · extract · research' },
    { id: 'exa',          name: 'Exa',            category: 'Search · Web',    endpoint: 'exa.mpp.tempo.xyz',          desc: 'AI-powered web search' },
    { id: 'brave',        name: 'Brave Search',   category: 'Search · Web',    endpoint: 'brave.mpp.paywithlocus.com', desc: 'Private web search' },
    { id: 'tavily',       name: 'Tavily',         category: 'Search · Web',    endpoint: 'tavily.mpp.paywithlocus.com', desc: 'AI search for agents' },
    { id: 'firecrawl',    name: 'Firecrawl',      category: 'Web · Scraping',  endpoint: 'firecrawl.mpp.tempo.xyz',    desc: 'Web scraping · structured data' },
    { id: 'browserbase',  name: 'Browserbase',    category: 'Web · Scraping',  endpoint: 'mpp.browserbase.com',        desc: 'Headless browser sessions' },
    { id: 'deepl',        name: 'DeepL',          category: 'AI · Translation',endpoint: 'deepl.mpp.paywithlocus.com', desc: 'Translation · 30+ languages' },
    { id: 'dune',         name: 'Dune',           category: 'Blockchain · Data',endpoint: 'api.dune.com',              desc: 'Onchain SQL analytics' },
    { id: 'alchemy',      name: 'Alchemy',        category: 'Blockchain · Data',endpoint: 'mpp.alchemy.com',           desc: 'Blockchain APIs · 100+ chains' },
    { id: 'allium',       name: 'Allium',         category: 'Blockchain · Data',endpoint: 'agents.allium.so',          desc: 'Onchain finance data' },
    { id: 'nansen',       name: 'Nansen',         category: 'Blockchain · Data',endpoint: 'api.nansen.ai',             desc: 'Smart money analytics' },
    { id: 'codex',        name: 'Codex',          category: 'Blockchain · Data',endpoint: 'graph.codex.io',            desc: 'Token & prediction markets' },
    { id: 'coingecko',    name: 'CoinGecko',      category: 'Blockchain · Data',endpoint: 'coingecko.mpp.paywithlocus.com', desc: 'Crypto prices · market data' },
    { id: 'conduit',      name: 'Conduit',        category: 'Blockchain · RPC', endpoint: 'mpp.conduit.xyz',           desc: 'EVM JSON-RPC · 60+ networks' },
    { id: 'quicknode',    name: 'Quicknode',      category: 'Blockchain · RPC', endpoint: 'mpp.quicknode.com',         desc: 'JSON-RPC · 80+ blockchains' },
    { id: 'openweather',  name: 'OpenWeather',    category: 'Data · Weather',  endpoint: 'openweather.mpp.paywithlocus.com', desc: 'Weather data worldwide' },
    { id: 'wolframalpha', name: 'Wolfram|Alpha',  category: 'Data · Compute',  endpoint: 'wolframalpha.mpp.paywithlocus.com', desc: 'Computational knowledge' },
    { id: 'modal',        name: 'Modal',          category: 'Compute · GPU',   endpoint: 'modal.mpp.tempo.xyz',        desc: 'Serverless GPU compute' },
    { id: 'stableemail',  name: 'StableEmail',    category: 'Communication',   endpoint: 'stableemail.dev',            desc: 'Email · $0.02/send' },
    { id: 'stablephone',  name: 'StablePhone',    category: 'Communication',   endpoint: 'stablephone.dev',            desc: 'AI phone calls · SMS' },
    { id: 'stablesocial', name: 'StableSocial',   category: 'Social · Data',   endpoint: 'stablesocial.dev',           desc: 'TikTok · Instagram · Reddit data' },
    { id: 'stabletravel', name: 'StableTravel',   category: 'Travel · Data',   endpoint: 'stabletravel.dev',           desc: 'Flights · hotels · activities' },
    { id: 'storage',      name: 'Object Storage', category: 'Storage',         endpoint: 'storage.mpp.tempo.xyz',      desc: 'S3-compatible storage' },
    { id: 'pinata',       name: 'Pinata IPFS',    category: 'Storage',         endpoint: 'mpp.pinata.cloud',           desc: 'IPFS file storage' },
    { id: 'doma',         name: 'Doma',           category: 'Domains',         endpoint: 'mpp.doma.xyz',               desc: 'Domain registration' },
];

// ═══════════════════════════════════════════════════════════════
//  4 · Shared State (compatible with telegram-bot.js)
// ═══════════════════════════════════════════════════════════════
// Atomic write helper: write to a temp file then rename. rename() is atomic
// on the same filesystem, so a concurrent reader never sees a half-written
// JSON blob if two writers (e.g. web server + telegram bot sharing the file)
// end up flushing at the same time.
function atomicWriteFileSync(target, data) {
    const tmp = target + '.tmp.' + process.pid;
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, target);
}

const state = {
    data: { users: {}, daily_spent: 0, daily_reset_date: new Date().toDateString() },
    load() {
        try {
            if (fs.existsSync(CONFIG.stateFile)) {
                this.data = JSON.parse(fs.readFileSync(CONFIG.stateFile, 'utf8'));
                log.info('State loaded from', CONFIG.stateFile);
            }
        } catch (e) {
            log.warn('State load failed, using defaults:', e.message);
        }
    },
    save() {
        try {
            atomicWriteFileSync(CONFIG.stateFile, JSON.stringify(this.data, null, 2));
        } catch (e) {
            log.error('State save failed:', e.message);
        }
    },
    dailyState() {
        const today = new Date().toDateString();
        if (this.data.daily_reset_date !== today) {
            this.data.daily_spent = 0;
            this.data.daily_reset_date = today;
            this.save();
        }
        return this.data;
    },
    addDailySpend(amount) {
        this.dailyState();
        this.data.daily_spent += amount;
        this.save();
    },
};
state.load();

// ═══════════════════════════════════════════════════════════════
//  5 · Tempo CLI with error parsing
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
    const text = ((stderr || '') + '\n' + (stdout || '')).toLowerCase();

    if (text.includes('insufficient funds') || text.includes('insufficient balance'))
        return new TempoError(text, 'Wallet balance too low. Fund it via Tempo CLI.', 'INSUFFICIENT_FUNDS');
    if (text.includes('no key configured') || text.includes('tempo-moderato'))
        return new TempoError(text, 'Configuration error: testnet endpoint detected.', 'WRONG_NETWORK');
    if (text.includes('econnrefused') || text.includes('dns'))
        return new TempoError(text, 'Network issue. Check your internet connection.', 'NETWORK');
    if (text.includes('timeout') || text.includes('timed out'))
        return new TempoError(text, 'Request timed out — the service may be slow.', 'TIMEOUT');
    if (text.includes('rate limit') || text.includes('429'))
        return new TempoError(text, 'Service rate-limited. Wait a moment and retry.', 'RATE_LIMITED');
    if (/(50[0-4])/.test(text))
        return new TempoError(text, 'Service temporarily down. Try again shortly.', 'SERVICE_DOWN');
    if (text.includes('tempo: command not found'))
        return new TempoError(text, 'Tempo CLI not installed. See setup instructions.', 'CLI_MISSING');

    return new TempoError(text, `Request failed: ${(stderr || 'unknown error').slice(0, 200)}`, 'UNKNOWN');
}

async function tempoRequest(url, body) {
    try {
        const { stdout, stderr } = await runTempo(
            ['request', '-X', 'POST', '--json', JSON.stringify(body), url],
            { timeout: CONFIG.cliTimeout }
        );
        if (stderr && stderr.trim()) log.warn('tempo stderr:', stderr.slice(0, 300));
        try { return JSON.parse(stdout); } catch { return { raw: stdout }; }
    } catch (err) {
        throw parseTempoError(err.stderr, err.stdout || err.message);
    }
}

// Parse `tempo wallet whoami` output. Tempo CLI ≥1.6 emits JSON by default;
// older versions printed human-readable text. Try JSON first; fall back to
// regex so the bot keeps working on either format.
function parseWhoami(stdout) {
    const out = { address: null, usdc: null, usdc_total: null, usdc_locked: null, spending_limit: null, ready: null };
    try {
        const j = JSON.parse(stdout);
        out.address = j.wallet || null;
        out.ready = j.ready ?? null;
        if (j.balance) {
            // `available` is total minus locked-in-active-sessions; that's
            // what the user can actually spend right now, so prefer it.
            const avail = parseFloat(j.balance.available);
            const total = parseFloat(j.balance.total);
            out.usdc = isFinite(avail) ? avail : (isFinite(total) ? total : null);
            out.usdc_total = isFinite(total) ? total : null;
            out.usdc_locked = isFinite(parseFloat(j.balance.locked)) ? parseFloat(j.balance.locked) : null;
        }
        if (j.key?.spending_limit) {
            const sl = j.key.spending_limit;
            out.spending_limit = {
                limit: parseFloat(sl.limit),
                remaining: parseFloat(sl.remaining),
                spent: parseFloat(sl.spent),
                unlimited: !!sl.unlimited,
            };
        }
        if (out.address) return out;
    } catch { /* not JSON — fall through to regex */ }

    const usdcMatch = stdout.match(/([\d,]+\.?\d*)\s*USDC/i)
        || stdout.match(/balance[:\s]+\$?([\d,]+\.?\d*)/i);
    if (usdcMatch) out.usdc = parseFloat(usdcMatch[1].replace(/,/g, ''));
    const addrMatch = stdout.match(/0x[a-fA-F0-9]{40}/);
    if (addrMatch) out.address = addrMatch[0];
    return out;
}

async function tempoGet(url) {
    try {
        const { stdout, stderr } = await runTempo(
            ['request', '-X', 'GET', url],
            { timeout: CONFIG.cliTimeout }
        );
        if (stderr && stderr.trim()) log.warn('tempo stderr:', stderr.slice(0, 300));
        try { return JSON.parse(stdout); } catch { return { raw: stdout }; }
    } catch (err) {
        throw parseTempoError(err.stderr, err.stdout || err.message);
    }
}

// ═══════════════════════════════════════════════════════════════
//  6 · Spending tracker (compatible format with telegram-bot)
// ═══════════════════════════════════════════════════════════════
const spending = {
    record(type, cost, query, userId = 'web') {
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
            if (stats.size < 1024 * 1024) return;
            const content = fs.readFileSync(CONFIG.spendingFile, 'utf8').trim().split('\n');
            if (content.length <= CONFIG.spendingMaxLines) return;
            const keep = content.slice(-Math.floor(CONFIG.spendingMaxLines * 0.8));
            const archiveName = `spending.${new Date().toISOString().slice(0, 10)}.csv`;
            fs.writeFileSync(archiveName, content.slice(0, -keep.length).join('\n') + '\n');
            fs.writeFileSync(CONFIG.spendingFile, keep.join('\n') + '\n');
            log.info('Spending rotated to', archiveName);
        } catch (e) {}
    },
    summary() {
        try {
            if (!fs.existsSync(CONFIG.spendingFile)) return { total: 0, byType: {}, count: 0, last7d: 0 };
            const lines = fs.readFileSync(CONFIG.spendingFile, 'utf8').trim().split('\n').filter(Boolean);
            const byType = {};
            let total = 0, last7d = 0;
            const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
            for (const line of lines) {
                const parts = line.split(',');
                const ts = Date.parse(parts[0]);
                const type = parts[2];
                const cost = parseFloat(parts[3]);
                if (!isNaN(cost)) {
                    total += cost;
                    byType[type] = (byType[type] || 0) + cost;
                    if (ts > sevenDaysAgo) last7d += cost;
                }
            }
            return { total, byType, count: lines.length, last7d };
        } catch { return { total: 0, byType: {}, count: 0, last7d: 0 }; }
    },
};

// ═══════════════════════════════════════════════════════════════
//  7 · Daily limit
// ═══════════════════════════════════════════════════════════════
function checkDailyLimit(cost) {
    const daily = state.dailyState();
    if (daily.daily_spent + cost > CONFIG.maxDailySpend) {
        throw new TempoError(
            'daily limit',
            `Daily limit $${CONFIG.maxDailySpend} reached (spent $${daily.daily_spent.toFixed(2)}). Resets at midnight.`,
            'DAILY_LIMIT'
        );
    }
}

// ═══════════════════════════════════════════════════════════════
//  8 · Intent classifier
// ═══════════════════════════════════════════════════════════════
function classifyIntent(message) {
    const msg = message.trim();

    // Each verb-prefix pattern uses (\s+|$) so a bare command (no argument)
    // still classifies into the right intent — the per-handler validation
    // then returns a help message instead of silently falling through to
    // chat and charging for an LLM call.
    if (/^(draw|generate image|create image|image of|picture of|make image)(\s+|$)/i.test(msg)) {
        return { type: 'image', prompt: msg.replace(/^(draw|generate image|create image|image of|picture of|make image)\s*/i, '') };
    }
    if (/^(read aloud|tts|speak|say|voice)([:\s]|$)/i.test(msg)) {
        return { type: 'tts', text: msg.replace(/^(read aloud|tts|speak|say|voice)[:\s]*/i, '') };
    }
    if (/(extract from|scrape|parse from|get data from)/i.test(msg) && /https?:\/\//.test(msg)) {
        const urls = msg.match(/https?:\/\/\S+/g) || [];
        return { type: 'extract', urls, objective: msg };
    }
    if (/(deep research|detailed analysis|in-depth report|comprehensive review)/i.test(msg)) {
        return { type: 'research', query: msg };
    }
    if (/^(translate|translation)(\s|$)/i.test(msg)) {
        let rest = msg.replace(/^(translate|translation)\s+/i, '');
        // Format: "translate to <lang>: text" or "translate to <lang> text" or "translate text to <lang>" or "translate <lang>: text"
        let target = 'English', text = rest;
        let matched = false;

        // "translate to russian: text" or "translate to russian text"
        const prefixMatch = rest.match(/^(to|into)\s+(\w+)\s*[:\-]?\s*/i);
        if (prefixMatch && (DEEPL_CODES[prefixMatch[2].toLowerCase()] || prefixMatch[2].length === 2)) {
            target = prefixMatch[2];
            text = rest.slice(prefixMatch[0].length);
            matched = true;
        }

        if (!matched) {
            // "translate text to russian"
            const suffixMatch = rest.match(/\s+(to|into)\s+(\w+)\s*$/i);
            if (suffixMatch) {
                target = suffixMatch[2];
                text = rest.slice(0, suffixMatch.index).trim();
                matched = true;
            }
        }

        if (!matched) {
            // "translate russian: text"
            const langFirst = rest.match(/^(\w+)\s*[:\-]\s*(.+)/i);
            if (langFirst && DEEPL_CODES[langFirst[1].toLowerCase()]) {
                target = langFirst[1];
                text = langFirst[2];
                matched = true;
            }
        }

        return { type: 'translate', text: text || rest, target };
    }
    if (/^weather(\s+in\s+|\s+|$)/i.test(msg)) {
        return { type: 'weather', location: msg.replace(/^weather(\s+in)?\s*/i, '') };
    }
    if (/^(price of|price)(\s+|$)/i.test(msg)) {
        return { type: 'crypto', ticker: msg.replace(/^(price of|price)\s*/i, '').trim().toLowerCase() };
    }
    if (/^(dune|onchain|blockchain)(\s+(query|sql|data|analysis)|$)/i.test(msg)) {
        return { type: 'dune', query: msg.replace(/^(dune|onchain|blockchain)\s*(query|sql|data|analysis)?\s*/i, '') };
    }
    if (/^(run|execute)(\s+|$)/i.test(msg)) {
        const code = msg.replace(/^(run|execute)\s*(code)?\s*/i, '');
        const langMatch = code.match(/^(python|javascript|js|ruby|go|rust|c|cpp|java|php|swift|kotlin|bash|sh)\s+/i);
        const lang = langMatch ? langMatch[1].toLowerCase() : 'python';
        const src = langMatch ? code.slice(langMatch[0].length) : code;
        return { type: 'code', source: src, lang };
    }
    if (/^(wolfram|calculate|calc|compute)(\s+|$)/i.test(msg)) {
        return { type: 'wolfram', query: msg.replace(/^(wolfram|calculate|calc|compute)\s*/i, '') };
    }
    if (/^(make music|generate music|create song|music)(\s+|$)/i.test(msg)) {
        return { type: 'music', prompt: msg.replace(/^(make music|generate music|create song|music)\s*/i, '') };
    }
    return { type: 'chat', query: msg };
}

// ═══════════════════════════════════════════════════════════════
//  9 · Handlers
// ═══════════════════════════════════════════════════════════════
async function handleChat(query, sess) {
    const model = getModel(sess.model);
    // chat = parallel search ($0.01) + LLM (model.cost). Both signed-MPP.
    const totalCost = model.cost + PRICING.chat.base;

    checkDailyLimit(totalCost);
    state.addDailySpend(totalCost);

    try {
        const search = await tempoRequest(
            'https://parallelmpp.dev/api/search',
            { query, mode: 'one-shot' }
        );

        const llm = await tempoRequest(
            'https://openrouter.mpp.tempo.xyz/v1/chat/completions',
            {
                model: model.id,
                messages: [
                    { role: 'system', content: SYSTEM_PRESETS[sess.preset]?.prompt || SYSTEM_PRESETS.default.prompt },
                    { role: 'user', content: `Question: ${query}\n\nSearch data: ${JSON.stringify(search).slice(0, 15000)}` }
                ],
                temperature: 0.3
            }
        );

        spending.record('chat', totalCost, query);
        return {
            type: 'text',
            content: llm.choices?.[0]?.message?.content || 'Generation error',
            cost: totalCost,
            model_used: model.name,
            sources: search.results?.slice(0, 5).map(r => ({ title: r.title, url: r.url })) || []
        };
    } catch (err) {
        state.addDailySpend(-totalCost);
        throw err;
    }
}

const IMAGE_MODELS = {
    'flux-schnell':  { url: 'https://fal.mpp.tempo.xyz/fal-ai/flux/schnell',   name: 'Flux Schnell',   cost: 0.003 },
    'nano-banana':   { url: 'https://fal.mpp.tempo.xyz/fal-ai/nano-banana-2',  name: 'NanoBanana 2',   cost: 0.04  },
    'flux-dev':      { url: 'https://fal.mpp.tempo.xyz/fal-ai/flux/dev',       name: 'Flux Dev',       cost: 0.025 },
    // NOTE: subdomain differs from the paywithlocus pattern used by other
    // providers ('stability-ai.mpp.paywithlocus.com' vs 'stability.mpp…').
    // Verify this endpoint is live before relying on it in production.
    'stability':     { url: 'https://stability-ai.mpp.paywithlocus.com/stability-ai/generate-core', name: 'Stability AI', cost: 0.034 },
};

async function handleImage(prompt, sess) {
    const imageModelId = sess.imageModel || DEFAULT_IMAGE_MODEL;
    const imgModel = IMAGE_MODELS[imageModelId] || IMAGE_MODELS[DEFAULT_IMAGE_MODEL];
    const cost = imgModel.cost;
    checkDailyLimit(cost);
    state.addDailySpend(cost);

    try {
        const isStability = imageModelId === 'stability';
        const body = isStability
            ? { prompt, aspect_ratio: '1:1', output_format: 'png' }
            : { prompt, image_size: 'square_hd' };
        const result = await tempoRequest(imgModel.url, body);
        const d = result.data || result;
        const imageUrl = d.images?.[0]?.url || d.image_url || d.url;
        const imageB64 = d.image; // Stability AI returns base64
        const content = imageUrl || (imageB64 ? `data:image/png;base64,${imageB64}` : null);
        if (!content) throw new TempoError('no image', 'Image generation returned no data.', 'NO_DATA');
        spending.record('image', cost, prompt);
        return { type: 'image', content, prompt, cost, model_used: imgModel.name };
    } catch (err) {
        state.addDailySpend(-cost);
        throw err;
    }
}

async function handleTTS(text) {
    const cost = PRICING.tts.fixed;
    checkDailyLimit(cost);
    state.addDailySpend(cost);

    try {
        const result = await tempoRequest(
            'https://deepgram.mpp.paywithlocus.com/deepgram/speak',
            { text }
        );
        spending.record('tts', cost, text);
        const d = result.data || result;
        const audioUrl = d.audio_url || d.url;
        const audioB64 = d.data || d.audio;
        const content = audioUrl || (audioB64 ? `data:audio/mpeg;base64,${audioB64}` : null);
        if (!content) throw new TempoError('no audio', 'TTS returned no audio data.', 'NO_DATA');
        return { type: 'audio', content, cost };
    } catch (err) {
        state.addDailySpend(-cost);
        throw err;
    }
}

async function handleExtract(urls, objective) {
    if (!urls || urls.length === 0) {
        throw new TempoError('no urls', 'No URLs found in the message. Include at least one http(s) link.', 'NO_URLS');
    }
    const cost = PRICING.extract.per_url * urls.length;
    checkDailyLimit(cost);
    state.addDailySpend(cost);

    try {
        const result = await tempoRequest(
            'https://parallelmpp.dev/api/extract',
            { urls, objective }
        );
        spending.record('extract', cost, urls.join(','));
        return {
            type: 'text',
            content: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
            cost
        };
    } catch (err) {
        state.addDailySpend(-cost);
        throw err;
    }
}

async function handleResearch(query) {
    const cost = PRICING.research.fixed;
    checkDailyLimit(cost);
    state.addDailySpend(cost);

    try {
        const taskResult = await tempoRequest(
            'https://parallelmpp.dev/api/task',
            { input: query, processor: 'pro' }
        );
        if (!taskResult.run_id) throw new TempoError('No run_id', 'Research task failed to start. Try again.', 'TASK_FAILED');
        spending.record('research', cost, query);
        return {
            type: 'task_started',
            content: `Deep research started — result will appear here in 2–5 min.`,
            run_id: taskResult.run_id,
            cost
        };
    } catch (err) {
        state.addDailySpend(-cost);
        throw err;
    }
}

const DEEPL_CODES = { english:'EN', german:'DE', french:'FR', spanish:'ES', portuguese:'PT', italian:'IT', dutch:'NL', polish:'PL', russian:'RU', japanese:'JA', chinese:'ZH', korean:'KO', turkish:'TR', arabic:'AR', czech:'CS', danish:'DA', finnish:'FI', greek:'EL', hungarian:'HU', indonesian:'ID', norwegian:'NB', romanian:'RO', swedish:'SV', ukrainian:'UK' };

async function handleTranslate(text, target) {
    const cost = PRICING.translate.fixed;
    checkDailyLimit(cost);
    state.addDailySpend(cost);
    try {
        const result = await tempoRequest(
            'https://deepl.mpp.paywithlocus.com/deepl/translate',
            { text: [text], target_lang: DEEPL_CODES[target.toLowerCase()] || target.toUpperCase().slice(0, 2) }
        );
        spending.record('translate', cost, text);
        const d = result.data || result;
        const translated = d.translations?.[0]?.text || JSON.stringify(d);
        return { type: 'text', content: `**${target}:** ${translated}`, cost };
    } catch (err) { state.addDailySpend(-cost); throw err; }
}

async function handleWeather(location) {
    const cost = PRICING.weather.fixed;
    checkDailyLimit(cost);
    state.addDailySpend(cost);
    try {
        // First geocode the location name to lat/lon
        const geo = await tempoRequest(
            'https://openweather.mpp.paywithlocus.com/openweather/geocode',
            { q: location }
        );
        const gd = geo.data || geo;
        const loc = Array.isArray(gd) ? gd[0] : gd;
        if (!loc?.lat) throw new TempoError('geo', `Location "${location}" not found.`, 'NOT_FOUND');

        const result = await tempoRequest(
            'https://openweather.mpp.paywithlocus.com/openweather/current-weather',
            { lat: loc.lat, lon: loc.lon, units: 'metric' }
        );
        spending.record('weather', cost, location);
        const w = result.data || result;
        const content = w.main
            ? `**${w.name || location}**: ${w.main.temp}°C, ${w.weather?.[0]?.description || ''}, humidity ${w.main.humidity}%, wind ${w.wind?.speed || 0} m/s`
            : JSON.stringify(w);
        return { type: 'text', content, cost };
    } catch (err) { state.addDailySpend(-cost); throw err; }
}

const CRYPTO_ALIASES = { btc:'bitcoin', eth:'ethereum', sol:'solana', bnb:'binancecoin', ada:'cardano', xrp:'ripple', dot:'polkadot', doge:'dogecoin', avax:'avalanche-2', matic:'matic-network', link:'chainlink', uni:'uniswap', atom:'cosmos', near:'near', apt:'aptos', arb:'arbitrum', op:'optimism', sui:'sui', ton:'the-open-network', trx:'tron', shib:'shiba-inu', ltc:'litecoin', usdc:'usd-coin', usdt:'tether' };

async function handleCrypto(ticker) {
    const cost = PRICING.crypto.fixed;
    checkDailyLimit(cost);
    state.addDailySpend(cost);
    try {
        const coinId = CRYPTO_ALIASES[ticker] || ticker;
        const result = await tempoRequest(
            'https://coingecko.mpp.paywithlocus.com/coingecko/simple-price',
            { ids: coinId, vs_currencies: 'usd', include_24hr_change: 'true', include_market_cap: 'true' }
        );
        spending.record('crypto', cost, ticker);
        const d = result.data || result;
        const key = Object.keys(d)[0];
        const data = d[key];
        if (!data?.usd) return { type: 'text', content: `Coin "${ticker}" not found. Try full name (e.g. "bitcoin").`, cost };
        const change = data.usd_24h_change;
        const changeStr = change != null ? `${change >= 0 ? '+' : ''}${change.toFixed(2)}%` : '—';
        const mcap = data.usd_market_cap ? `$${(data.usd_market_cap / 1e9).toFixed(2)}B` : '—';
        return { type: 'text', content: `**${ticker.toUpperCase()}** · $${data.usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}\n24h: ${changeStr}  ·  Market cap: ${mcap}`, cost };
    } catch (err) { state.addDailySpend(-cost); throw err; }
}

async function handleDune(query, sess) {
    // Dune uses LLM to answer onchain questions via chat
    const model = getModel(sess.model);
    const cost = model.cost + PRICING.dune.fixed;
    checkDailyLimit(cost);
    state.addDailySpend(cost);
    try {
        const llm = await tempoRequest(
            'https://openrouter.mpp.tempo.xyz/v1/chat/completions',
            {
                model: model.id,
                messages: [
                    { role: 'system', content: 'You are a blockchain data analyst. Answer onchain/DeFi questions using your knowledge. Provide specific numbers, addresses, and data where possible.' },
                    { role: 'user', content: query }
                ],
                temperature: 0.2
            }
        );
        spending.record('dune', cost, query);
        return { type: 'text', content: llm.choices?.[0]?.message?.content || 'No data', cost, model_used: model.name };
    } catch (err) { state.addDailySpend(-cost); throw err; }
}

// ═══════════════════════════════════════════════════════════════
const LANG_IDS = { python:71, javascript:63, js:63, ruby:72, go:60, rust:73, c:50, cpp:54, java:62, php:68, swift:83, kotlin:78, bash:46, sh:46, typescript:74, ts:74 };

async function handleCode(source, lang) {
    const cost = PRICING.code.fixed;
    checkDailyLimit(cost);
    state.addDailySpend(cost);
    try {
        const langId = LANG_IDS[lang] || 71;
        const result = await tempoRequest('https://judge0.mpp.paywithlocus.com/judge0/execute-code', { source_code: source, language_id: langId });
        spending.record('code', cost, source);
        const d = result.data || result;
        const out = d.stdout || d.compile_output || d.stderr || 'No output';
        const status = d.status?.description || '';
        return { type: 'text', content: `**${lang}** · ${status}\n\`\`\`\n${out.trim()}\n\`\`\``, cost };
    } catch (err) { state.addDailySpend(-cost); throw err; }
}

async function handleWolfram(query) {
    const cost = PRICING.wolfram.fixed;
    checkDailyLimit(cost);
    state.addDailySpend(cost);
    try {
        const result = await tempoRequest('https://wolframalpha.mpp.paywithlocus.com/wolframalpha/short-answer', { i: query });
        spending.record('wolfram', cost, query);
        const d = result.data || result;
        const answer = d.text || d.result || (typeof d === 'string' ? d : JSON.stringify(d));
        return { type: 'text', content: `**Wolfram|Alpha**\n${answer}`, cost };
    } catch (err) { state.addDailySpend(-cost); throw err; }
}

async function handleMusic(prompt) {
    const cost = PRICING.music.fixed;
    checkDailyLimit(cost);
    state.addDailySpend(cost);
    try {
        const result = await tempoRequest('https://suno.mpp.paywithlocus.com/suno/generate-music', { prompt, instrumental: false, customMode: false, model: 'V4' });
        spending.record('music', cost, prompt);
        const d = result.data || result;
        const taskId = d.data?.taskId || d.taskId || d.id || d.task_id;
        if (taskId) {
            return { type: 'task_started', content: `Music generating — 30-60 seconds...`, run_id: `music:${taskId}`, cost };
        }
        const audioUrl = d.audio_url || d.url || d.songs?.[0]?.audio_url;
        if (audioUrl) return { type: 'audio', content: audioUrl, cost };
        return { type: 'text', content: '```json\n' + JSON.stringify(d, null, 2).slice(0, 3000) + '\n```', cost };
    } catch (err) { state.addDailySpend(-cost); throw err; }
}

//  10 · Express app
// ═══════════════════════════════════════════════════════════════
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

app.post('/api/chat', async (req, res) => {
    const { message } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: 'Empty message' });

    if (message.length > 4000) return res.status(400).json({ error: 'Message too long (max 4000 characters)' });

    const sess = getSession(req, res);

    try {
        const intent = classifyIntent(message);
        log.info(`${intent.type}: ${message.slice(0, 80)}`);

        // Validate non-empty input for typed intents
        const val = intent.prompt || intent.text || intent.query || intent.source || intent.location || intent.ticker || '';
        if (intent.type !== 'chat' && !val.trim()) {
            return res.json({ type: 'text', content: `Please provide input after the command. Type /help for examples.`, cost: 0 });
        }

        let result;
        switch (intent.type) {
            case 'image':     result = await handleImage(intent.prompt, sess); break;
            case 'tts':       result = await handleTTS(intent.text); break;
            case 'extract':   result = await handleExtract(intent.urls, intent.objective); break;
            case 'research':  result = await handleResearch(intent.query); break;
            case 'translate': result = await handleTranslate(intent.text, intent.target); break;
            case 'weather':   result = await handleWeather(intent.location); break;
            case 'crypto':    result = await handleCrypto(intent.ticker); break;
            case 'dune':      result = await handleDune(intent.query, sess); break;
            case 'code':      result = await handleCode(intent.source, intent.lang); break;
            case 'wolfram':   result = await handleWolfram(intent.query); break;
            case 'music':     result = await handleMusic(intent.prompt); break;
            default:          result = await handleChat(intent.query, sess);
        }
        res.json(result);
    } catch (err) {
        const userMsg = (err instanceof TempoError) ? err.userMessage : `${err.message || 'Unknown error'}`;
        log.error('handler:', err.message);
        res.status(500).json({ error: userMsg });
    }
});

// Model management
app.get('/api/models', (req, res) => {
    const sess = getSession(req, res);
    res.json({ current: sess.model, catalog: MODEL_CATALOG });
});

app.post('/api/models/set', (req, res) => {
    const { model_id } = req.body;
    const model = MODEL_BY_ID[model_id];
    if (!model) return res.status(400).json({ error: 'Unknown model ID' });

    const sess = getSession(req, res);
    sess.model = model_id;
    log.info(`Model switched to: ${model.name}`);
    res.json({ success: true, current: sess.model, model });
});

// ── Multi-model Racing ──
function scoreResponse(text, query) {
    if (!text || text.length < 10) return 0;
    let score = 0;
    const len = text.length;

    // Length — fine-grained (0-25 pts)
    score += Math.min(25, Math.round(len / 120));

    // Structure (0-20 pts)
    const codeBlocks = (text.match(/```/g) || []).length / 2;
    score += Math.min(8, codeBlocks * 4);
    const bullets = (text.match(/^[-*•]\s/gm) || []).length;
    score += Math.min(6, bullets * 1.5);
    const headers = (text.match(/^#{1,3}\s/gm) || []).length;
    score += Math.min(6, headers * 2);

    // Keyword relevance (0-25 pts)
    const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    if (words.length > 0) {
        const lowerText = text.toLowerCase();
        const matched = words.filter(w => lowerText.includes(w)).length;
        score += Math.round((matched / words.length) * 25);
    }

    // Specificity — numbers, data, URLs (0-15 pts)
    const numbers = (text.match(/\d+\.?\d*/g) || []).length;
    score += Math.min(8, numbers);
    const urls = (text.match(/https?:\/\//g) || []).length;
    score += Math.min(4, urls * 2);
    const techTerms = (text.match(/\b(API|SDK|ML|AI|GPU|CPU|RAM|HTTP|JSON|SQL|DeFi|NFT|EVM|RPC)\b/gi) || []).length;
    score += Math.min(3, techTerms);

    // Directness bonus (0-10 pts)
    if (/^[A-Z\d*#]/.test(text)) score += 5;
    if (!/^(Well|So|Okay|Sure|Of course)/i.test(text)) score += 3;
    if (text.split('\n').length > 5) score += 2;

    // Penalties (-30 pts max)
    const hedges = (text.match(/\b(I think|maybe|perhaps|I'm not sure|it depends|I believe)\b/gi) || []).length;
    score -= hedges * 5;
    if (/^(I apologize|I cannot|I'm sorry|As an AI|I don't have)/i.test(text)) score -= 20;
    const filler = (text.match(/\b(basically|actually|essentially|honestly|literally)\b/gi) || []).length;
    score -= filler * 2;

    return Math.max(0, Math.min(100, Math.round(score)));
}

app.post('/api/race', async (req, res) => {
    const { message, models } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: 'Empty message' });
    if (!models || !Array.isArray(models) || models.length < 2) return res.status(400).json({ error: 'Select at least 2 models' });
    if (models.length > 5) return res.status(400).json({ error: 'Max 5 models per race' });

    const validModels = models.map(id => MODEL_BY_ID[id]).filter(Boolean);
    if (validModels.length < 2) return res.status(400).json({ error: 'At least 2 valid models required' });

    const totalCost = validModels.reduce((s, m) => s + m.cost, 0) + 0.01; // search + all models

    // Check limit BEFORE charging. If this throws, catch must not refund
    // because nothing was added — refunding here sent daily_spent negative.
    try {
        checkDailyLimit(totalCost);
    } catch (err) {
        const userMsg = (err instanceof TempoError) ? err.userMessage : err.message;
        return res.status(500).json({ error: userMsg });
    }

    state.addDailySpend(totalCost);
    let charged = true;
    const refund = () => { if (charged) { charged = false; state.addDailySpend(-totalCost); } };

    try {
        log.info(`race: ${validModels.length} models, query: ${message.slice(0, 60)}`);

        // 1. Search once
        const search = await tempoRequest('https://parallelmpp.dev/api/search', { query: message, mode: 'one-shot' });
        const searchData = JSON.stringify(search).slice(0, 12000);

        // 2. Race all models in parallel
        const results = await Promise.allSettled(validModels.map(async (model) => {
            const llm = await tempoRequest('https://openrouter.mpp.tempo.xyz/v1/chat/completions', {
                model: model.id,
                messages: [
                    { role: 'system', content: 'You are a precise, thorough assistant. Give the best possible answer. Use markdown formatting.' },
                    { role: 'user', content: `Question: ${message}\n\nSearch data: ${searchData}` }
                ],
                temperature: 0.4
            });
            return { model, content: llm.choices?.[0]?.message?.content || '' };
        }));

        // 3. Score and rank
        const ranked = results
            .filter(r => r.status === 'fulfilled' && r.value.content)
            .map(r => ({ ...r.value, score: scoreResponse(r.value.content, message) }))
            .sort((a, b) => b.score - a.score);

        const failed = results.filter(r => r.status === 'rejected').map(r => r.reason?.message || 'failed');

        if (ranked.length === 0) {
            refund();
            return res.status(500).json({ error: 'All models failed: ' + failed.join(', ') });
        }

        spending.record('race', totalCost, message);

        res.json({
            type: 'race',
            winner: { model: ranked[0].model.name, content: ranked[0].content, score: ranked[0].score },
            all: ranked.map(r => ({ model: r.model.name, id: r.model.id, score: r.score, preview: r.content.slice(0, 200) })),
            failed,
            cost: totalCost,
            model_count: validModels.length
        });
    } catch (err) {
        refund();
        const userMsg = (err instanceof TempoError) ? err.userMessage : err.message;
        res.status(500).json({ error: userMsg });
    }
});

app.get('/api/presets', (req, res) => {
    const sess = getSession(req, res);
    res.json({ current: sess.preset, presets: Object.entries(SYSTEM_PRESETS).map(([id, p]) => ({ id, ...p })) });
});
app.post('/api/presets/set', (req, res) => {
    const { preset_id } = req.body;
    if (!SYSTEM_PRESETS[preset_id]) return res.status(400).json({ error: 'Unknown preset' });
    const sess = getSession(req, res);
    sess.preset = preset_id;
    log.info(`Preset switched to: ${SYSTEM_PRESETS[preset_id].name}`);
    res.json({ success: true, current: sess.preset });
});

app.get('/api/image-models', (req, res) => {
    const sess = getSession(req, res);
    res.json({ current: sess.imageModel, models: Object.entries(IMAGE_MODELS).map(([id, m]) => ({ id, ...m })) });
});

app.post('/api/image-models/set', (req, res) => {
    const { model_id } = req.body;
    if (!IMAGE_MODELS[model_id]) return res.status(400).json({ error: 'Unknown image model' });
    const sess = getSession(req, res);
    sess.imageModel = model_id;
    log.info(`Image model switched to: ${IMAGE_MODELS[model_id].name}`);
    res.json({ success: true, current: sess.imageModel, model: IMAGE_MODELS[model_id] });
});

app.get('/api/services', (req, res) => {
    res.json({ services: SERVICES_CATALOG, pricing: PRICING });
});

// Error codes where the client should stop polling — further attempts will
// keep signing failing MPP requests without helping the user.
const POLL_STOP_CODES = new Set(['INSUFFICIENT_FUNDS', 'AUTH', 'DAILY_LIMIT', 'WRONG_NETWORK', 'CLI_MISSING']);

// Per-poll wallet costs from the Tempo registry (USDC.e, 6-decimals).
// Verified via `tempo wallet services suno|parallel` on 2026-04-25.
const POLL_COST = {
    music_status: 0.005,   // suno/get-music-status — 5000 units
    research:     0.005,   // parallel /api/task/<id> — flat poll
};

app.get('/api/task/:runId', async (req, res) => {
    const runId = req.params.runId;

    // Music task polling (run_id starts with "music:")
    if (runId.startsWith('music:')) {
        const taskId = runId.slice(6);
        const pollCost = POLL_COST.music_status;
        let charged = false;
        try {
            checkDailyLimit(pollCost);
            state.addDailySpend(pollCost);
            charged = true;
            const result = await tempoRequest('https://suno.mpp.paywithlocus.com/suno/get-music-status', { taskId });
            spending.record('poll_music', pollCost, taskId);
            const d = result.data || result;
            const songs = d.data?.response?.sunoData || d.response?.sunoData || d.sunoData;
            if (songs && songs.length > 0 && songs[0].audioUrl) {
                return res.json({ status: 'completed', audio_url: songs[0].audioUrl, title: songs[0].title, tags: songs[0].tags, duration: songs[0].duration });
            }
            return res.json({ status: 'processing' });
        } catch (err) {
            if (charged) state.addDailySpend(-pollCost);
            const userMsg = (err instanceof TempoError) ? err.userMessage : err.message;
            const halt = (err instanceof TempoError) && POLL_STOP_CODES.has(err.code);
            return res.status(500).json({ error: userMsg, halt });
        }
    }

    // Research task polling
    if (!/^[a-zA-Z0-9_-]+$/.test(runId)) return res.status(400).json({ error: 'Invalid run ID' });
    const pollCost = POLL_COST.research;
    let charged = false;
    try {
        checkDailyLimit(pollCost);
        state.addDailySpend(pollCost);
        charged = true;
        const data = await tempoGet(`https://parallelmpp.dev/api/task/${runId}`);
        spending.record('poll_research', pollCost, runId);
        res.json(data);
    } catch (err) {
        if (charged) state.addDailySpend(-pollCost);
        const userMsg = (err instanceof TempoError) ? err.userMessage : err.message;
        const halt = (err instanceof TempoError) && POLL_STOP_CODES.has(err.code);
        res.status(500).json({ error: userMsg, halt });
    }
});

app.get('/api/balance', async (req, res) => {
    const sess = getSession(req, res);
    try {
        const { stdout } = await runTempo(['wallet', 'whoami'], { timeout: 10000 });
        const parsed = parseWhoami(stdout);
        res.json({
            raw: stdout,
            address: parsed.address,
            usdc: parsed.usdc,
            usdc_total: parsed.usdc_total,
            usdc_locked: parsed.usdc_locked,
            spending_limit: parsed.spending_limit,
            ready: parsed.ready,
            daily_spent: state.dailyState().daily_spent,
            daily_limit: CONFIG.maxDailySpend,
            current_model: sess.model
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/stats', (req, res) => {
    const sess = getSession(req, res);
    const sum = spending.summary();
    res.json({
        total: +sum.total.toFixed(4),
        byType: sum.byType,
        count: sum.count,
        last7d: sum.last7d,
        daily_spent: state.dailyState().daily_spent,
        daily_limit: CONFIG.maxDailySpend,
        current_model: sess.model
    });
});

// ═══════════════════════════════════════════════════════════════
//  11 · Lifecycle
// ═══════════════════════════════════════════════════════════════
const server = app.listen(CONFIG.port, CONFIG.bindHost, () => {
    const m = getModel(DEFAULT_MODEL);
    const exposedWarn = CONFIG.bindHost === '0.0.0.0' || CONFIG.bindHost === '::'
        ? '\n  ⚠ BIND_HOST is public — wallet is reachable from your network.\n'
        : '';
    console.log(`
═══════════════════════════════════════════════════════
  TEMPO TERMINAL · Web UI · v${VERSION}
═══════════════════════════════════════════════════════
  ▸ URL:          http://${CONFIG.bindHost === '0.0.0.0' ? 'localhost' : CONFIG.bindHost}:${CONFIG.port}
  ▸ Bind:         ${CONFIG.bindHost}:${CONFIG.port}
  ▸ Daily cap:    $${CONFIG.maxDailySpend}
  ▸ Model:        ${m.name} (${m.cost === 0 ? 'Free' : '$' + m.cost.toFixed(3)})
  ▸ State file:   ${CONFIG.stateFile}${exposedWarn}

  Built by Sup Cartel · discord.gg/supc
═══════════════════════════════════════════════════════
`);
});

let shuttingDown = false;
function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`${signal} received, shutting down gracefully…`);
    server.close(() => {
        state.save();
        log.info('Web UI stopped cleanly.');
        process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000);
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => log.error('unhandledRejection:', err));
process.on('uncaughtException',  (err) => {
    log.error('uncaughtException — process state may be corrupted, exiting:', err);
    setTimeout(() => process.exit(1), 100).unref();
});
