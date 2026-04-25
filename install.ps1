# =====================================================
#  TEMPO TERMINAL - Windows Installer v3.1.0 (native)
#  Built by Sup Cartel - discord.gg/supc
#
#  One-shot installer:
#    - Installs Node.js 20 natively on Windows (winget)
#    - Copies the bot to %USERPROFILE%\tempo-bot
#    - Runs npm install
#    - Auto-installs Tempo CLI inside WSL (used only for wallet)
#    - Drops Desktop launchers: start.bat, start-telegram.bat, wallet.bat
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
$optionalFiles = @('.env.example', 'LICENSE', 'CHANGELOG.md', 'README.md', 'GUIDE.md',
                   'package.json', 'package-lock.json',
                   'proxy.js', 'tempo-login.js', 'test.js', 'sim.js')
foreach ($f in $requiredFiles) {
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
    Write-Ok "Node.js $(node -v) already installed"
} else {
    Write-Info "Installing Node.js 20 LTS..."

    $hasWinget = $null -ne (Get-Command winget -ErrorAction SilentlyContinue)
    if ($hasWinget) {
        try {
            & winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements --silent 2>$null
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
$installDir = Join-Path $env:USERPROFILE "tempo-bot"

Write-Info "Installing to: $installDir"

if (Test-Path $installDir) {
    Write-Warn "Existing installation found"
    # Preserve user data
    $backupEnv = $null
    $backupState = $null
    $backupSpending = $null

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

# Optional helpers, docs, dev tools — copy whichever happens to be in the repo.
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
try {
    & npm install --production 2>&1 | Out-Null
    Write-Ok "npm dependencies installed"
} catch {
    Write-Err "npm install failed: $_"
    Write-Info "Try running manually: cd $installDir && npm install"
}
Pop-Location

# -------------------------------------------------
#  8. Check WSL for Tempo CLI
# -------------------------------------------------
$hasWsl = $null -ne (Get-Command wsl.exe -ErrorAction SilentlyContinue)
$tempoReady = $false
$distroFlag = ""

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
        if ($workingDistro -ne "__DEFAULT__") {
            $distroFlag = "-d $workingDistro "
        }

        # Check if tempo is installed in WSL
        $tempoCheck = (& wsl $distroFlag.Trim().Split(' ') -e bash -lc "command -v tempo && echo TEMPO_FOUND" 2>$null | Out-String)
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
                Write-Ok "Tempo CLI installed in WSL — run 'tempo wallet login' to authenticate"
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
#  9. Create Windows launchers on Desktop
# -------------------------------------------------
Write-Host ""
Write-Info "Creating Desktop launchers..."

$desktop = [Environment]::GetFolderPath("Desktop")
$launchDir = Join-Path $desktop "Tempo Bot"
New-Item -ItemType Directory -Force -Path $launchDir | Out-Null

$startBat = @"
@echo off
title Tempo Terminal - Web UI
chcp 65001 >nul 2>&1
echo.
echo =============================================
echo   TEMPO TERMINAL - Web UI
echo   Built by Sup Cartel - discord.gg/supc
echo =============================================
echo.
echo Opening browser in 3 seconds at http://localhost:3000
echo Press Ctrl+C to stop the bot.
echo.
start "" cmd /c "timeout /t 3 /nobreak >nul & start http://localhost:3000"
cd /d "$installDir"
node server.js
echo.
echo [Bot stopped]
pause
"@
$startBat | Out-File -FilePath (Join-Path $launchDir "start.bat") -Encoding ascii
Write-Ok "Created: start.bat"

$startTgBat = @"
@echo off
title Tempo Terminal - Telegram
chcp 65001 >nul 2>&1
echo.
echo =============================================
echo   TEMPO TERMINAL - Telegram
echo   Built by Sup Cartel - discord.gg/supc
echo =============================================
echo.
echo Configure TELEGRAM_BOT_TOKEN + ALLOWED_USERS in .env
echo Press Ctrl+C to stop.
echo.
cd /d "$installDir"
node telegram-bot.js
echo.
echo [Bot stopped]
pause
"@
$startTgBat | Out-File -FilePath (Join-Path $launchDir "start-telegram.bat") -Encoding ascii
Write-Ok "Created: start-telegram.bat"

# wallet.bat still uses WSL for tempo CLI operations
$wslDistroArg = if ($workingDistro -and $workingDistro -ne "__DEFAULT__") { "-d $workingDistro " } else { "" }
$walletBat = @"
@echo off
title Tempo Wallet Manager
chcp 65001 >nul 2>&1

where wsl >nul 2>nul
if errorlevel 1 (
    echo.
    echo Tempo wallet requires WSL with Tempo CLI installed.
    echo Install WSL: wsl --install (admin PowerShell, then reboot)
    echo Then: curl -L https://tempo.xyz/install ^| bash
    echo.
    pause
    exit /b 1
)

:menu
cls
echo.
echo =============================================
echo   TEMPO WALLET MANAGER
echo   Built by Sup Cartel - discord.gg/supc
echo =============================================
echo.
echo   1. Show wallet info
echo   2. Login
echo   3. Add funds
echo   4. Edit configuration (.env)
echo   5. View spending stats
echo   6. View recent logs
echo   7. Open bot folder
echo   8. Exit
echo.
set /p c="Choose [1-8]: "

if "%c%"=="1" (
    wsl ${wslDistroArg}-e bash -lc "export PATH=`$HOME/.tempo/bin:`$PATH && tempo wallet whoami"
    pause & goto menu
)
if "%c%"=="2" (
    wsl ${wslDistroArg}-e bash -lc "export PATH=`$HOME/.tempo/bin:`$PATH && tempo wallet login"
    pause & goto menu
)
if "%c%"=="3" (
    wsl ${wslDistroArg}-e bash -lc "export PATH=`$HOME/.tempo/bin:`$PATH && tempo wallet fund"
    pause & goto menu
)
if "%c%"=="4" (
    notepad "$installDir\.env"
    goto menu
)
if "%c%"=="5" (
    if exist "$installDir\spending.csv" (
        type "$installDir\spending.csv" | more
    ) else (
        echo No spending yet
    )
    pause & goto menu
)
if "%c%"=="6" (
    if exist "$installDir\bot.log" (
        type "$installDir\bot.log" | more
    ) else (
        echo No logs yet
    )
    pause & goto menu
)
if "%c%"=="7" (
    explorer "$installDir"
    goto menu
)
if "%c%"=="8" exit
goto menu
"@
$walletBat | Out-File -FilePath (Join-Path $launchDir "wallet.bat") -Encoding ascii
Write-Ok "Created: wallet.bat"

$readme = @"
TEMPO TERMINAL - Quick Start
=============================
Built by Sup Cartel - discord.gg/supc

Bot files: $installDir

BEFORE FIRST USE
----------------
1. Double-click wallet.bat
2. Choose 2 (Login) - opens browser for passkey via Windows Hello
3. Choose 3 (Add funds) - recommended: 30-40 USDC via Base

USE THE BOT
-----------
Web UI:     double-click start.bat (browser opens automatically)
Telegram:   double-click start-telegram.bat

TELEGRAM SETUP
--------------
1. Telegram: @BotFather -> /newbot -> copy token
2. Telegram: @userinfobot -> /start -> copy User ID
3. Open .env in bot folder and add:
     TELEGRAM_BOT_TOKEN=<token>
     ALLOWED_USERS=<your id>

Support: discord.gg/supc
"@
$readme | Out-File -FilePath (Join-Path $launchDir "README.txt") -Encoding utf8

Write-Ok "Launchers created: $launchDir"

# -------------------------------------------------
#  10. Final summary
# -------------------------------------------------
Write-Host ""
Write-Host "=======================================================" -ForegroundColor Green
Write-Host "  INSTALLATION COMPLETE"                                 -ForegroundColor Green
Write-Host "=======================================================" -ForegroundColor Green
Write-Host ""
Write-Host "Bot folder: $installDir"                                  -ForegroundColor Cyan
Write-Host "Desktop:    $launchDir"                                   -ForegroundColor Cyan
if ($tempoReady) {
    Write-Host "Tempo CLI:  ready (via WSL)"                          -ForegroundColor Cyan
} else {
    Write-Host "Tempo CLI:  not configured (see instructions above)"  -ForegroundColor Yellow
}
Write-Host ""
Write-Host "Next steps:"                                              -ForegroundColor Yellow
Write-Host "  1. Open 'Tempo Bot' folder on Desktop"
Write-Host "  2. Double-click wallet.bat -> choose 2 (login)"
Write-Host "  3. Same menu -> choose 3 (fund wallet)"
Write-Host "  4. Double-click start.bat -> Web UI opens"
Write-Host ""
Write-Host "Built by Sup Cartel - discord.gg/supc"                    -ForegroundColor DarkGray
Write-Host ""
Read-Host "Press Enter to exit"
