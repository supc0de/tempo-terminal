# =====================================================
#  TEMPO TERMINAL - Windows Installer v3.1.0 (native)
#  Built by Sup Cartel - discord.gg/supc
#
#  One-shot installer:
#    - Installs Node.js 20 natively on Windows (winget)
#    - Copies the bot to %USERPROFILE%\tempo-terminal
#    - Runs npm install
#    - Auto-installs Tempo CLI inside WSL (used only for wallet)
#
#  Run from inside the repo:
#    powershell -ExecutionPolicy Bypass -File install.ps1
# =====================================================

#Requires -Version 5.1
$ErrorActionPreference = 'Stop'

function Write-Info { param($m) Write-Host "[INFO] $m" -ForegroundColor Cyan }
function Write-Ok   { param($m) Write-Host "[ OK ] $m" -ForegroundColor Green }
function Write-Warn { param($m) Write-Host "[WARN] $m" -ForegroundColor Yellow }
function Write-Err  { param($m) Write-Host "[FAIL] $m" -ForegroundColor Red }

Clear-Host

Write-Host ""
Write-Host "=======================================================" -ForegroundColor Cyan
Write-Host "  TEMPO TERMINAL - Windows Installer v3.1.0 (native)"   -ForegroundColor Cyan
Write-Host "  Built by Sup Cartel - discord.gg/supc"                -ForegroundColor Cyan
Write-Host "=======================================================" -ForegroundColor Cyan
Write-Host ""

# -------------------------------------------------
#  1. Windows version check
# -------------------------------------------------
$build = [int](Get-CimInstance Win32_OperatingSystem).BuildNumber
if ($build -lt 19041) {
    Write-Err "Windows 10 build 19041+ or Windows 11 required"
    Write-Info "Your build: $build"
    Read-Host "Press Enter to exit"
    exit 1
}
Write-Ok "Windows build $build"

# -------------------------------------------------
#  2. Locate source files
# -------------------------------------------------
if ($MyInvocation.MyCommand.Path) {
    $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
} else {
    $scriptDir = (Get-Location).Path
}

$requiredFiles = @('server.js', 'telegram-bot.js', 'tempo-cli.js')
$requiredChecks = $requiredFiles + @('public\index.html')
$optionalFiles = @('.env.example', 'LICENSE', 'CHANGELOG.md', 'README.md', 'GUIDE.md',
                   'package.json', 'package-lock.json',
                   'proxy.js', 'tempo-login.js', 'test.js', 'sim.js')
foreach ($f in $requiredChecks) {
    $fpath = Join-Path $scriptDir $f
    if (-not (Test-Path $fpath)) {
        Write-Err "$f not found at $scriptDir"
        Write-Info "All project files must be in the same folder as install.ps1"
        Read-Host "Press Enter to exit"
        exit 1
    }
}
Write-Ok "Source files found"

# -------------------------------------------------
#  3. Install Node.js (native Windows)
# -------------------------------------------------
$hasNode = $null -ne (Get-Command node -ErrorAction SilentlyContinue)
$nodeOk = $false

if ($hasNode) {
    try {
        $nodeVer = (node -v 2>$null) -replace 'v', ''
        $major = [int]($nodeVer.Split('.')[0])
        if ($major -ge 18) { $nodeOk = $true }
    } catch {}
}

if ($nodeOk) {
    Write-Ok "Node.js v$nodeVer already installed"
} else {
    Write-Info "Installing Node.js 20 LTS..."

    $hasWinget = $null -ne (Get-Command winget -ErrorAction SilentlyContinue)
    if ($hasWinget) {
        try {
            & winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements --silent 2>$null | Out-Null
            Write-Ok "Node.js installed via winget"
            # Refresh PATH
            $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH", "User")
        } catch {
            Write-Warn "winget install failed, trying direct download..."
            $hasWinget = $false
        }
    }

    if (-not $hasWinget) {
        Write-Err "Could not install Node.js automatically"
        Write-Info ""
        Write-Info "Please install Node.js 20 LTS manually:"
        Write-Info "  https://nodejs.org/en/download/"
        Write-Info ""
        Write-Info "After installing, re-run install.ps1"
        Read-Host "Press Enter to exit"
        exit 1
    }

    # Verify
    $hasNode = $null -ne (Get-Command node -ErrorAction SilentlyContinue)
    if (-not $hasNode) {
        Write-Warn "Node.js installed but not in PATH yet"
        Write-Info "Close this window, open a NEW PowerShell, and re-run install.ps1"
        Read-Host "Press Enter to exit"
        exit 1
    }
    Write-Ok "Node.js $(node -v)"
}

# -------------------------------------------------
#  4. Create project directory
# -------------------------------------------------
$installDir = Join-Path $env:USERPROFILE "tempo-terminal"

Write-Info "Installing to: $installDir"

$backupEnv = $null
$backupState = $null
$backupSpending = $null

if (Test-Path $installDir) {
    Write-Warn "Existing installation found"

    $envFile = Join-Path $installDir ".env"
    $stateFile = Join-Path $installDir "bot-state.json"
    $spendingFile = Join-Path $installDir "spending.csv"

    if (Test-Path $envFile) { $backupEnv = Get-Content $envFile -Raw }
    if (Test-Path $stateFile) { $backupState = Get-Content $stateFile -Raw }
    if (Test-Path $spendingFile) { $backupSpending = Get-Content $spendingFile -Raw }
}

New-Item -ItemType Directory -Force -Path $installDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $installDir "public") | Out-Null

# -------------------------------------------------
#  5. Copy project files
# -------------------------------------------------
Write-Info "Copying project files..."

# Required prod sources
foreach ($f in $requiredFiles) {
    Copy-Item (Join-Path $scriptDir $f) (Join-Path $installDir $f) -Force
}

# Optional helpers, docs, dev tools -- copy whichever happens to be in the repo.
foreach ($f in $optionalFiles) {
    $src = Join-Path $scriptDir $f
    if (Test-Path $src) {
        Copy-Item $src (Join-Path $installDir $f) -Force
    }
}

# Copy public/ directory
$publicSrc = Join-Path $scriptDir "public"
if (Test-Path $publicSrc) {
    Copy-Item "$publicSrc\*" (Join-Path $installDir "public") -Recurse -Force
}

Write-Ok "Project files copied"

# -------------------------------------------------
#  6. package.json & .env
# -------------------------------------------------
# Prefer the package.json shipped in the repo (already copied above as part
# of $optionalFiles); only synthesize a fallback if it's missing.
$pkgPath = Join-Path $installDir "package.json"
if (-not (Test-Path $pkgPath)) {
    $packageJson = @'
{
  "name": "tempo-terminal",
  "version": "3.1.0",
  "description": "Local AI assistant with pay-as-you-go billing via Tempo wallet",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "telegram": "node telegram-bot.js",
    "test": "node test.js",
    "sim": "node sim.js"
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
'@
    $packageJson | Out-File -FilePath $pkgPath -Encoding utf8
    Write-Ok "package.json fallback created"
}

# Restore or create .env. Prefer seeding from the documented .env.example
# template; minimal fallback only if neither restored backup nor template
# is available.
$envPath = Join-Path $installDir ".env"
$envExamplePath = Join-Path $installDir ".env.example"
if ($backupEnv) {
    $backupEnv | Out-File -FilePath $envPath -Encoding utf8 -NoNewline
    Write-Ok "Restored .env"
} elseif (-not (Test-Path $envPath)) {
    if (Test-Path $envExamplePath) {
        Copy-Item $envExamplePath $envPath -Force
        Write-Ok ".env seeded from .env.example"
    } else {
        $defaultEnv = @'
# Tempo Terminal - local config

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
'@
        $defaultEnv | Out-File -FilePath $envPath -Encoding utf8
        Write-Ok "Default .env created"
    }
}

# Restore state & spending
if ($backupState) {
    $backupState | Out-File -FilePath (Join-Path $installDir "bot-state.json") -Encoding utf8 -NoNewline
    Write-Ok "Restored bot-state.json"
}
if ($backupSpending) {
    $backupSpending | Out-File -FilePath (Join-Path $installDir "spending.csv") -Encoding utf8 -NoNewline
    Write-Ok "Restored spending.csv"
}

# -------------------------------------------------
#  7. npm install
# -------------------------------------------------
Write-Info "Installing npm dependencies..."
Push-Location $installDir
$prevEAP = $ErrorActionPreference
$ErrorActionPreference = 'SilentlyContinue'
& npm install --omit=dev 2>$null | Out-Null
$npmExit = $LASTEXITCODE
$ErrorActionPreference = $prevEAP
if ($npmExit -eq 0) {
    Write-Ok "npm dependencies installed"
} else {
    Write-Err "npm install failed (exit code $npmExit)"
    Write-Info "Try running manually: cd $installDir && npm install"
}
Pop-Location

# -------------------------------------------------
#  8. Check WSL for Tempo CLI
# -------------------------------------------------
$hasWsl = $null -ne (Get-Command wsl.exe -ErrorAction SilentlyContinue)
$tempoReady = $false

if ($hasWsl) {
    # Find a working distro
    $candidateDistros = @('Ubuntu', 'Ubuntu-24.04', 'Ubuntu-22.04', 'Ubuntu-20.04', 'Debian')
    $workingDistro = $null

    foreach ($name in $candidateDistros) {
        $result = (& wsl -d $name -e bash -c "echo DETECT_OK" 2>$null | Out-String).Trim()
        if ($result -match "DETECT_OK") {
            $workingDistro = $name
            break
        }
    }

    if (-not $workingDistro) {
        $result = (& wsl -e bash -c "echo DETECT_OK" 2>$null | Out-String).Trim()
        if ($result -match "DETECT_OK") {
            $workingDistro = "__DEFAULT__"
        }
    }

    if ($workingDistro) {
        # Check if tempo is installed in WSL
        if ($workingDistro -eq "__DEFAULT__") {
            $tempoCheck = (& wsl -e bash -lc "command -v tempo && echo TEMPO_FOUND" 2>$null | Out-String)
        } else {
            $tempoCheck = (& wsl -d $workingDistro -e bash -lc "command -v tempo && echo TEMPO_FOUND" 2>$null | Out-String)
        }
        if ($tempoCheck -match "TEMPO_FOUND") {
            $tempoReady = $true
            Write-Ok "Tempo CLI found in WSL"
        } else {
            Write-Info "Installing Tempo CLI in WSL..."
            try {
                if ($workingDistro -eq "__DEFAULT__") {
                    & wsl -e bash -c "curl -fsSL https://tempo.xyz/install | bash"
                } else {
                    & wsl -d $workingDistro -e bash -c "curl -fsSL https://tempo.xyz/install | bash"
                }
                $tempoReady = $true
                Write-Ok "Tempo CLI installed in WSL -- run 'tempo wallet login' to authenticate"
            } catch {
                Write-Warn "Could not install Tempo CLI: $_"
            }
        }
    } else {
        Write-Warn "WSL installed but no working distro found"
    }
} else {
    Write-Warn "WSL not installed - Tempo CLI unavailable"
}

if (-not $tempoReady) {
    Write-Host ""
    Write-Warn "Tempo CLI is not set up yet."
    Write-Info "The bot will start but wallet operations require Tempo CLI."
    Write-Info "To set up Tempo CLI later:"
    Write-Info "  1. Install WSL: wsl --install -d Ubuntu (requires admin + reboot)"
    Write-Info "  2. Open Ubuntu from Start menu, create a user"
    Write-Info "  3. Run: curl -L https://tempo.xyz/install | bash"
    Write-Info "  4. Run: tempo wallet login"
}

# -------------------------------------------------
#  9. Final summary
# -------------------------------------------------
Write-Host ""
Write-Host "=======================================================" -ForegroundColor Green
Write-Host "  INSTALLATION COMPLETE"                                 -ForegroundColor Green
Write-Host "=======================================================" -ForegroundColor Green
Write-Host ""
Write-Host "Bot folder: $installDir"                                  -ForegroundColor Cyan
if ($tempoReady) {
    Write-Host "Tempo CLI:  ready (via WSL)"                          -ForegroundColor Cyan
} else {
    Write-Host "Tempo CLI:  not configured (see instructions above)"  -ForegroundColor Yellow
}
Write-Host ""
Write-Host "Next steps:"                                              -ForegroundColor Yellow
if ($tempoReady) {
    Write-Host "  1. Open Ubuntu (WSL): tempo wallet login"
    Write-Host "  2. Fund wallet:       tempo wallet fund"
    Write-Host "  3. Start bot:         cd $installDir && node server.js"
} else {
    Write-Host "  1. Install WSL:  wsl --install -d Ubuntu  (admin PowerShell, then reboot)" -ForegroundColor Yellow
    Write-Host "  2. In Ubuntu:    curl -L https://tempo.xyz/install | bash"
    Write-Host "  3. Then:         tempo wallet login"
    Write-Host "  4. Fund wallet:  tempo wallet fund"
    Write-Host "  5. Start bot:    cd $installDir && node server.js"
}
Write-Host ""
Write-Host "Built by Sup Cartel - discord.gg/supc"                    -ForegroundColor DarkGray
Write-Host ""
Read-Host "Press Enter to exit"
