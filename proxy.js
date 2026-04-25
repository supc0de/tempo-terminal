/**
 * Tempo Terminal · Optional Windows-host HTTP/CONNECT proxy
 * ─────────────────────────────────────────────────────────
 * For setups where Tempo CLI runs in WSL but you only have a VPN on the
 * Windows host: run this on the host, then export ALL_PROXY inside WSL to
 * route Tempo's outbound HTTPS through the host's network stack.
 *
 *   node proxy.js                          # binds 127.0.0.1:8888
 *   PROXY_PORT=8000 PROXY_HOST=0.0.0.0 …   # override
 *
 * Default 127.0.0.1 keeps the proxy local; binding to a public interface is
 * loud-warned because it lets anyone on your LAN tunnel through your machine.
 */

'use strict';

const net = require('net');
const http = require('http');

const PORT = parseInt(process.env.PROXY_PORT || '8888', 10);
const HOST = process.env.PROXY_HOST || '127.0.0.1';

const server = http.createServer((req, res) => {
    let url;
    try { url = new URL(req.url); }
    catch {
        res.statusCode = 400;
        return res.end('Forward proxy expects an absolute URL');
    }
    if (url.protocol !== 'http:') {
        res.statusCode = 400;
        return res.end('Only http:// is supported on the request path; use CONNECT for https');
    }

    const opts = {
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname + url.search,
        method: req.method,
        headers: req.headers,
    };
    const proxy = http.request(opts, (pRes) => {
        res.writeHead(pRes.statusCode, pRes.headers);
        pRes.pipe(res);
    });
    req.pipe(proxy);
    proxy.on('error', () => { try { res.end(); } catch {} });
    req.on('error', () => { try { proxy.destroy(); } catch {} });
});

server.on('connect', (req, clientSocket, head) => {
    const [host, portStr] = req.url.split(':');
    const port = Number(portStr);
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
        clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
        return;
    }
    const target = net.connect(port, host, () => {
        clientSocket.write('HTTP/1.1 200 OK\r\n\r\n');
        if (head && head.length) target.write(head);
        target.pipe(clientSocket);
        clientSocket.pipe(target);
    });
    target.on('error', () => clientSocket.end());
    clientSocket.on('error', () => target.destroy());
});

server.listen(PORT, HOST, () => {
    console.log(`Proxy ready on ${HOST}:${PORT}`);
    if (HOST === '0.0.0.0' || HOST === '::') {
        console.log('⚠ Bound to a public interface — anyone on this network can proxy through you.');
    }
    console.log('From WSL run:');
    console.log(`  export ALL_PROXY=http://$(hostname -I | awk "{print \\$1}"):${PORT}`);
    console.log('  tempo wallet login');
});
