const express = require('express');
const { createServer } = require('http');
const { WebSocket, WebSocketServer } = require('ws');
const path = require('path');

const API_KEY = process.env.AISSTREAM_API_KEY || '88725b94e9703f7de49e8f993b2427ef400bb3a0';
const PORT    = process.env.PORT || 3000;

// Default subscription — whole world, all position types
const DEFAULT_SUB = JSON.stringify({
  APIKey:             API_KEY,
  Apikey:             API_KEY,
  BoundingBoxes:      [[[-90, -180], [90, 180]]],
  FilterMessageTypes: ['PositionReport', 'StandardClassBPositionReport', 'ExtendedClassBPositionReport', 'ShipStaticData']
});

const app    = express();
const server = createServer(app);
const wss    = new WebSocketServer({ server, path: '/ws' });

app.use(express.static(path.join(__dirname, 'public')));

// Health check — waits up to 10s for actual data
app.get('/health', (req, res) => {
  const test = new WebSocket('wss://stream.aisstream.io/v0/stream');
  let done = false;
  const finish = (result) => { if (!done) { done = true; try { test.terminate(); } catch(e){} res.json(result); } };
  const timeout = setTimeout(() => finish({ server: 'ok', aisstream: 'NO_DATA_IN_10S — possible rate limit' }), 10000);

  test.on('open', () => {
    console.log('[health] upstream open, sending subscription...');
    test.send(DEFAULT_SUB);
  });
  test.on('message', (data) => {
    clearTimeout(timeout);
    try {
      const msg = JSON.parse(data.toString());
      finish({ server: 'ok', aisstream: 'DATA_FLOWING', sample_type: msg.MessageType, mmsi: msg.MetaData && msg.MetaData.MMSI });
    } catch(e) {
      finish({ server: 'ok', aisstream: 'DATA_FLOWING_BUT_PARSE_ERROR' });
    }
  });
  test.on('error', (e) => { clearTimeout(timeout); finish({ server: 'ok', aisstream: 'ERROR: ' + e.message }); });
  test.on('close', (code) => { clearTimeout(timeout); finish({ server: 'ok', aisstream: 'CLOSED_CODE_' + code }); });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

function safeSend(ws, data) {
  try { if (ws.readyState === WebSocket.OPEN) ws.send(typeof data === 'string' ? data : JSON.stringify(data)); } catch(e){}
}

wss.on('connection', (browser) => {
  console.log('[proxy] browser connected');

  let upstream = null;
  let customSub = null; // custom subscription from browser (different region etc)
  let retryMs   = 2000;
  let alive     = true;

  function connectUpstream() {
    if (!alive) return;
    console.log('[proxy] connecting upstream...');
    safeSend(browser, { _status: 'upstream_connecting' });

    upstream = new WebSocket('wss://stream.aisstream.io/v0/stream');

    upstream.on('open', () => {
      console.log('[proxy] upstream open — sending subscription immediately');
      retryMs = 2000;
      // Send immediately — don't wait for browser
      const sub = customSub || DEFAULT_SUB;
      upstream.send(sub);
      console.log('[proxy] subscription sent:', sub.substring(0, 80));
      safeSend(browser, { _status: 'upstream_connected' });
    });

    upstream.on('message', (data, isBinary) => {
      browser.send(data.toString());
    });

    upstream.on('close', (code, reason) => {
      console.log('[proxy] upstream closed', code, reason.toString());
      safeSend(browser, { _status: 'upstream_reconnecting', code });
      if (alive) {
        retryMs = Math.min(retryMs * 2, 30000);
        console.log('[proxy] retrying in', retryMs, 'ms');
        setTimeout(connectUpstream, retryMs);
      }
    });

    upstream.on('error', (err) => {
      console.error('[proxy] upstream error:', err.message);
      safeSend(browser, { _status: 'upstream_error', msg: err.message });
    });
  }

  browser.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      // Browser sent a custom subscription (e.g. different region)
      msg.APIKey = API_KEY;
      msg.Apikey = API_KEY;
      customSub = JSON.stringify(msg);
      // If upstream is open, update subscription immediately
      if (upstream && upstream.readyState === WebSocket.OPEN) {
        upstream.send(customSub);
        console.log('[proxy] custom subscription updated');
      }
    } catch (e) {
      console.error('[proxy] bad browser message:', e.message);
    }
  });

  browser.on('close', () => {
    console.log('[proxy] browser disconnected');
    alive = false;
    if (upstream) try { upstream.terminate(); } catch(e){}
  });

  connectUpstream();
});

server.listen(PORT, () => console.log(`Ship tracker on http://localhost:${PORT}`));
