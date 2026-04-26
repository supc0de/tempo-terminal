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
install.sh        — Universal installer (macOS, Linux, Windows-via-WSL)
tempo-login.js    — Optional device-code login helper (WSL region bypass)
proxy.js          — Optional HTTP/CONNECT proxy (Windows host → WSL VPN bridge)
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
- copies `server.js`, `telegram-bot.js`, `tempo-cli.js`, `public/index.html` into `~/tempo-terminal/`;
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
nano ~/tempo-terminal/.env
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
cd ~/tempo-terminal && ./start.sh
```
Open http://localhost:3000

**Telegram (separate terminal):**
```bash
cd ~/tempo-terminal && ./start-telegram.sh
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
    <string>cd ~/tempo-terminal && node server.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/Users/YOUR_USER/.tempo/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
  <key>WorkingDirectory</key><string>/Users/YOUR_USER/tempo-terminal</string>
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

The bot runs entirely inside **WSL** (Windows Subsystem for Linux). This keeps the install identical to macOS/Linux — same `install.sh`, same Tempo CLI, same `.env`, same `start.sh`. Three stages: install WSL → install bot → launch.

### Requirements

- Windows 10 build 19041+ or Windows 11
- ~2 GB free disk space (WSL + Ubuntu)

---

## Stage 1 · Install WSL (one-time)

Open **PowerShell as Administrator** and run:

```powershell
wsl --install -d Ubuntu
```

**Reboot** the computer.

After reboot Ubuntu opens automatically. Create a Linux username + password when prompted (these are local to WSL — separate from your Windows account). Close that window when done.

> If the Ubuntu window doesn't appear: open Start → search "Ubuntu" → launch it manually.

---

## Stage 2 · Install the bot inside WSL

Open WSL (Start menu → "Ubuntu", or just type `wsl` in any PowerShell).

Navigate to the project folder. Two cases:

**A) The project lives on your Windows Desktop / Downloads:**
```bash
cd /mnt/c/Users/YOUR_WINDOWS_USERNAME/Desktop/tempo-terminal
```

**B) Cloning fresh inside WSL:**
```bash
cd ~ && git clone https://github.com/supc0de/tempo-terminal.git && cd tempo-terminal
```

Run the installer:
```bash
bash install.sh
```

What happens (5–8 min on a fresh box):
- Installs Node.js 20 LTS
- Installs `jq`
- Installs Tempo CLI to `~/.tempo/bin/tempo`
- Copies the bot to `~/tempo-terminal/`
- `npm install`

Authorize your wallet:
```bash
tempo wallet login          # opens your Windows browser → Windows Hello / passkey
tempo wallet -t whoami      # verify (-t = compact output)
tempo wallet fund           # deposit $10–40 USDC (Base recommended)
```

> **HTTP 451 region error?** Two options: (a) start a VPN on the Windows host and run `node proxy.js` (from `~/tempo-terminal`) to expose it to WSL, then `export ALL_PROXY=http://$(hostname -I | awk '{print $1}'):8888` and retry; (b) run `node tempo-login.js` from PowerShell on the Windows side — it does the login from the host browser and writes the credentials directly into WSL's `~/.tempo/wallet-auth.json`.

---

## Stage 3 · Launch

```bash
cd ~/tempo-terminal
./start.sh                  # Web UI → http://localhost:3000 (open in any Windows browser)
```

For Telegram (separate WSL terminal):
```bash
cd ~/tempo-terminal && ./start-telegram.sh
```

Stop either with `Ctrl+C`.

### Telegram setup (optional)

- **@BotFather** → `/newbot` → copy the token
- **@userinfobot** → `/start` → copy your numeric ID

```bash
nano ~/tempo-terminal/.env
```
Fill in:
```env
TELEGRAM_BOT_TOKEN=your_token_here
ALLOWED_USERS=your_telegram_user_id
```
Multiple users: `ALLOWED_USERS=111111,222222,333333`. **`ALLOWED_USERS` is required** — without it, anyone who finds your bot can drain your wallet.

Save (`Ctrl+O` → Enter → `Ctrl+X`), then `./start-telegram.sh`.

---


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

**`/balance` returns null USDC, only address visible** → You are running an old build. The fix landed in v3.1.0 — make sure `server.js` and `telegram-bot.js` contain the JSON-first whoami parser (look for `parseWhoami` / `JSON.parse(stdout)` in the wallet code).

**Bot not responding** → Check `tempo wallet -t whoami` (balance? `ready: true`?), check logs in terminal output / `bot.log`.

### Windows / WSL

**`wsl --install` does nothing** → Try: `wsl --install -d Ubuntu`

**Ubuntu not opening after reboot** → Open Start menu, search "Ubuntu", launch it manually.

**`The Windows Subsystem for Linux has not been enabled`** → Run as admin: `dism.exe /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart` and `dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart`, then reboot.

**`0x80370102`** → CPU virtualization disabled in BIOS/UEFI. Task Manager → Performance → CPU should say "Virtualization: Enabled".

**`tempo: command not found` after install** → Run: `source ~/.bashrc` in WSL (PATH refresh).

**`tempo wallet login` region error (HTTP 451)** → Tempo is geo-restricted in some regions. Two options:
1. Run a VPN inside WSL before this command, or
2. Run a VPN on Windows + `node proxy.js` from `~/tempo-terminal` on the host, then in WSL: `export ALL_PROXY=http://$(hostname -I | awk '{print $1}'):8888 && tempo wallet login`, or
3. From Windows PowerShell: `node tempo-login.js` — device-code login from the host browser, writes credentials directly into WSL's `~/.tempo/wallet-auth.json`.

**`EADDRINUSE: address already in use`** → Port 3000 busy: `lsof -ti :3000 \| xargs kill` (in WSL), then retry.

**`node: command not found` in WSL** → Node.js wasn't installed correctly. Re-run `bash install.sh` or install manually: `curl -fsSL https://deb.nodesource.com/setup_20.x \| sudo -E bash - && sudo apt-get install -y nodejs`.

**Web UI loads but `/balance` is empty** → Check `tempo wallet -t whoami` in WSL — if it errors, your wallet isn't logged in. If it succeeds, restart the bot: `Ctrl+C` then `./start.sh` (the JSON-first balance parser landed in v3.1.0; older builds returned `usdc: null` against modern Tempo CLI output).

### General

**`insufficient funds`** → Fund your wallet: `tempo wallet fund`

**Change default model** → `LLM_MODEL=anthropic/claude-4.6-sonnet-20260217` in `.env`, restart.

**Increase daily limit** → `MAX_DAILY_SPEND=10.0` in `.env`, restart.

**Daily cap hit too early** → The `cost` per model in the picker is a conservative estimate; real charges run 5–20× lower. Either bump `MAX_DAILY_SPEND`, or rely on Tempo's own `spending_limit` (raised via the wallet UI) and disable the local cap by setting `MAX_DAILY_SPEND` very high.

---

# File locations

### macOS / Linux (after install.sh)
```
~/tempo-terminal/
├── server.js, telegram-bot.js, tempo-cli.js, public/index.html
├── package.json
├── .env                 ← settings (private, not tracked by git)
├── bot-state.json       ← per-user state, daily counter
├── spending.csv         ← spending log (incl. polling)
├── start.sh             ← launcher: web UI
└── start-telegram.sh    ← launcher: telegram
```

### Windows / WSL (after install.sh)
Same layout as macOS / Linux — everything lives inside the WSL home:
```
~/tempo-terminal/                 (= \\wsl$\Ubuntu\home\YOUR_LINUX_USERNAME\tempo-terminal)
├── server.js, telegram-bot.js, tempo-cli.js, public/index.html
├── package.json
├── .env, bot-state.json, spending.csv
├── start.sh
└── start-telegram.sh
```
You can browse those files from Windows Explorer at `\\wsl$\Ubuntu\home\<your-linux-user>\tempo-terminal\` if you ever need to edit `.env` from Notepad instead of `nano`.

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
