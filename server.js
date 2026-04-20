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
const SAVE_INTERVAL = 60000; // save to DB every 60 seconds

// East Coast US + 140 miles offshore bounding box
// Extends from Florida to Maine, and ~140 miles out to sea (~2 degrees of longitude)
const EAST_COAST_BBOX = [[24, -82], [47, -60]];

const DEFAULT_SUB = JSON.stringify({
  APIKey:             API_KEY,
  Apikey:             API_KEY,
  BoundingBoxes:      [EAST_COAST_BBOX],
  FilterMessageTypes: ['PositionReport', 'StandardClassBPositionReport', 'ShipStaticData']
});

const app    = express();
const server = createServer(app);
const wss    = new WebSocketServer({ server, path: '/ws' });

app.use(express.static(path.join(__dirname, 'public')));

// ── DB save helper ────────────────────────────────────────────────────────────
function saveToDb(vessels) {
  // Vessel types to exclude: Cargo(70-79), Tanker(80-89), Dredging(33),
  // HSC(40-49), WIG(20-29), Diving(34), Anti-pollution(54), Towing(31,32)
  const excludedTypes = new Set([33, 34, 31, 32, 54]);
  const list = Object.values(vessels).filter(v => {
    if (!v.lat || !v.lon) return false;
    if (!v.type) return true; // unknown type — include
    const t = v.type;
    if (excludedTypes.has(t)) return false;
    if (t >= 20 && t <= 29) return false; // WIG
    if (t >= 40 && t <= 49) return false; // HSC
    if (t >= 70 && t <= 79) return false; // Cargo
    if (t >= 80 && t <= 89) return false; // Tanker
    return true;
  });
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

// ── ERDDAP SST proxy — single point ─────────────────────────────────────────
app.get('/sst', (req, res) => {
  const lat  = parseFloat(req.query.lat);
  const lon  = parseFloat(req.query.lon);
  if (isNaN(lat) || isNaN(lon)) { res.json({ error: 'bad params' }); return; }
  const d    = new Date(); d.setDate(d.getDate() - 1);
  const date = d.toISOString().substring(0, 10) + 'T00:00:00Z';
  const url  = `https://coastwatch.pfeg.noaa.gov/erddap/griddap/jplMURSST41.json?analysed_sst%5B(${date})%5D%5B(${lat})%5D%5B(${lon})%5D`;
  https.get(url, (r) => {
    let data = '';
    r.on('data', d => data += d);
    r.on('end', () => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Content-Type', 'application/json');
      // Return empty result if ERDDAP returns an error (land, inland water, etc.)
      if (!data.startsWith('{')) { res.json({ table: { rows: [] } }); return; }
      res.send(data);
    });
  }).on('error', (e) => res.json({ table: { rows: [] } }));
});

// ── ERDDAP SST batch — cached for 6 hours ───────────────────────────────────
let sstCache = null;
let sstCacheTime = 0;
// URL fixed - clear any bad cache on startup
const SST_CACHE_MS = 6 * 60 * 60 * 1000; // 6 hours

function fetchSSTGrid(callback) {
  const now = Date.now();
  if (sstCache && (now - sstCacheTime) < SST_CACHE_MS) {
    console.log('[sst-grid] serving from cache, age:', Math.round((now-sstCacheTime)/60000)+'min');
    return callback(null, sstCache);
  }

  // Try up to 4 days back to find available data
  let date = null, url = null;
  for (let daysBack = 2; daysBack <= 5; daysBack++) {
    const d = new Date(); d.setDate(d.getDate() - daysBack);
    date = d.toISOString().substring(0, 10) + 'T00:00:00Z';
    // lat: south(24) to north(47), stride 50 = ~0.5deg spacing
    // lon: west(-82) to east(-60), stride 50 = ~0.5deg spacing
    url = `https://coastwatch.pfeg.noaa.gov/erddap/griddap/jplMURSST41.csv?analysed_sst%5B(${date})%5D%5B(24.0):50:(47.0)%5D%5B(-82.0):50:(-60.0)%5D`;
    break; // start with 2 days back, server will retry if empty
  }

  console.log('[sst-grid] fetching from ERDDAP...');
  const req = https.get(url, (r) => {
    let data = '';
    r.setTimeout(20000);
    r.on('data', d => data += d);
    r.on('end', () => {
      try {
        const lines  = data.trim().split('\n');
        const points = [];
        for (let i = 2; i < lines.length; i++) {
          const cols = lines[i].split(',');
          if (cols.length < 4) continue;
          const lat   = parseFloat(cols[1]);
          const lon   = parseFloat(cols[2]);
          const tempC = parseFloat(cols[3]);
          if (isNaN(lat) || isNaN(lon) || isNaN(tempC)) continue;
          if (tempC < -2 || tempC > 40) continue;
          const tempF = parseFloat((tempC * 9/5 + 32).toFixed(1));
          points.push({ lat, lon, tempC: parseFloat(tempC.toFixed(1)), tempF });
        }
        if (points.length > 0) {
          sstCache = { points, date: date.substring(0, 10) };
          sstCacheTime = now;
          console.log('[sst-grid] cached', points.length, 'points');
        }
        callback(null, { points, date: date.substring(0, 10) });
      } catch(e) {
        // If ERDDAP fails, return stale cache if available
        console.error('[sst-grid] parse error:', e.message);
        callback(null, sstCache || { points: [], error: e.message });
      }
    });
  });
  req.setTimeout(25000, () => {
    req.destroy();
    console.error('[sst-grid] timeout — using stale cache');
    callback(null, sstCache || { points: [], error: 'timeout' });
  });
  req.on('error', (e) => {
    console.error('[sst-grid] error:', e.message);
    callback(null, sstCache || { points: [], error: e.message });
  });
}

app.get('/sst-grid', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  fetchSSTGrid((err, data) => res.json(data));
});

// Pre-warm cache on startup
setTimeout(() => fetchSSTGrid(() => console.log('[sst-grid] pre-warmed')), 5000);

// ── GMRT Bathymetry depth grid (cached 24h) ──────────────────────────────────
let depthCache = null;
let depthCacheTime = 0;

app.get('/depth-grid', (req, res) => {
  const now = Date.now();
  if (depthCache && (now - depthCacheTime) < 24*60*60*1000) {
    res.setHeader('Access-Control-Allow-Origin','*');
    return res.json(depthCache);
  }

  // GMRT WCS - get depth at a grid of East Coast offshore points
  // Use a set of hand-picked ocean points since WCS queries are complex
  const points = [
    // Continental shelf (shallow)
    {lat:40.5,lon:-73.5},{lat:39.5,lon:-73.5},{lat:38.5,lon:-74.0},
    {lat:37.5,lon:-75.0},{lat:36.5,lon:-75.5},{lat:35.5,lon:-75.5},
    {lat:34.5,lon:-76.5},{lat:33.5,lon:-78.0},{lat:32.5,lon:-79.5},
    {lat:31.5,lon:-80.5},{lat:30.5,lon:-81.0},{lat:29.0,lon:-80.5},
    {lat:27.0,lon:-80.0},{lat:25.5,lon:-80.0},
    // Shelf break
    {lat:41.0,lon:-68.0},{lat:40.0,lon:-70.0},{lat:39.0,lon:-71.5},
    {lat:38.0,lon:-72.5},{lat:37.0,lon:-74.0},{lat:36.0,lon:-74.5},
    {lat:35.0,lon:-75.0},{lat:34.0,lon:-76.0},{lat:33.0,lon:-77.5},
    {lat:32.0,lon:-79.0},{lat:30.0,lon:-80.0},{lat:28.0,lon:-79.5},
    // Deep water / Gulf Stream
    {lat:40.0,lon:-65.0},{lat:39.0,lon:-67.0},{lat:38.0,lon:-69.0},
    {lat:37.0,lon:-71.0},{lat:36.0,lon:-72.0},{lat:35.0,lon:-73.5},
    {lat:34.0,lon:-74.5},{lat:33.0,lon:-76.0},{lat:32.0,lon:-77.5},
    {lat:31.0,lon:-78.5},{lat:30.0,lon:-79.0},{lat:29.0,lon:-79.0},
    {lat:28.0,lon:-79.5},{lat:27.0,lon:-79.5},{lat:26.0,lon:-79.5},
    // Abyssal
    {lat:41.0,lon:-62.0},{lat:39.0,lon:-63.0},{lat:37.0,lon:-65.0},
    {lat:35.0,lon:-68.0},{lat:33.0,lon:-70.0},{lat:31.0,lon:-74.0},
    // Georges Bank
    {lat:41.5,lon:-67.5},{lat:42.0,lon:-67.0},{lat:41.8,lon:-68.5},
  ];

  // Fetch depths from NOAA GMRT REST API
  let results = [];
  let pending = points.length;

  points.forEach(function(pt) {
    const url = `https://www.gmrt.org/services/PointServer?longitude=${pt.lon}&latitude=${pt.lat}&format=json`;
    https.get(url, (r) => {
      let data = '';
      r.on('data', d => data += d);
      r.on('end', () => {
        try {
          const json = JSON.parse(data);
          const elev = json.altitude || json.depth || (json[0] && json[0].z);
          if (elev !== undefined && elev !== null) {
            const depthFt = Math.round(Math.abs(parseFloat(elev)) * 3.28084);
            if (depthFt > 0) results.push({ lat: pt.lat, lon: pt.lon, depthFt });
          }
        } catch(e) {}
        pending--;
        if (pending === 0) {
          depthCache = { points: results };
          depthCacheTime = Date.now();
          res.setHeader('Access-Control-Allow-Origin','*');
          res.json(depthCache);
        }
      });
    }).on('error', () => {
      pending--;
      if (pending === 0) {
        depthCache = { points: results };
        depthCacheTime = Date.now();
        res.setHeader('Access-Control-Allow-Origin','*');
        res.json(depthCache);
      }
    });
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
      // Always relay to browser for live map updates
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

// Keep Render free tier alive — ping self every 14 minutes
const SELF_URL = process.env.RENDER_EXTERNAL_URL || null;
if (SELF_URL) {
  setInterval(() => {
    https.get(SELF_URL + '/health', (r) => {
      console.log('[keepalive] ping ok', r.statusCode);
    }).on('error', (e) => console.log('[keepalive] ping failed:', e.message));
  }, 14 * 60 * 1000);
  console.log('[keepalive] started, pinging', SELF_URL);
}

server.listen(PORT, () => console.log(`Ship tracker on http://localhost:${PORT}`));
