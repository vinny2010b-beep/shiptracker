const express  = require('express');
const { createServer } = require('http');
const { WebSocket, WebSocketServer } = require('ws');
const path     = require('path');
const https    = require('https');
const http     = require('http');

const API_KEY       = process.env.AISSTREAM_API_KEY || '88725b94e9703f7de49e8f993b2427ef400bb3a0';
const PORT          = process.env.PORT || 3000;
const DB_API_URL    = process.env.DB_API_URL || 'https://rachelssolutions.com/ais/vessels_api.php';
const DB_SECRET     = process.env.DB_SECRET  || 'ais_secret_key_change_me';
const SAVE_INTERVAL = 30000; // save to DB every 30 seconds

// East Coast US + 140 miles offshore bounding box
// Extends from Florida to Maine, and ~140 miles out to sea (~2 degrees of longitude)
const EAST_COAST_BBOX = [[24, -82], [47, -60]];

const DEFAULT_SUB = JSON.stringify({
  APIKey:             API_KEY,
  Apikey:             API_KEY,
  BoundingBoxes:      [EAST_COAST_BBOX],
  FilterMessageTypes: ['PositionReport', 'StandardClassBPositionReport', 'ExtendedClassBPositionReport', 'ShipStaticData']
});

const app    = express();
const server = createServer(app);
const wss    = new WebSocketServer({ server, path: '/ws' });

app.use(express.static(path.join(__dirname, 'public')));

// ── DB save helper ────────────────────────────────────────────────────────────
function saveToDb(vessels) {
  const list = Object.values(vessels).filter(v => v.lat != null && v.lon != null);
  if (!list.length) return;

  const body = JSON.stringify({ vessels: list });
  const url  = new URL(DB_API_URL + '?action=save');
  const lib  = url.protocol === 'https:' ? https : http;

  const req = lib.request({
    hostname: url.hostname,
    path:     url.pathname + url.search,
    method:   'POST',
    headers:  {
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(body),
      'X-AIS-Secret':   DB_SECRET,
    }
  }, (res) => {
    let data = '';
    res.on('data', d => data += d);
    res.on('end', () => console.log(`[db] saved ${list.length} vessels:`, data.substring(0, 80)));
  });

  req.on('error', e => console.error('[db] save error:', e.message));
  req.write(body);
  req.end();
}

// ── ERDDAP SST proxy (avoids CORS) ───────────────────────────────────────────
app.get('/sst', (req, res) => {
  const lat  = parseFloat(req.query.lat);
  const lon  = parseFloat(req.query.lon);
  if (isNaN(lat) || isNaN(lon)) { res.json({ error: 'bad params' }); return; }

  const d    = new Date();
  d.setDate(d.getDate() - 1);
  const date = d.toISOString().substring(0, 10) + 'T00:00:00Z';
  const url  = `https://coastwatch.pfeg.noaa.gov/erddap/griddap/jplMURSST41.json?analysed_sst%5B(${date})%5D%5B(${lat})%5D%5B(${lon})%5D`;

  https.get(url, (r) => {
    let data = '';
    r.on('data', d => data += d);
    r.on('end', () => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Content-Type', 'application/json');
      res.send(data);
    });
  }).on('error', (e) => {
    res.json({ error: e.message });
  });
});

// ── NDBC buoy proxy (avoids CORS) ────────────────────────────────────────────
app.get('/ndbc', (req, res) => {
  const id = (req.query.id || '').replace(/[^a-zA-Z0-9]/g, '');
  if (!id) { res.json({ error: 'bad id' }); return; }
  const url = `https://www.ndbc.noaa.gov/data/realtime2/${id}.txt`;
  https.get(url, (r) => {
    let data = '';
    r.on('data', d => data += d);
    r.on('end', () => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Content-Type', 'text/plain');
      res.send(data);
    });
  }).on('error', (e) => res.status(500).send('error: ' + e.message));
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  const test = new WebSocket('wss://stream.aisstream.io/v0/stream');
  let done = false;
  const finish = (result) => { if (!done) { done = true; try { test.terminate(); } catch(e){} res.json(result); } };
  const timeout = setTimeout(() => finish({ server: 'ok', aisstream: 'NO_DATA_IN_10S' }), 10000);
  test.on('open', () => test.send(DEFAULT_SUB));
  test.on('message', (data) => {
    clearTimeout(timeout);
    try {
      const msg = JSON.parse(data.toString());
      finish({ server: 'ok', aisstream: 'DATA_FLOWING', type: msg.MessageType, mmsi: msg.MetaData && msg.MetaData.MMSI });
    } catch(e) { finish({ server: 'ok', aisstream: 'DATA_FLOWING' }); }
  });
  test.on('error', (e) => { clearTimeout(timeout); finish({ server: 'ok', aisstream: 'ERROR: ' + e.message }); });
  test.on('close', (code) => { clearTimeout(timeout); finish({ server: 'ok', aisstream: 'CLOSED_' + code }); });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

function safeSend(ws, data) {
  try { if (ws.readyState === WebSocket.OPEN) ws.send(typeof data === 'string' ? data : JSON.stringify(data)); } catch(e){}
}

// ── WebSocket proxy ───────────────────────────────────────────────────────────
wss.on('connection', (browser) => {
  console.log('[proxy] browser connected');

  let upstream   = null;
  let customSub  = null;
  let retryMs    = 2000;
  let alive      = true;
  let vessels    = {}; // accumulate vessel state for DB saves
  let saveTimer  = null;

  function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setInterval(() => {
      saveToDb(vessels);
    }, SAVE_INTERVAL);
  }

  function connectUpstream() {
    if (!alive) return;
    safeSend(browser, { _status: 'upstream_connecting' });

    upstream = new WebSocket('wss://stream.aisstream.io/v0/stream');

    upstream.on('open', () => {
      console.log('[proxy] upstream open');
      retryMs = 2000;
      const sub = customSub || DEFAULT_SUB;
      upstream.send(sub);
      safeSend(browser, { _status: 'upstream_connected' });
      scheduleSave();
    });

    upstream.on('message', (data) => {
      const str = data.toString();
      browser.send(str);

      // Parse and accumulate vessel state for DB
      try {
        const msg  = JSON.parse(str);
        if (msg._status) return;
        const meta = msg.MetaData || {};
        const mmsi = meta.MMSI;
        if (!mmsi) return;

        // Only save East Coast US vessels to DB (lat 24-47, lon -82 to -65)
        const dlat = meta.latitude;
        const dlon = meta.longitude;
        const isEastCoast = dlat >= 24 && dlat <= 47 && dlon >= -82 && dlon <= -60;
        if (!isEastCoast) return;

        if (!vessels[mmsi]) vessels[mmsi] = { mmsi };
        const v = vessels[mmsi];
        v.updated = Date.now();

        if (typeof meta.latitude  === 'number' && Math.abs(meta.latitude)  > 0.001) v.lat = meta.latitude;
        if (typeof meta.longitude === 'number' && Math.abs(meta.longitude) > 0.001) v.lon = meta.longitude;
        if (meta.ShipName && meta.ShipName.trim()) v.name = meta.ShipName.trim();

        const body = msg.Message || {};
        if (msg.MessageType === 'PositionReport') {
          const pr = body.PositionReport || {};
          if (pr.Sog != null) v.speed = pr.Sog;
          if (pr.Cog != null && pr.Cog < 360) v.cog = pr.Cog;
          if (pr.TrueHeading != null && pr.TrueHeading < 360) v.heading = pr.TrueHeading;
          if (pr.NavigationalStatus != null) v.navStatus = pr.NavigationalStatus;
        }
        if (msg.MessageType === 'StandardClassBPositionReport') {
          const pr = body.StandardClassBPositionReport || {};
          if (pr.Sog != null) v.speed = pr.Sog;
          if (pr.Cog != null && pr.Cog < 360) v.cog = pr.Cog;
        }
        if (msg.MessageType === 'ShipStaticData') {
          const sd = body.ShipStaticData || {};
          if (sd.Type) v.type = sd.Type;
          if (sd.Destination) v.destination = sd.Destination.replace(/[@\x00]/g,'').trim();
        }
      } catch(e) {}
    });

    upstream.on('close', (code) => {
      console.log('[proxy] upstream closed', code);
      safeSend(browser, { _status: 'upstream_reconnecting', code });
      if (alive) {
        retryMs = Math.min(retryMs * 2, 30000);
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
      msg.APIKey = API_KEY;
      msg.Apikey = API_KEY;
      customSub = JSON.stringify(msg);
      if (upstream && upstream.readyState === WebSocket.OPEN) upstream.send(customSub);
    } catch (e) {}
  });

  browser.on('close', () => {
    console.log('[proxy] browser disconnected');
    alive = false;
    if (saveTimer) clearInterval(saveTimer);
    saveToDb(vessels); // final save on disconnect
    if (upstream) try { upstream.terminate(); } catch(e){}
  });

  connectUpstream();
});

server.listen(PORT, () => console.log(`Ship tracker on http://localhost:${PORT}`));
