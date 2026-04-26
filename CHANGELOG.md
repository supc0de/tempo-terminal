# Changelog

All notable changes to Tempo Terminal are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [3.1.0] — 2026-04-25

A reliability and UX release. Three months of operation surfaced a list of
real bugs around money flow, group-chat usage, and async task handling. This
release closes them all, with a `sim.js` regression harness (53 assertions)
to keep them closed.

### Added
- **`/image_model`** Telegram command — switch between Flux Schnell / NanoBanana / Flux Dev / Stability AI per-user. Was only available in the Web UI.
- **Resumable async tasks** — research and music polling state is persisted to `bot-state.json` and resumed on bot restart. Previously, restarting mid-task lost the $0.10 / $0.105 payment and the user got nothing.
- **Polling cost in `spending.csv`** — each `poll_research` / `poll_music` (~$0.005) is now recorded. Used to be invisible to the ledger; up to $0.40 per research and $0.20 per music could leak.
- **Empty-result auto-refund** — if Parallel returns an empty research output, the parent $0.10 is refunded automatically with a clear user-facing message.
- **`sim.js`** — 37-scenario simulation harness exercising slash commands, intent routing, callbacks, confirmation flow, and money paths. Runs in ~1.5 s without sending a single real Telegram or MPP request. Use `npm run sim`.
- **`.env.example`** — documented config template. Stop hand-editing `.env` from blank.
- **`LICENSE`** (MIT) and **`CHANGELOG.md`** files.

### Fixed
- **Group chat support** — every slash command now matches `/cmd@bot_name` syntax. Previously `/^\/cmd$/` rejected the `@suffix` Telegram clients append in groups, so the bot was deaf in any group it was in.
- **Whitelist parity** — `/start` now enforces `ALLOWED_USERS` (used to leak welcome to anyone). All slash commands now show a clear "Access denied" message instead of silently dropping.
- **`/voice` actually changes the voice** — the picker stored the selection, but `handleTTS` never read it. The six aura voice IDs (rachel/adam/etc.) are now mapped to real Deepgram Aura models (`aura-asteria-en`, `aura-arcas-en`, …) and passed in the request payload.
- **Confirmation flow** — `CONFIRM_THRESHOLD` default lowered from `$0.50` to `$0.05` (the previous value never triggered for any single-call operation). Research and music **always** confirm regardless of threshold — they are async, irreversible, and easy to misfire.
- **`chat.base` accounted for** — plain chat reserves `model.cost + $0.01` instead of just `model.cost`. The Parallel search call (always run for chat) was being charged by Tempo but ignored by the local daily-cap accounting.
- **Empty-input guard** — `draw `, `translate `, `weather`, etc. without an argument now return a help message instead of charging for an empty upstream call. `server.js` had this guard from day one; `telegram-bot.js` was missing it.
- **`/balance` works on Tempo CLI ≥ 1.6** — `tempo wallet whoami` now emits JSON. The previous regex parser only understood the legacy text format and returned `usdc: null`. Both `server.js` and `telegram-bot.js` now JSON-first with regex fallback.
- **`close` button on inline menus** — switched from `deleteMessage` to `editMessageReplyMarkup({inline_keyboard: [])`. Preserves the selection text as a log entry, and works on messages older than 48 h (Telegram's `deleteMessage` cutoff) instead of silently failing.
- **`/context` regex anchored** — `/contextxxx` no longer triggers the `/context` handler.
- **Markdown fallback keeps footer** — when the chat handler retries without `parse_mode` after a Telegram parse error, the cost / model footer is now preserved on the last chunk.
- **Music delivery survives a deleted parent message** — `sendAudio` now retries without `reply_to_message_id` if Telegram says the target was deleted, so the user still gets the track they paid for.
- **`/stats` column alignment** — dynamic `padEnd` width based on longest type name. `poll_research` (13 chars) used to overflow into the `$amount` column.
- **Daily-cap polling protection** — pending tasks older than 30 min (research) / 15 min (music) on bot restart are abandoned with auto-refund instead of polling forever.

### Changed
- **`install.sh` rewritten** — was a 3,741-line script with three inline copies of the source heredoc-embedded that drifted from the repo by 600+ lines. Now 328 lines, copies sources from the repo directory at install time. No more silent divergence.
- **`tempo add wallet` removed** — it is not a real Tempo CLI command; the install script swallowed the error with `|| true`. `tempo wallet login` does both wallet creation and connection.
- **`README.md` and `GUIDE.md` rewritten** for accuracy against the current Tempo CLI 1.6 surface.

### Removed
- `install.ps1` (native Windows installer) — turned out to be redundant; the universal `install.sh` runs identically inside WSL and was the source of every Windows-side bug we hit (PowerShell here-string parsing, line-ending differences, `winget` quirks, drift between embedded templates and shipping sources). Windows users now follow the WSL path documented in [GUIDE.md](./GUIDE.md#windows). The `proxy.js` and `tempo-login.js` helpers stay as optional WSL VPN / region-bypass tools.
- `@noble/hashes` dependency — was declared but never imported.

### Security
- `.env` template now sets `ALLOWED_USERS` empty by default with a prominent comment that an empty whitelist makes the bot drainable by anyone who finds it.
- `BIND_HOST=127.0.0.1` is documented as the safe default; `0.0.0.0` exposes your wallet to the LAN.

---

## [3.0.0] — 2026-02

Initial production release. Web UI + Telegram bot, 25 LLM models across 4 tiers, 12 service intents, per-user state, daily spend cap, smart error parsing, atomic state writes.
