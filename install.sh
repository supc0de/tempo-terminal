#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
#  TEMPO TERMINAL · Installer v3.1.0
#
#  Built by Sup Cartel · discord.gg/supc
# ═══════════════════════════════════════════════════════════════
#  Supports: macOS, Linux (including WSL2 on Windows)
#
#  Run from inside the repository:
#    bash install.sh
#
#  v3.1.0 — copies sources from this repo instead of embedding outdated
#           heredocs. Drops the bogus `tempo add wallet` step (no such
#           command exists in Tempo CLI; `tempo wallet login` does both).
# ═══════════════════════════════════════════════════════════════

set -euo pipefail

# Colors
if [ -t 1 ]; then
    GREEN='\033[0;32m'; BLUE='\033[0;34m'; YELLOW='\033[1;33m'
    RED='\033[0;31m'; BOLD='\033[1m'; DIM='\033[2m'; NC='\033[0m'
else
    GREEN=''; BLUE=''; YELLOW=''; RED=''; BOLD=''; DIM=''; NC=''
fi

log_info()  { echo -e "${BLUE}ℹ${NC}  $*"; }
log_ok()    { echo -e "${GREEN}✓${NC}  $*"; }
log_warn()  { echo -e "${YELLOW}⚠${NC}  $*"; }
log_error() { echo -e "${RED}✗${NC}  $*"; }
log_step()  { echo -e "\n${BOLD}${BLUE}▸ $*${NC}\n"; }

# Resolve where this script lives — we copy sources from here.
SCRIPT_DIR="$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"

# Banner
cat <<'BANNER_END'

╔══════════════════════════════════════════════════════╗
║                                                      ║
║              TEMPO TERMINAL · v3.1.0                 ║
║                                                      ║
║    Local AI assistant with pay-as-you-go billing     ║
║             via your Tempo wallet                    ║
║                                                      ║
║         Built by Sup Cartel · discord.gg/supc        ║
║                                                      ║
╚══════════════════════════════════════════════════════╝

BANNER_END

# ───────────────────────────────────────────────────────────────
# 1. Detect OS
# ───────────────────────────────────────────────────────────────
log_step "Detecting your system"

OS=""
case "$(uname -s)" in
    Darwin)
        OS="macos"
        log_ok "Detected: macOS ($(sw_vers -productVersion 2>/dev/null || echo unknown))"
        ;;
    Linux)
        if grep -qi microsoft /proc/version 2>/dev/null; then
            OS="wsl"
            log_ok "Detected: Windows (WSL)"
        else
            OS="linux"
            log_ok "Detected: Linux"
        fi
        ;;
    *)
        log_error "Unsupported OS: $(uname -s)"
        exit 1
        ;;
esac

INSTALL_DIR="$HOME/tempo-terminal"

# ───────────────────────────────────────────────────────────────
# 2. Verify the source files we're about to copy actually exist
# ───────────────────────────────────────────────────────────────
REQUIRED_SOURCES=(server.js telegram-bot.js tempo-cli.js public/index.html)
OPTIONAL_SOURCES=(.env.example LICENSE CHANGELOG.md README.md GUIDE.md
                  proxy.js tempo-login.js test.js sim.js)
for f in "${REQUIRED_SOURCES[@]}"; do
    if [ ! -f "$SCRIPT_DIR/$f" ]; then
        log_error "Missing source file: $SCRIPT_DIR/$f"
        log_error "Run this installer from inside the tempo-terminal repo."
        exit 1
    fi
done
log_ok "Source files present"

# ───────────────────────────────────────────────────────────────
# 3. Refuse self-clobbering install
# ───────────────────────────────────────────────────────────────
# If the user cloned the repo directly into $INSTALL_DIR (e.g. they put it at
# ~/tempo-terminal because that matches the repo name), the rm -rf below
# would wipe our own sources before we copy them. Detect via realpath and
# bail with an actionable error instead of nuking their files.
RESOLVED_SCRIPT_DIR=$(cd "$SCRIPT_DIR" && pwd -P)
RESOLVED_INSTALL_DIR=$(cd "$(dirname "$INSTALL_DIR")" 2>/dev/null && pwd -P)/$(basename "$INSTALL_DIR")
if [ "$RESOLVED_SCRIPT_DIR" = "$RESOLVED_INSTALL_DIR" ]; then
    log_error "Source folder and install target are the same: $INSTALL_DIR"
    log_error "This would erase the project sources. Move the source elsewhere first."
    log_info  "Easiest fix:"
    log_info  "  cd /tmp && git clone https://github.com/supc0de/tempo-terminal.git"
    log_info  "  cd tempo-terminal && bash install.sh"
    exit 1
fi

# ───────────────────────────────────────────────────────────────
# 4. Existing installation: confirm + back up
# ───────────────────────────────────────────────────────────────
BACKUP_ENV=""
BACKUP_STATE=""
BACKUP_SPENDING=""
if [ -d "$INSTALL_DIR" ]; then
    log_warn "Existing installation at $INSTALL_DIR"
    if [ -t 0 ]; then
        read -rp "Overwrite? (.env / state / spending will be preserved) [y/N]: " overwrite
    else
        overwrite="y"
    fi
    if [[ ! "$overwrite" =~ ^[Yy]$ ]]; then
        log_info "Aborted."
        exit 0
    fi
    [ -f "$INSTALL_DIR/.env" ]            && BACKUP_ENV=$(cat "$INSTALL_DIR/.env")
    [ -f "$INSTALL_DIR/bot-state.json" ]  && BACKUP_STATE=$(cat "$INSTALL_DIR/bot-state.json")
    [ -f "$INSTALL_DIR/spending.csv" ]    && BACKUP_SPENDING=$(cat "$INSTALL_DIR/spending.csv")
    rm -rf "$INSTALL_DIR"
    log_ok "Cleaned old install"
fi

# ───────────────────────────────────────────────────────────────
# 4. Dependencies
# ───────────────────────────────────────────────────────────────
log_step "Installing dependencies"

has_cmd() { command -v "$1" >/dev/null 2>&1; }

if [ "$OS" = "macos" ] && ! has_cmd brew; then
    log_warn "Installing Homebrew..."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
fi

# Refresh apt index ONCE before any apt-get install. WSL Ubuntu images ship
# with stale package lists — without this refresh, `apt-get install` will hit
# 404s when the cached version no longer exists upstream (security pocket
# rolls over weekly). nodesource's setup script already runs `apt-get update`
# but only after we'd already need jq, so do it up front for the whole step.
if [ "$OS" != "macos" ] && (! has_cmd node || ! has_cmd jq); then
    sudo apt-get update -qq || log_warn "apt-get update returned non-zero; continuing anyway"
fi

if ! has_cmd node || [ "$(node -v | sed 's/v//' | cut -d. -f1)" -lt 18 ]; then
    log_warn "Installing Node.js 20 LTS..."
    if [ "$OS" = "macos" ]; then
        brew install node@20 2>/dev/null || brew install node
    else
        curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
        sudo apt-get install -y nodejs
    fi
fi
log_ok "Node.js $(node --version)"

# jq is a convenience for piping `tempo wallet whoami` etc., not a hard
# dependency for the bot itself. If apt is stuck on a stale index we still
# want the install to complete — warn instead of failing the whole script.
if ! has_cmd jq; then
    if [ "$OS" = "macos" ]; then
        brew install jq || log_warn "jq install failed (optional)"
    else
        sudo apt-get install -y jq || log_warn "jq install failed (optional — bot does not need it)"
    fi
fi
has_cmd jq && log_ok "jq ready" || log_warn "jq missing (skipped — non-fatal)"

# ───────────────────────────────────────────────────────────────
# 5. Tempo CLI
# ───────────────────────────────────────────────────────────────
if ! has_cmd tempo; then
    log_warn "Installing Tempo CLI..."
    curl -fsSL https://tempo.xyz/install | bash
    export PATH="$HOME/.tempo/bin:$PATH"
    SHELL_CONFIG="$HOME/.bashrc"
    [ "$OS" = "macos" ] && SHELL_CONFIG="$HOME/.zshrc"
    if ! grep -q "tempo/bin" "$SHELL_CONFIG" 2>/dev/null; then
        printf '\n# Tempo CLI\nexport PATH="$HOME/.tempo/bin:$PATH"\n' >> "$SHELL_CONFIG"
    fi
fi
log_ok "Tempo CLI: $(tempo --version 2>&1 | head -1)"

# ───────────────────────────────────────────────────────────────
# 6. Create project & copy sources
# ───────────────────────────────────────────────────────────────
log_step "Creating project at $INSTALL_DIR"

mkdir -p "$INSTALL_DIR/public"

cp "$SCRIPT_DIR/server.js"          "$INSTALL_DIR/server.js"
cp "$SCRIPT_DIR/telegram-bot.js"    "$INSTALL_DIR/telegram-bot.js"
cp "$SCRIPT_DIR/tempo-cli.js"       "$INSTALL_DIR/tempo-cli.js"
cp "$SCRIPT_DIR/public/index.html"  "$INSTALL_DIR/public/index.html"
[ -f "$SCRIPT_DIR/package.json" ] && cp "$SCRIPT_DIR/package.json" "$INSTALL_DIR/package.json"

# Helper / dev / docs files — copy whichever happens to be in the repo.
for f in "${OPTIONAL_SOURCES[@]}"; do
    if [ -f "$SCRIPT_DIR/$f" ]; then
        mkdir -p "$INSTALL_DIR/$(dirname "$f")"
        cp "$SCRIPT_DIR/$f" "$INSTALL_DIR/$f"
    fi
done
log_ok "Sources copied"

# Restore preserved data
[ -n "$BACKUP_ENV" ]      && { printf '%s\n' "$BACKUP_ENV"      > "$INSTALL_DIR/.env";            log_ok "Restored .env"; }
[ -n "$BACKUP_STATE" ]    && { printf '%s\n' "$BACKUP_STATE"    > "$INSTALL_DIR/bot-state.json"; log_ok "Restored state"; }
[ -n "$BACKUP_SPENDING" ] && { printf '%s\n' "$BACKUP_SPENDING" > "$INSTALL_DIR/spending.csv";   log_ok "Restored spending"; }

cd "$INSTALL_DIR"

# Fallback package.json (only if not provided alongside script)
if [ ! -f package.json ]; then
cat > package.json <<'PACKAGE_END'
{
  "name": "tempo-terminal",
  "version": "3.1.0",
  "description": "Local AI assistant with pay-as-you-go billing via Tempo wallet",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "telegram": "node telegram-bot.js"
  },
  "author": "Sup Cartel (discord.gg/supc)",
  "license": "MIT",
  "dependencies": {
    "express": "^4.18.0",
    "node-telegram-bot-api": "^0.67.0"
  },
  "engines": { "node": ">=18.0.0" },
  "overrides": {
    "form-data": "^4.0.0",
    "qs": "^6.14.1",
    "tough-cookie": "^5.1.2"
  }
}
PACKAGE_END
fi

# Default .env (only if not restored). Prefer the documented .env.example
# template if it shipped with the repo; otherwise emit a minimal fallback.
if [ ! -f .env ]; then
    if [ -f .env.example ]; then
        cp .env.example .env
        log_ok ".env seeded from .env.example"
    else
cat > .env <<'ENV_END'
# Tempo Terminal · local config

MAX_DAILY_SPEND=3.0
LLM_MODEL=openai/gpt-4o-mini
PORT=3000

TELEGRAM_BOT_TOKEN=
ALLOWED_USERS=

CONFIRM_THRESHOLD=0.05
LOW_BALANCE_WARN=5.0
LOW_BALANCE_CRITICAL=1.0
CONTEXT_WINDOW=6
RATE_LIMIT_SEC=2.0
RATE_LIMIT_MIN=20
TTS_VOICE=rachel
ENV_END
    fi
fi

cat > .gitignore <<'GIT_END'
node_modules/
.env
bot-state.json
spending.csv
spending.*.csv
*.log
.DS_Store
GIT_END

cat > start.sh <<'START_END'
#!/usr/bin/env bash
cd "$(dirname "$0")"
export PATH="$HOME/.tempo/bin:$PATH"
echo "Tempo Terminal · Web UI"
echo "  http://localhost:3000"
echo
node server.js
START_END
chmod +x start.sh

cat > start-telegram.sh <<'STARTTG_END'
#!/usr/bin/env bash
cd "$(dirname "$0")"
export PATH="$HOME/.tempo/bin:$PATH"
echo "Tempo Terminal · Telegram (polling)"
echo
node telegram-bot.js
STARTTG_END
chmod +x start-telegram.sh

log_ok "Project files written"

# ───────────────────────────────────────────────────────────────
# 7. npm install
# ───────────────────────────────────────────────────────────────
log_step "Installing npm dependencies"
npm install --silent 2>/dev/null || npm install
log_ok "Dependencies installed"

# ───────────────────────────────────────────────────────────────
# 8. Wallet check
# ───────────────────────────────────────────────────────────────
log_step "Checking wallet"
if tempo wallet whoami >/dev/null 2>&1; then
    log_ok "Wallet already logged in"
else
    log_warn "Wallet not logged in yet — run 'tempo wallet login' below"
fi

# ───────────────────────────────────────────────────────────────
# 9. Final instructions
# ───────────────────────────────────────────────────────────────
cat <<FINAL_END

${GREEN}${BOLD}
╔══════════════════════════════════════════════════════╗
║                                                      ║
║           ✅  INSTALLATION COMPLETE                   ║
║                                                      ║
╚══════════════════════════════════════════════════════╝
${NC}

${BOLD}Installed to:${NC} $INSTALL_DIR

${YELLOW}${BOLD}Next steps:${NC}

  ${BOLD}1.${NC} Login to Tempo wallet (single command — creates account too):
       ${BLUE}tempo wallet login${NC}

  ${BOLD}2.${NC} Verify:
       ${BLUE}tempo wallet -t whoami${NC}

  ${BOLD}3.${NC} Fund your wallet (recommended: \$10-40 USDC via Base):
       ${BLUE}tempo wallet fund${NC}

  ${BOLD}4.${NC} Start Web UI:
       ${BLUE}cd $INSTALL_DIR && ./start.sh${NC}
       Then open: ${BOLD}http://localhost:3000${NC}

${YELLOW}${BOLD}Telegram bot (optional):${NC}

  ${BOLD}1.${NC} Create bot via @BotFather → copy token
  ${BOLD}2.${NC} Get your ID from @userinfobot
  ${BOLD}3.${NC} Edit ${BLUE}$INSTALL_DIR/.env${NC}:
        TELEGRAM_BOT_TOKEN=<your token>
        ALLOWED_USERS=<your id>
  ${BOLD}4.${NC} Start: ${BLUE}./start-telegram.sh${NC}

${DIM}──────────────────────────────────────────────────${NC}
${DIM}Built by Sup Cartel · discord.gg/supc${NC}

FINAL_END
