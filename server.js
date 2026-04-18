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
  console.log('[proxy] browser connected from', req.socket.remoteAddress);
  const upstream = new WebSocket('wss://stream.aisstream.io/v0/stream');

  upstream.on('open', () => {
    console.log('[proxy] upstream aisstream.io connected');
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
      // Inject the API key server-side so it's never exposed in browser source
      msg.APIKey = API_KEY;
      msg.Apikey = API_KEY;
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(JSON.stringify(msg));
        console.log('[proxy] subscription forwarded:', JSON.stringify(msg).substring(0, 100));
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
