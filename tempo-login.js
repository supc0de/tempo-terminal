/**
 * Tempo Terminal · Optional Windows device-code login bypass
 * ──────────────────────────────────────────────────────────
 * Use this when `tempo wallet login` fails inside WSL because the WSL
 * environment can't reach Tempo (region block, no browser, etc.) but the
 * Windows host can. The script:
 *   1. Asks Tempo for a device code via the host's network stack.
 *   2. Opens the verification URL in the host browser.
 *   3. Polls for authorization.
 *   4. Writes the resulting credentials directly into the WSL
 *      `~/.tempo/wallet-auth.json` so the CLI inside WSL just works.
 *
 *   node tempo-login.js
 */

'use strict';

const https = require('https');
const { execSync, spawnSync } = require('child_process');

function httpsPost(url, body) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const data = Buffer.from(JSON.stringify(body), 'utf8');
        const req = https.request({
            hostname: u.hostname, port: 443, path: u.pathname + u.search,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': data.length }
        }, res => {
            res.setEncoding('utf8');
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => {
                if (res.statusCode >= 400) reject(new Error(`HTTP ${res.statusCode}: ${d}`));
                else {
                    try { resolve(JSON.parse(d)); }
                    catch (e) { reject(new Error(`Invalid JSON from ${url}: ${e.message}`)); }
                }
            });
        });
        req.on('error', reject);
        req.write(data);
        req.end();
    });
}

async function main() {
    console.log('\n  Tempo Wallet Login (Windows bypass)\n');

    // Step 1: request device code
    console.log('  Requesting device code...');
    let deviceData;
    try {
        deviceData = await httpsPost('https://wallet.tempo.xyz/cli-auth/device-code', {});
    } catch (e) {
        console.error('  Failed:', e.message);
        console.error('  Make sure your VPN is active.');
        process.exit(1);
    }

    const { device_code, user_code, verification_uri, verification_uri_complete, expires_in, interval } = deviceData;

    console.log(`\n  Open this URL in your browser:\n`);
    console.log(`    ${verification_uri_complete || verification_uri}`);
    if (user_code) console.log(`\n  Code: ${user_code}`);
    console.log(`\n  Waiting for authorization...`);

    // Try to open browser
    try {
        execSync(`start "" "${verification_uri_complete || verification_uri}"`, { stdio: 'ignore' });
    } catch {}

    // Step 2: poll for token
    const pollInterval = (interval || 5) * 1000;
    const deadline = Date.now() + (expires_in || 300) * 1000;

    while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, pollInterval));

        try {
            const tokenData = await httpsPost('https://wallet.tempo.xyz/cli-auth/token', { device_code });

            if (tokenData.access_token || tokenData.token) {
                console.log('\n  Authorized! Saving credentials to WSL...\n');

                const token = JSON.stringify(tokenData);

                // Resolve WSL $HOME path without shell interpolation risk.
                const homeRes = spawnSync('wsl', ['-e', 'bash', '-lc', 'printf %s "$HOME"'], { encoding: 'utf8' });
                if (homeRes.status !== 0) {
                    console.error('  Could not resolve WSL $HOME:', homeRes.stderr);
                    process.exit(1);
                }
                const wslHome = homeRes.stdout.trim();
                const configDir = `${wslHome}/.tempo`;

                // Feed token via stdin — avoids quoting issues with JSON chars
                // like " and $ that break heredoc-in-string approaches.
                const saveRes = spawnSync(
                    'wsl',
                    ['-e', 'bash', '-lc', `mkdir -p "${configDir}" && cat > "${configDir}/wallet-auth.json"`],
                    { input: token, stdio: ['pipe', 'inherit', 'inherit'] }
                );
                if (saveRes.status !== 0) {
                    console.error('  Failed to save credentials to WSL.');
                    process.exit(1);
                }

                console.log('  Saved! Now test in WSL:');
                console.log('    wsl -e bash -lc "tempo wallet whoami"');
                console.log('');
                process.exit(0);
            }
        } catch (e) {
            const msg = e.message.toLowerCase();
            if (msg.includes('authorization_pending') || msg.includes('slow_down') || msg.includes('pending')) {
                process.stdout.write('.');
                continue;
            }
            if (msg.includes('expired')) {
                console.error('\n  Code expired. Run again.');
                process.exit(1);
            }
            // Unknown error, keep polling
            process.stdout.write('.');
        }
    }

    console.error('\n  Timeout. Run again.');
    process.exit(1);
}

main();
