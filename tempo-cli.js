/**
 * Cross-platform Tempo CLI wrapper
 *
 * Uses execFile (not exec) to pass arguments as an array,
 * bypassing shell interpretation entirely. Works on Windows,
 * macOS, and Linux without any quoting or escaping.
 *
 * On Windows, if native tempo binary is not found, transparently
 * falls back to WSL: execFile('wsl', ['tempo', ...args]).
 *
 * Built by Sup Cartel - discord.gg/supc
 */

'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');
const path = require('path');

const execFileAsync = promisify(execFile);

let _resolved = null; // { binary: string, useWsl: boolean }

/**
 * Probe whether a binary is callable.
 * Returns true if it exits (any status) without ENOENT/EACCES/timeout.
 * Treating timeouts as "exists" would cache a hung binary as the resolved
 * tempo path, so we explicitly return false on SIGTERM.
 */
async function probe(bin, args) {
    try {
        await execFileAsync(bin, args, { timeout: 8000, windowsHide: true });
        return true;
    } catch (err) {
        if (err.code === 'ENOENT' || err.code === 'EACCES') return false;
        // Node sets `killed` + signal when the timeout kills the process.
        if (err.killed || err.signal) return false;
        // Command ran and exited non-zero — still means the binary exists.
        return true;
    }
}

/**
 * Find the tempo binary. Result is cached after first successful probe.
 *
 * Resolution order:
 *   1. 'tempo' in PATH (works on any OS if installed globally)
 *   2. Windows: %USERPROFILE%\.tempo\bin\tempo.exe
 *   3. Windows: 'wsl tempo' (transparent WSL bridge)
 */
async function findTempo() {
    if (_resolved) return _resolved;

    // 1. Check PATH
    if (await probe('tempo', ['--version'])) {
        _resolved = { binary: 'tempo', useWsl: false };
        return _resolved;
    }

    // 2. Windows-specific locations
    if (process.platform === 'win32') {
        const home = process.env.USERPROFILE || process.env.HOME || '';
        const candidates = [
            path.join(home, '.tempo', 'bin', 'tempo.exe'),
            path.join(home, '.tempo', 'bin', 'tempo'),
        ];
        for (const p of candidates) {
            if (await probe(p, ['--version'])) {
                _resolved = { binary: p, useWsl: false };
                return _resolved;
            }
        }

        // 3. WSL fallback
        if (await probe('wsl', ['tempo', '--version'])) {
            _resolved = { binary: 'wsl', useWsl: true };
            return _resolved;
        }
    }

    throw new Error(
        'Tempo CLI not found.\n' +
        '  macOS/Linux: curl -L https://tempo.xyz/install | bash\n' +
        '  Windows:     install Tempo CLI in WSL (see GUIDE.md)'
    );
}

/**
 * Run a tempo CLI command.
 *
 * @param {string[]} args    e.g. ['request', '-X', 'POST', '--json', json, url]
 * @param {object}   [opts]
 * @param {number}   [opts.timeout]    ms, default 120 000
 * @param {number}   [opts.maxBuffer]  bytes, default 20 MB
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
async function runTempo(args, opts = {}) {
    const { binary, useWsl } = await findTempo();
    const timeout   = opts.timeout   ?? 120000;
    const maxBuffer = opts.maxBuffer ?? 20 * 1024 * 1024;

    const bin  = binary;
    const argv = useWsl ? ['tempo', ...args] : args;

    return execFileAsync(bin, argv, { timeout, maxBuffer, windowsHide: true });
}

module.exports = { findTempo, runTempo };
