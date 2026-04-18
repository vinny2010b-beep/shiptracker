const express = require('express');
const { createServer } = require('http');
const { WebSocket, WebSocketServer } = require('ws');
const path = require('path');

const API_KEY = process.env.AISSTREAM_API_KEY || '668b2e628751538eebf699653f7d3dc001bb7921';
const PORT    = process.env.PORT || 3000;

const app    = express();
const server = createServer(app);
const wss    = new WebSocketServer({ server, path: '/ws' });

app.use(express.static(path.join(__dirname, 'public')));

// Health check — visit /health to verify server can reach aisstream.io
app.get('/health', (req, res) => {
  const test = new WebSocket('wss://stream.aisstream.io/v0/stream');
  const result = { server: 'ok', aisstream: 'connecting', time: new Date().toISOString() };
  const timer = setTimeout(() => {
    test.close();
    result.aisstream = 'timeout';
    res.json(result);
  }, 8000);
  test.on('open', () => {
    result.aisstream = 'connected';
    test.send(JSON.stringify({ APIKey: API_KEY, BoundingBoxes: [[[-90,-180],[90,180]]], FilterMessageTypes: ['PositionReport'] }));
  });
  test.on('message', () => {
    clearTimeout(timer);
    result.aisstream = 'data_flowing';
    test.close();
    res.json(result);
  });
  test.on('error', (e) => {
    clearTimeout(timer);
    result.aisstream = 'error: ' + e.message;
    res.json(result);
  });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

wss.on('connection', (browser) => {
  console.log('[proxy] browser connected');

  // Tell browser the proxy is ready
  browser.send(JSON.stringify({ _status: 'proxy_ready' }));

  const upstream = new WebSocket('wss://stream.aisstream.io/v0/stream');
  let pendingSub = null;
  let msgCount = 0;

  upstream.on('open', () => {
    console.log('[proxy] upstream connected to aisstream.io');
    browser.send(JSON.stringify({ _status: 'upstream_connected' }));
    if (pendingSub) {
      upstream.send(pendingSub);
      console.log('[proxy] sent queued subscription');
      pendingSub = null;
    }
  });

  upstream.on('message', (data, isBinary) => {
    msgCount++;
    if (msgCount === 1) {
      console.log('[proxy] first AIS message received — data is flowing');
      browser.send(JSON.stringify({ _status: 'data_flowing' }));
    }
    if (browser.readyState === WebSocket.OPEN) {
      browser.send(isBinary ? data : data.toString());
    }
  });

  upstream.on('close', (code, reason) => {
    console.log('[proxy] upstream closed', code, reason.toString());
    browser.send(JSON.stringify({ _status: 'upstream_closed', code }));
    if (browser.readyState === WebSocket.OPEN) browser.close();
  });

  upstream.on('error', (err) => {
    console.error('[proxy] upstream error:', err.message);
    browser.send(JSON.stringify({ _status: 'upstream_error', msg: err.message }));
  });

  browser.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      msg.APIKey = API_KEY;
      msg.Apikey = API_KEY;
      const toSend = JSON.stringify(msg);
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(toSend);
        console.log('[proxy] subscription forwarded to aisstream.io');
      } else {
        pendingSub = toSend;
        console.log('[proxy] subscription queued — upstream state:', upstream.readyState);
      }
    } catch (e) {
      console.error('[proxy] bad browser message:', e.message);
    }
  });

  browser.on('close', () => {
    console.log('[proxy] browser disconnected, total AIS msgs relayed:', msgCount);
    if (upstream.readyState !== WebSocket.CLOSED) upstream.close();
  });
});

server.listen(PORT, () => {
  console.log(`Ship tracker running on http://localhost:${PORT}`);
});
