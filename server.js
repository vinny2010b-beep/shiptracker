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
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

wss.on('connection', (browser, req) => {
  console.log('[proxy] browser connected');

  const upstream = new WebSocket('wss://stream.aisstream.io/v0/stream');
  let pendingSub = null; // queue subscription if upstream not ready yet

  upstream.on('open', () => {
    console.log('[proxy] upstream connected');
    // If browser already sent subscription, send it now
    if (pendingSub) {
      upstream.send(pendingSub);
      console.log('[proxy] sent queued subscription');
      pendingSub = null;
    }
  });

  upstream.on('message', (data) => {
    if (browser.readyState === WebSocket.OPEN) browser.send(data);
  });

  upstream.on('close', (code, reason) => {
    console.log('[proxy] upstream closed', code, reason.toString());
    if (browser.readyState === WebSocket.OPEN) browser.close();
  });

  upstream.on('error', (err) => {
    console.error('[proxy] upstream error:', err.message);
  });

  browser.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      msg.APIKey = API_KEY;
      msg.Apikey = API_KEY;
      const toSend = JSON.stringify(msg);

      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(toSend);
        console.log('[proxy] subscription forwarded');
      } else {
        // Upstream not ready yet — queue it
        pendingSub = toSend;
        console.log('[proxy] subscription queued (upstream not ready)');
      }
    } catch (e) {
      console.error('[proxy] bad browser message:', e.message);
    }
  });

  browser.on('close', () => {
    console.log('[proxy] browser disconnected');
    if (upstream.readyState !== WebSocket.CLOSED) upstream.close();
  });
});

server.listen(PORT, () => {
  console.log(`Ship tracker running on http://localhost:${PORT}`);
});
