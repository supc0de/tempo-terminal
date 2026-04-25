# Tempo Terminal — Setup Guide

Local AI assistant with pay-as-you-go billing through your Tempo wallet. Web UI + Telegram. No subscriptions.

**Built by Sup Cartel** · [discord.gg/supc](https://discord.gg/supc)

---

## What this replaces

| Subscription | $/mo | Tempo equivalent |
|---|---|---|
| ChatGPT Plus | $20 | OpenRouter via Tempo |
| Midjourney | $10 | Flux / Stability AI via Tempo |
| ElevenLabs | $5 | Deepgram via Tempo |
| Perplexity Pro | $20 | Parallel via Tempo |
| **Total** | **$55** | **~$2 pay-as-you-go** |

Initial funding: **$10–40 USDC** is plenty to start.

---

## Repository contents

```
server.js         — Web UI backend (Express)
telegram-bot.js   — Telegram bot
public/index.html — Web UI frontend
tempo-cli.js      — Cross-platform Tempo CLI wrapper
install.sh        — macOS/Linux installer (copies sources to ~/tempo-bot)
install.ps1       — Windows installer
tempo-login.js    — Optional Windows device-code login bypass
proxy.js          — Optional HTTP/CONNECT proxy (Windows host → WSL VPN)
```

---

# macOS / Linux

### 1. Install

From inside the repository:
```bash
bash install.sh
```

The script:
- installs Homebrew (if needed), Node.js 20, jq, and Tempo CLI;
- copies `server.js`, `telegram-bot.js`, `tempo-cli.js`, `public/index.html` into `~/tempo-bot/`;
- creates `start.sh` / `start-telegram.sh`, default `.env`, `package.json`, `.gitignore`;
- runs `npm install`.

**Time:** 3–8 minutes on a fresh machine.

### 2. Wallet — login + verify

A single command creates the wallet if you don't have one and connects it if you do.

```bash
tempo wallet login          # opens browser → Touch ID / iCloud Keychain passkey
tempo wallet -t whoami      # verify (-t = compact / machine-readable output)
```

> There is **no** `tempo add wallet` command — `tempo wallet login` does both creation and connection.

### 3. Fund your wallet ($10–40 USDC)

```bash
tempo wallet fund
```

Pick **Network** (Base / Ethereum / Solana / Optimism / Unichain / Abstract / Arbitrum) and **Token** (USDC / ETH / WETH / cbBTC / SOL / WBTC), then send the exact token on the exact network shown. Funds arrive in 1–5 minutes.

> Only send the exact token on the exact network shown. Other assets sent to the wrong network may be lost.

### 4. Telegram setup (optional)

- **@BotFather** → `/newbot` → copy the token
- **@userinfobot** → `/start` → copy your numeric ID

```bash
nano ~/tempo-bot/.env
```

```env
TELEGRAM_BOT_TOKEN=your_token_here
ALLOWED_USERS=your_user_id
```

Multiple users: `ALLOWED_USERS=111111,222222,333333`

> **`ALLOWED_USERS` is required.** Without it the bot is open — anyone who finds it can drain your wallet.

### 5. Launch

**Web UI:**
```bash
cd ~/tempo-bot && ./start.sh
```
Open http://localhost:3000

**Telegram (separate terminal):**
```bash
cd ~/tempo-bot && ./start-telegram.sh
```

### 6. Auto-start (optional, macOS)

`~/Library/LaunchAgents/com.sup-cartel.tempo.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.sup-cartel.tempo</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>-lc</string>
    <string>cd ~/tempo-bot && node server.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/Users/YOUR_USER/.tempo/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
  <key>WorkingDirectory</key><string>/Users/YOUR_USER/tempo-bot</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/tempo.log</string>
  <key>StandardErrorPath</key><string>/tmp/tempo-error.log</string>
</dict>
</plist>
```

Replace `YOUR_USER` in **both** places, then:
```bash
launchctl load ~/Library/LaunchAgents/com.sup-cartel.tempo.plist
```

---

# Windows

Windows runs the bot from WSL (Windows Subsystem for Linux).

The recommended Windows path is **one PowerShell command**: `install.ps1` does the rest, including dropping Desktop launchers. WSL is used only as a host for Tempo CLI; the bot itself runs as a native Windows Node.js process.

### Requirements

- Windows 10 build 19041+ or Windows 11
- ~2 GB free disk space (for WSL + Ubuntu)

### 1. Install WSL (one-time, requires admin + reboot)

PowerShell **as Administrator**:
```powershell
wsl --install -d Ubuntu
```
Reboot. Ubuntu opens automatically — create a Linux username and password when prompted, then close that window.

### 2. Run the installer

In a regular PowerShell, from inside the project folder:
```powershell
powershell -ExecutionPolicy Bypass -File install.ps1
```

What it does:
- Installs Node.js 20 LTS on Windows via `winget` (skipped if already present).
- Copies the bot to `%USERPROFILE%\tempo-bot` (preserves any existing `.env`, `bot-state.json`, `spending.csv`).
- Runs `npm install`.
- Auto-detects an Ubuntu/Debian WSL distro and installs Tempo CLI inside it.
- Drops a `Tempo Bot` folder on your Desktop with three launchers: `start.bat`, `start-telegram.bat`, `wallet.bat`.

### 3. Log in to your wallet

Double-click `wallet.bat` on your Desktop → option **2** (Login). The browser opens — authenticate with Windows Hello or your passkey.

> If you see a region error (HTTP 451), you need a VPN active before this step. Two ways: run the VPN on Windows and use [`proxy.js`](./proxy.js) to expose it to WSL, **or** run the device-code helper from PowerShell:
> ```powershell
> node tempo-login.js
> ```
> It does the login from the host browser and writes credentials directly into WSL's `~/.tempo/wallet-auth.json`.

### 4. Fund your wallet

`wallet.bat` → option **3** (Add funds). Pick network / token, send ~$10–40 USDC (Base recommended), funds arrive in 1–5 minutes.

Verify any time via `wallet.bat` → option **1** (Show wallet info).

### 5. Telegram setup (optional)

- **@BotFather** → `/newbot` → copy the token
- **@userinfobot** → `/start` → copy your numeric ID

`wallet.bat` → option **4** (Edit configuration) opens `.env` in Notepad. Fill in:
```env
TELEGRAM_BOT_TOKEN=your_token_here
ALLOWED_USERS=your_telegram_user_id
```

Multiple users: `ALLOWED_USERS=111111,222222,333333`. Without `ALLOWED_USERS` the bot is open — anyone who finds it can drain your wallet.

### 6. Launch

- **Web UI** — double-click `start.bat` on your Desktop. The browser opens at http://localhost:3000 automatically.
- **Telegram** — double-click `start-telegram.bat` (separate window).

Stop either with `Ctrl+C`.

### Manual / WSL-only flow (advanced)

If you'd rather run the bot from inside WSL and skip the native-Windows installer entirely, here is the long path:

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs
curl -fsSL https://tempo.xyz/install | bash && source ~/.bashrc
tempo wallet login && tempo wallet fund
cd /mnt/c/Users/YOUR_USERNAME/path/to/tempo-terminal
npm install
cp .env.example .env && nano .env
node server.js              # Web UI
node telegram-bot.js        # Telegram (separate terminal)
```

---

# Usage

### Commands (same in Web UI and Telegram)

| Action | Example | Cost |
|---|---|---|
| Search + answer | `What's new with Tempo?` | ~$0.01 + LLM |
| Generate image | `draw a cat in a hat` | $0.003–$0.034 |
| Text-to-speech | `read aloud: hello world` | $0.023 |
| Translate | `translate hello to spanish` | ~$0.025 |
| Crypto price | `price of eth` | $0.06 |
| Weather | `weather in London` | $0.011 (geocode + current) |
| Parse URL | `extract from https://tempo.xyz` | $0.01/url |
| Deep research | `deep research [topic]` | $0.10 start + ~$0.005 per status poll (1–5 min) |
| Run code | `run python print(42)` | $0.006 |
| Calculate | `calc 2^100` | $0.055 |
| Generate music | `music chill lofi beat` | $0.105 + ~$0.005 per status poll |
| Onchain analysis | `dune query [topic]` | $0.01 + LLM |

### Telegram slash commands

| Command | Action |
|---|---|
| `/start` | Welcome + quick-start buttons |
| `/model` | Switch LLM model (inline keyboard) |
| `/voice` | Switch TTS voice |
| `/balance` | USDC balance + runway projection |
| `/stats` | Spending breakdown |
| `/pricing` | Full pricing table |
| `/context on\|off` | Toggle conversation memory |
| `/clear` | Clear context |
| `/help` / `/about` | Reference |

### Switching models

**Web UI:** click the dropdown in the sidebar — 25 models across 4 tiers (Balanced / Premium / Economy / Free).

**Telegram:** `/model` → pick from the inline keyboard.

Default: `openai/gpt-4o-mini`. For serious analysis: `anthropic/claude-4.6-sonnet-20260217`.

> The `cost` shown next to each model in the picker is a **local upper-bound estimate** used for the daily-spend cap. Actual per-call charges are typically much smaller (Tempo bills you only for what was actually consumed). The wallet's `spending_limit` (visible in `tempo wallet -t whoami`) is the real authoritative cap.

---

# Troubleshooting

### macOS

**`tempo: command not found`** → Close and reopen Terminal. Or: `source ~/.zshrc`

**`zsh: no matches found`** with URLs → not an issue when running through this bot (it uses `execFile`, not the shell). If you hit it running `tempo` directly, wrap the URL in quotes: `tempo request "https://..."`.

**`409 Conflict`** in Telegram → Two instances running. `pkill -f "node telegram-bot.js"`, start one.

**`/balance` returns null USDC, only address visible** → You are running an old build. The fix landed in v3.1 — make sure `server.js` and `telegram-bot.js` contain the JSON-first whoami parser (look for `parseWhoami` / `JSON.parse(stdout)` in the wallet code).

**Bot not responding** → Check `tempo wallet -t whoami` (balance? `ready: true`?), check logs in terminal output / `bot.log`.

### Windows / WSL

**`wsl --install` does nothing** → Try: `wsl --install -d Ubuntu`

**Ubuntu not opening after reboot** → Open Start menu, search "Ubuntu", launch it manually.

**`tempo: command not found` in WSL** → Run: `source ~/.bashrc`

**`tempo wallet login` region error (HTTP 451)** → Tempo is geo-restricted in some regions. Two options:
1. VPN inside WSL before running the command, or
2. From Windows PowerShell run `node tempo-login.js` — does the device-code login from your Windows browser and writes credentials directly into WSL's `~/.tempo/`.

**`EADDRINUSE: address already in use`** → Port 3000 busy: `fuser -k 3000/tcp`, then retry.

**`0x80370102`** → Virtualization disabled in BIOS. Task Manager → Performance → CPU should say "Virtualization: Enabled".

**`node: command not found` in WSL** → Node.js is not installed in WSL. Run step 2 of the Windows guide.

### General

**`insufficient funds`** → Fund your wallet: `tempo wallet fund`

**Change default model** → `LLM_MODEL=anthropic/claude-4.6-sonnet-20260217` in `.env`, restart.

**Increase daily limit** → `MAX_DAILY_SPEND=10.0` in `.env`, restart.

**Daily cap hit too early** → The `cost` per model in the picker is a conservative estimate; real charges run 5–20× lower. Either bump `MAX_DAILY_SPEND`, or rely on Tempo's own `spending_limit` (raised via the wallet UI) and disable the local cap by setting `MAX_DAILY_SPEND` very high.

---

# File locations

### macOS / Linux (after install.sh)
```
~/tempo-bot/
├── server.js, telegram-bot.js, tempo-cli.js, public/index.html
├── package.json
├── .env                 ← settings (private, not tracked by git)
├── bot-state.json       ← per-user state, daily counter
├── spending.csv         ← spending log (incl. polling)
├── start.sh             ← launcher: web UI
└── start-telegram.sh    ← launcher: telegram
```

### Windows / WSL
```
/mnt/c/Users/YOUR_USERNAME/Desktop/tempo-terminal/
├── server.js, telegram-bot.js, tempo-cli.js, public/index.html
├── .env, bot-state.json, spending.csv
└── ...
```

---

# What's tracked in `spending.csv`

Every chargeable call is recorded as one CSV row: `timestamp, user_id, type, cost_usd, "query"`.

Types include `chat`, `image`, `tts`, `translate`, `weather`, `crypto`, `code`, `wolfram`, `music`, `extract`, `research`, `dune`, `race`, plus **`poll_music`** and **`poll_research`** (≈$0.005 each, billed by Tempo for every status check on long-running tasks). Rotation kicks in at 1 MB / 10 000 rows.

---

# Support

- **Tempo docs:** https://docs.tempo.xyz
- **Tempo CLI reference:** https://docs.tempo.xyz/cli
- **Sup Cartel Discord:** [discord.gg/supc](https://discord.gg/supc)

---

*Built by Sup Cartel · 2026*
