# Tempo Terminal

> Local AI assistant with pay-as-you-go billing through your Tempo wallet.
> Web UI + Telegram. No subscriptions. No API keys. No VPS.
>
> Built by **Sup Cartel** · [discord.gg/supc](https://discord.gg/supc)

[![version](https://img.shields.io/badge/version-3.1.0-tungsten)](./CHANGELOG.md)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen)](https://nodejs.org)

---

## Quick start

**macOS / Linux:**
```bash
bash install.sh                # installs Node, jq, Tempo CLI; copies sources to ~/tempo-terminal
tempo wallet login             # creates / connects wallet via passkey
tempo wallet -t whoami         # verify
tempo wallet fund              # deposit ~$10–40 USDC (Base recommended)
cd ~/tempo-terminal && ./start.sh   # http://localhost:3000
```

**Windows (WSL):**

```powershell
wsl --install -d Ubuntu        # admin PowerShell, then reboot
```
After reboot, Ubuntu opens — set Linux username/password. Then inside Ubuntu:
```bash
cd /mnt/c/path/to/tempo-terminal && bash install.sh
tempo wallet login && tempo wallet fund
cd ~/tempo-terminal && ./start.sh   # http://localhost:3000
```

Full setup guide: **[GUIDE.md](./GUIDE.md)** · Release notes: **[CHANGELOG.md](./CHANGELOG.md)**

---

## What it does

| Command | Service | Cost |
|---|---|---|
| Just ask anything | Parallel search + LLM | ~$0.01 + LLM |
| `draw a sunset` | Flux Schnell / Flux Dev / NanoBanana / Stability AI | $0.003–$0.040 |
| `read aloud: text` | Deepgram (Aura voices) | $0.023 |
| `translate hello to spanish` | DeepL | ~$0.025 |
| `price of eth` | CoinGecko | $0.06 |
| `weather in London` | OpenWeather (geocode + current) | $0.011 |
| `deep research [topic]` | Parallel Task pro | $0.10 start + ~$0.005 per status poll (1–3 min) |
| `run python print(42)` | Judge0 (60+ languages) | $0.006 |
| `calc 2^100` | Wolfram\|Alpha | $0.055 |
| `music chill lofi beat` | Suno (V4) | $0.105 start + ~$0.005 per status poll (30–60 s) |
| `extract from https://...` | Parallel Extract | $0.01/url |
| `dune query [topic]` | LLM analyst (Dune-style answer) | $0.01 + LLM |

**25 LLM models** across 4 tiers (Balanced / Premium / Economy / Free) from OpenAI, Anthropic, Google, DeepSeek, xAI, Meta, Mistral, Qwen, NVIDIA, Moonshot.

> The per-call cost shown in the model picker is an upper-bound estimate used for the local daily-spend cap. Tempo typically debits 5–20× less at runtime (e.g. `gpt-4o-mini` ≈ $0.00075/call). Authoritative spend lives in `tempo wallet -t whoami` and `spending.csv`.

---

## Telegram features

- 11 slash commands: `/start /help /about /balance /stats /pricing /model /image_model /voice /context /clear`
- Per-user state (model · image-model · voice · context-memory · request count)
- **Confirmation prompts** for any spend > $0.05; research and music always confirm
- **Resumable async tasks** — research / music polling survives bot restart
- Whitelist enforcement (`ALLOWED_USERS`) with consistent "Access denied" UX
- Group-chat aware: every command matches `/cmd@bot_name`
- Smart rate limiter (sliding window + min-gap)
- Proactive low-balance alerts (warn at $5 / critical at $1)
- Auto-refund on empty research output, on cancellation, on upstream error

---

## Files

```
server.js          — Web UI backend (Express, port 3000)
telegram-bot.js    — Telegram bot (long-poll, no webhook needed)
tempo-cli.js       — Cross-platform Tempo CLI wrapper (PATH → ~/.tempo/bin → wsl tempo)
public/index.html  — Web UI frontend (vanilla JS, dark theme)

install.sh         — Universal installer (macOS, Linux, Windows-via-WSL)

.env.example       — Documented config template
CHANGELOG.md       — Release notes
GUIDE.md           — Full setup guide

test.js            — Live API smoke test (68 assertions)
sim.js             — Telegram bot simulation harness (53 assertions, no network)

proxy.js           — Optional Windows-host → WSL HTTP/CONNECT bridge (for VPN setups)
tempo-login.js     — Optional Windows device-code login (region-blocked workarounds)
```

Runtime files (gitignored, created on first run): `bot-state.json`, `spending.csv`, `bot.log`.

---

## Security

- **Tempo wallet stays on your machine** — passkey via iCloud Keychain / Windows Hello
- **Local-only by default** — Web UI binds to `127.0.0.1`. Set `BIND_HOST=0.0.0.0` only if you understand the LAN exposure
- **Telegram whitelist** is **required** for production use — without `ALLOWED_USERS`, anyone who finds your bot can drain the wallet (the bot warns at boot)
- **Two-layer spend cap** — local `MAX_DAILY_SPEND` for guardrails, Tempo wallet's own `spending_limit` (set via `tempo wallet keys`) is the authoritative ceiling
- **Confirmation prompts** for non-trivial spends; research/music always confirm
- **No API keys stored** — payment is authentication (Machine Payments Protocol)

---

## Verify

```bash
npm test            # 68-assertion live API test (uses real wallet, ~$0.20)
npm run sim         # 53-assertion Telegram simulation (mocked, free, ~1.5 s)
```

---

## Powered by

[Tempo](https://tempo.xyz) · [Machine Payments Protocol](https://mpp.dev)

## License

[MIT](./LICENSE) — © 2026 Sup Cartel

---

*v3.1.0 · 2026 · [discord.gg/supc](https://discord.gg/supc)*
