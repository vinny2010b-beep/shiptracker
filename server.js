const express = require('express');
const { createServer } = require('http');
const { WebSocket, WebSocketServer } = require('ws');
const path = require('path');

const API_KEY = process.env.AISSTREAM_API_KEY || '88725b94e9703f7de49e8f993b2427ef400bb3a0';
const PORT    = process.env.PORT || 3000;

const app    = express();
const server = createServer(app);
const wss    = new WebSocketServer({ server, path: '/ws' });

app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => {
  const test = new WebSocket('wss://stream.aisstream.io/v0/stream');
  let done = false;
  const finish = (result) => { if (!done) { done = true; test.terminate(); res.json(result); } };
  setTimeout(() => finish({ server: 'ok', aisstream: 'timeout_8s' }), 8000);
  test.on('open', () => {
    test.send(JSON.stringify({ APIKey: API_KEY, BoundingBoxes: [[[-90,-180],[90,180]]], FilterMessageTypes: ['PositionReport'] }));
    finish({ server: 'ok', aisstream: 'connected_and_subscribed' });
  });
  test.on('message', () => finish({ server: 'ok', aisstream: 'DATA_FLOWING' }));
  test.on('error', (e) => finish({ server: 'ok', aisstream: 'error: ' + e.message }));
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

wss.on('connection', (browser) => {
  console.log('[proxy] browser connected');

  let upstream = null;
  let lastSub  = null;
  let retryMs  = 2000;
  let alive    = true;

  function connectUpstream() {
    if (!alive) return;
    console.log('[proxy] connecting to aisstream.io...');
    send(browser, { _status: 'upstream_connecting' });

    upstream = new WebSocket('wss://stream.aisstream.io/v0/stream');

    upstream.on('open', () => {
      console.log('[proxy] upstream open');
      retryMs = 2000; // reset backoff
      send(browser, { _status: 'upstream_connected' });
      if (lastSub) {
        upstream.send(lastSub);
        console.log('[proxy] subscription sent');
      }
    });

    upstream.on('message', (data, isBinary) => {
      if (browser.readyState === WebSocket.OPEN) {
        browser.send(isBinary ? data : data.toString());
      }
    });

    upstream.on('close', (code, reason) => {
      console.log('[proxy] upstream closed', code, reason.toString());
      send(browser, { _status: 'upstream_reconnecting', code });
      // Reconnect upstream — don't kill browser connection
      if (alive) {
        retryMs = Math.min(retryMs * 2, 30000); // exponential backoff up to 30s
        setTimeout(connectUpstream, retryMs);
      }
    });

    upstream.on('error', (err) => {
      console.error('[proxy] upstream error:', err.message);
      send(browser, { _status: 'upstream_error', msg: err.message });
    });
  }

  browser.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      msg.APIKey = API_KEY;
      msg.Apikey = API_KEY;
      lastSub = JSON.stringify(msg); // save for reconnects
      if (upstream && upstream.readyState === WebSocket.OPEN) {
        upstream.send(lastSub);
        console.log('[proxy] subscription forwarded');
      }
    } catch (e) {
      console.error('[proxy] bad message:', e.message);
    }
  });

  browser.on('close', () => {
    console.log('[proxy] browser disconnected');
    alive = false;
    if (upstream) upstream.terminate();
  });

  connectUpstream();
});

server.listen(PORT, () => console.log(`Ship tracker on http://localhost:${PORT}`));
