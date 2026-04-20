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
let depthCacheTime = 0; // v2 - ETOPO endpoint

app.get('/depth-grid', (req, res) => {
  const now = Date.now();
  if (depthCache && (now - depthCacheTime) < 24*60*60*1000) {
    res.setHeader('Access-Control-Allow-Origin','*');
    return res.json(depthCache);
  }

  // GMRT WCS - get depth at a grid of East Coast offshore points
  // Use a set of hand-picked ocean points since WCS queries are complex
  // Generate a dense grid covering East Coast + offshore
  const points = [];
  // 1-degree grid from 24N to 47N, 60W to 82W (ocean only - rough check)
  for (let lat = 24.5; lat <= 47; lat += 1.0) {
    for (let lon = -81.5; lon <= -60; lon += 1.0) {
      // Skip obvious inland areas
      if (lon > -75 && lat > 40 && lat < 45) continue; // New England inland
      if (lon > -77 && lat > 37 && lat < 41) continue; // Mid-Atlantic inland
      if (lon > -79 && lat > 35 && lat < 38) continue; // VA/NC inland
      if (lon > -80 && lat > 32 && lat < 36) continue; // SC/NC inland
      if (lon > -81 && lat > 29 && lat < 33) continue; // GA/SC inland
      if (lon > -81 && lat > 25 && lat < 30) {
        if (lon > -80.5) continue; // FL inland
      }
      points.push({ lat: Math.round(lat*10)/10, lon: Math.round(lon*10)/10 });
    }
  }
  // Also add a 0.5-degree grid for the key offshore zone (shelf to Gulf Stream)
  for (let lat = 25; lat <= 46; lat += 0.5) {
    for (let lon = -79; lon <= -63; lon += 0.5) {
      // Only add points not already covered by 1-degree grid
      if (lat % 1 === 0.5 || lon % 1 === 0.5) {
        points.push({ lat: Math.round(lat*10)/10, lon: Math.round(lon*10)/10 });
      }
    }
  }
  console.log('[depth-grid] fetching', points.length, 'depth points');

  // Use ERDDAP batch CSV for the whole East Coast grid at once
  // ETOPO1 has no time dim: altitude[(lat_start):(stride):(lat_stop)][(lon_start):(stride):(lon_stop)]
  // Use stride 6 = ~0.1 degrees for decent coverage
  const batchUrl = 'https://coastwatch.pfeg.noaa.gov/erddap/griddap/etopo180.csv?altitude%5B(24.0):6:(47.0)%5D%5B(-82.0):6:(-60.0)%5D';
  console.log('[depth-grid] fetching batch from ETOPO:', batchUrl);
  
  const batchReq = https.get(batchUrl, (r) => {
    let data = '';
    r.on('data', d => data += d);
    r.on('end', () => {
      try {
        const lines = data.trim().split('\n');
        const results = [];
        // Skip 2 header rows
        for (let i = 2; i < lines.length; i++) {
          const cols = lines[i].split(',');
          if (cols.length < 3) continue;
          const lat = parseFloat(cols[0]);
          const lon = parseFloat(cols[1]);
          const elev = parseFloat(cols[2]);
          if (isNaN(lat) || isNaN(lon) || isNaN(elev)) continue;
          if (elev >= 0) continue; // skip land
          const depthFt = Math.round(Math.abs(elev) * 3.28084);
          if (depthFt < 10) continue; // skip very shallow
          results.push({ lat: Math.round(lat*100)/100, lon: Math.round(lon*100)/100, depthFt });
        }
        console.log('[depth-grid] parsed', results.length, 'ocean depth points');
        depthCache = { points: results };
        depthCacheTime = Date.now();
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.json(depthCache);
      } catch(e) {
        console.error('[depth-grid] parse error:', e.message);
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.json({ points: [], error: e.message });
      }
    });
  });
  batchReq.setTimeout(30000, () => {
    batchReq.destroy();
    console.error('[depth-grid] batch timeout');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.json(depthCache || { points: [], error: 'timeout' });
  });
  batchReq.on('error', (e) => {
    console.error('[depth-grid] batch error:', e.message);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.json(depthCache || { points: [], error: e.message });
  });
  return; // early return - batch handles the response

  // Individual point fetching (fallback - not used with batch)
  let results = [];
  let pending = points.length;

  // Use ETOPO1 on ERDDAP - static dataset, no time dimension
  // Correct URL format: altitude[(lat)][lon] - no time dimension
  const fetchDepthPoint = (pt, cb) => {
    const url = `https://coastwatch.pfeg.noaa.gov/erddap/griddap/etopo180.json?altitude%5B(${pt.lat})%5D%5B(${pt.lon})%5D`;
    const req = https.get(url, (r) => {
      let data = '';
      r.on('data', d => data += d);
      r.on('end', () => {
        try {
          if (!data.startsWith('{')) return cb(null);
          const json = JSON.parse(data);
          const rows = json.table && json.table.rows;
          if (!rows || !rows[0]) return cb(null);
          const elev = parseFloat(rows[0][2]); // altitude column
          if (isNaN(elev) || elev >= 0) return cb(null); // skip land (positive = above sea)
          const depthFt = Math.round(Math.abs(elev) * 3.28084);
          cb({ lat: pt.lat, lon: pt.lon, depthFt });
        } catch(e) { cb(null); }
      });
    });
    req.setTimeout(8000, () => { req.destroy(); cb(null); });
    req.on('error', () => cb(null));
  };

  // Fetch all points with concurrency limit of 5
  let idx = 0;
  let active = 0;
  const concurrency = 5;

  function next() {
    while (active < concurrency && idx < points.length) {
      const pt = points[idx++];
      active++;
      fetchDepthPoint(pt, (result) => {
        if (result) results.push(result);
        active--;
        pending--;
        if (pending === 0) {
          console.log('[depth-grid] got', results.length, 'depth points');
          depthCache = { points: results };
          depthCacheTime = Date.now();
          res.setHeader('Access-Control-Allow-Origin','*');
          res.json(depthCache);
        } else {
          next();
        }
      });
    }
  }
  next();
});

// ── Single depth point lookup ────────────────────────────────────────────────
app.get('/depth', (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);
  if (isNaN(lat) || isNaN(lon)) { res.json({ error: 'bad params' }); return; }
  const url = `https://coastwatch.pfeg.noaa.gov/erddap/griddap/etopo180.json?altitude%5B(${lat})%5D%5B(${lon})%5D`;
  const req2 = https.get(url, (r) => {
    let data = '';
    r.on('data', d => data += d);
    r.on('end', () => {
      try {
        if (!data.startsWith('{')) { res.json({ depthFt: null }); return; }
        const json = JSON.parse(data);
        const rows = json.table && json.table.rows;
        const elev = rows && rows[0] && parseFloat(rows[0][2]);
        if (isNaN(elev) || elev >= 0) { res.json({ depthFt: null }); return; }
        const depthFt = Math.round(Math.abs(elev) * 3.28084);
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.json({ depthFt, depthM: Math.round(Math.abs(elev)) });
      } catch(e) { res.json({ depthFt: null }); }
    });
  });
  req2.setTimeout(8000, () => { req2.destroy(); res.json({ depthFt: null }); });
  req2.on('error', () => res.json({ depthFt: null }));
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
