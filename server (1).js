const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const IMAGES_DIR = path.join(DATA_DIR, 'images');
const DB_PATH = path.join(DATA_DIR, 'mto_cache.db');

fs.mkdirSync(IMAGES_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Database — every upload + its extracted MTO is cached here so nothing has
// to be re-processed, and a ChatGPT-style "history" sidebar can be built from
// it on the frontend.
// ---------------------------------------------------------------------------
const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    id            TEXT PRIMARY KEY,
    filename      TEXT NOT NULL,
    mime_type     TEXT NOT NULL,
    image_path    TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    drawing_no    TEXT,
    line_number   TEXT,
    source        TEXT NOT NULL,      -- 'llm' | 'mock'
    result_json   TEXT NOT NULL       -- full validated MTO result (cached, never recomputed)
  );
  CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at DESC);
`);

const insertJobStmt = db.prepare(`
  INSERT INTO jobs (id, filename, mime_type, image_path, created_at, drawing_no, line_number, source, result_json)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const listJobsStmt = db.prepare(`
  SELECT id, filename, mime_type, created_at, drawing_no, line_number, source
  FROM jobs ORDER BY created_at DESC
`);
const getJobStmt = db.prepare(`SELECT * FROM jobs WHERE id = ?`);
const deleteJobStmt = db.prepare(`DELETE FROM jobs WHERE id = ?`);

function cacheJob({ filename, mimeType, imageBuffer, result }) {
  const id = crypto.randomUUID();
  const ext = mimeType === 'application/pdf' ? 'pdf' : (mimeType.split('/')[1] || 'png');
  const imagePath = path.join(IMAGES_DIR, `${id}.${ext}`);
  fs.writeFileSync(imagePath, imageBuffer);

  const meta = result.drawing_meta || {};
  insertJobStmt.run(
    id,
    filename,
    mimeType,
    imagePath,
    new Date().toISOString(),
    meta.drawing_no || null,
    meta.line_number || null,
    result.source,
    JSON.stringify(result)
  );
  return id;
}

function rowToHistoryEntry(row) {
  return {
    id: row.id,
    filename: row.filename,
    mime_type: row.mime_type,
    created_at: row.created_at,
    drawing_no: row.drawing_no,
    line_number: row.line_number,
    source: row.source
  };
}

// ---------------------------------------------------------------------------
// MTO extraction pipeline (mock fallback + Gemini vision call)
// ---------------------------------------------------------------------------
function mockResult(filename) {
  return {
    drawing_meta: {
      drawing_no: 'MOCK-ISO-1501-01', revision: '0', line_number: '6"-P-1501-A1A-IH',
      nps: '6"', material_class: 'A1A', service: 'Process', sheet: '1 of 1'
    },
    items: [
      { item_no: 1, category: 'PIPE', description: 'Pipe, Seamless, BE, ASME B36.10 (MOCK DATA)', size_nps: '6"', schedule_rating: 'SCH 40', material_spec: 'ASTM A106 Gr.B', end_type: 'BW', quantity: 1, unit: 'M', length_m: 18.6, confidence: 1, remarks: `Mock pipeline — no live Gemini key. Uploaded file was '${filename}'.` },
      { item_no: 2, category: 'FITTING', description: 'Elbow 90 Deg LR, BW, ASME B16.9 (MOCK DATA)', size_nps: '6"', schedule_rating: 'SCH 40', material_spec: 'ASTM A234 WPB', end_type: 'BW', quantity: 4, unit: 'EA', confidence: 1 },
      { item_no: 3, category: 'FITTING', description: 'Tee Equal, BW, ASME B16.9 (MOCK DATA)', size_nps: '6"', schedule_rating: 'SCH 40', material_spec: 'ASTM A234 WPB', end_type: 'BW', quantity: 1, unit: 'EA', confidence: 1 },
      { item_no: 4, category: 'FLANGE', description: 'Weld Neck Flange, CL150, ASME B16.5 (MOCK DATA)', size_nps: '6"', schedule_rating: 'CL150', material_spec: 'ASTM A105', end_type: 'BW', quantity: 2, unit: 'EA', confidence: 1 },
      { item_no: 5, category: 'VALVE', description: 'Gate Valve, Flanged, CL150 (MOCK DATA)', size_nps: '6"', schedule_rating: 'CL150', material_spec: 'ASTM A216 WCB', end_type: 'FLGD', quantity: 1, unit: 'EA', confidence: 1 }
    ],
    summary: {},
    warnings: ['This is MOCK data — no Gemini API key was provided.'],
    source: 'mock'
  };
}

function normalizeUnit(u) {
  if (!u) return 'EA';
  const v = u.trim().toUpperCase();
  const aliases = { EACH: 'EA', NOS: 'NO', SETS: 'SET', MTR: 'M', MTRS: 'M', METERS: 'M', METRE: 'M' };
  return aliases[v] || v;
}

function deriveMissingJointConsumables(items, warnings) {
  const flangeLike = items.filter(i => i.category === 'FLANGE' || i.category === 'VALVE').reduce((s, i) => s + (Number(i.quantity) || 0), 0);
  const hasGasket = items.some(i => i.category === 'GASKET');
  const hasBolt = items.some(i => i.category === 'BOLT');
  let nextNo = Math.max(0, ...items.map(i => i.item_no || 0)) + 1;

  if (flangeLike > 0 && !hasGasket) {
    items.push({ item_no: nextNo++, category: 'GASKET', description: 'Gasket, Spiral Wound, SS316/Graphite, ASME B16.20 (derived)', quantity: flangeLike, unit: 'EA', confidence: 0.5, remarks: 'Auto-derived: one per flanged joint, not explicitly read from drawing.' });
    warnings.push('Gaskets were not explicitly detected; derived from flange/valve count.');
  }
  if (flangeLike > 0 && !hasBolt) {
    items.push({ item_no: nextNo++, category: 'BOLT', description: 'Stud Bolts w/ Nuts, ASTM A193 B7 / A194 2H (derived)', quantity: flangeLike, unit: 'SET', confidence: 0.5, remarks: 'Auto-derived: one set per flanged joint, not explicitly read from drawing.' });
    warnings.push('Bolt sets were not explicitly detected; derived from flange/valve count.');
  }
  return items;
}

function recomputeSummary(items) {
  const summary = { total_pipe_length_m: 0, fittings: 0, flanges: 0, valves: 0, gaskets: 0, bolt_sets: 0, field_welds: 0, supports: 0 };
  for (const item of items) {
    const q = Number(item.quantity) || 0;
    if (item.category === 'PIPE') summary.total_pipe_length_m += Number(item.length_m) || 0;
    else if (item.category === 'FITTING') summary.fittings += q;
    else if (item.category === 'FLANGE') summary.flanges += q;
    else if (item.category === 'VALVE') summary.valves += q;
    else if (item.category === 'GASKET') summary.gaskets += q;
    else if (item.category === 'BOLT') summary.bolt_sets += q;
    else if (item.category === 'SUPPORT') summary.supports += q;
  }
  summary.total_pipe_length_m = Math.round(summary.total_pipe_length_m * 100) / 100;
  return summary;
}

function validateAndFinalize(raw, source) {
  const warnings = Array.isArray(raw.warnings) ? [...raw.warnings] : [];
  const meta = raw.drawing_meta || {};
  let items = (raw.items || []).map((it, idx) => ({
    item_no: it.item_no || idx + 1,
    category: (it.category || 'OTHER').toUpperCase(),
    description: it.description || '(no description)',
    size_nps: it.size_nps || null,
    schedule_rating: it.schedule_rating || null,
    material_spec: it.material_spec || null,
    end_type: it.end_type || null,
    quantity: Math.max(0, Number(it.quantity) || 0),
    unit: normalizeUnit(it.unit),
    length_m: it.length_m != null ? Math.max(0, Number(it.length_m)) : null,
    confidence: it.confidence != null ? Math.min(1, Math.max(0, Number(it.confidence))) : null,
    remarks: it.remarks || null
  }));
  items = deriveMissingJointConsumables(items, warnings);
  const summary = recomputeSummary(items);
  return { drawing_meta: meta, items, summary, source, warnings };
}

const EXTRACTION_PROMPT = `You are a senior piping engineer specializing in reading piping isometric
drawings ("isos") and producing a Material Take-Off (MTO). Extract a complete,
structured MTO. Read the title block and line-number callout first, trace the
pipe route and sum lengths for PIPE items (length, not count), identify every
inline symbol (elbows, tees, reducers, olets, caps, flanges, valves), derive
one GASKET and one BOLT SET per flanged joint if not already listed, flag
field welds, use correct ASTM/ASME vocabulary, and give every item a
confidence 0-1. Return ONLY the JSON object matching the schema. No prose.`;

const MTO_SCHEMA = {
  type: 'OBJECT',
  properties: {
    drawing_meta: { type: 'OBJECT', properties: { drawing_no: { type: 'STRING' }, revision: { type: 'STRING' }, line_number: { type: 'STRING' }, nps: { type: 'STRING' }, material_class: { type: 'STRING' }, service: { type: 'STRING' }, sheet: { type: 'STRING' } } },
    items: { type: 'ARRAY', items: { type: 'OBJECT', properties: { item_no: { type: 'INTEGER' }, category: { type: 'STRING', enum: ['PIPE', 'FITTING', 'FLANGE', 'VALVE', 'GASKET', 'BOLT', 'SUPPORT', 'INSTRUMENT', 'OTHER'] }, description: { type: 'STRING' }, size_nps: { type: 'STRING' }, schedule_rating: { type: 'STRING' }, material_spec: { type: 'STRING' }, end_type: { type: 'STRING' }, quantity: { type: 'NUMBER' }, unit: { type: 'STRING' }, length_m: { type: 'NUMBER' }, confidence: { type: 'NUMBER' }, remarks: { type: 'STRING' } }, required: ['item_no', 'category', 'description', 'quantity', 'unit'] } },
    summary: { type: 'OBJECT', properties: { total_pipe_length_m: { type: 'NUMBER' }, fittings: { type: 'INTEGER' }, flanges: { type: 'INTEGER' }, valves: { type: 'INTEGER' }, gaskets: { type: 'INTEGER' }, bolt_sets: { type: 'INTEGER' }, field_welds: { type: 'INTEGER' }, supports: { type: 'INTEGER' } } }
  },
  required: ['drawing_meta', 'items', 'summary']
};

async function callGemini(apiKey, base64Image, mimeType, filename) {
  const model = 'gemini-2.5-flash';
  const body = {
    contents: [{ parts: [{ inline_data: { mime_type: mimeType, data: base64Image } }, { text: EXTRACTION_PROMPT + `\n\nFile name: ${filename}` }] }],
    generationConfig: { responseMimeType: 'application/json', responseSchema: MTO_SCHEMA, temperature: 0.1 }
  };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Gemini API error (${res.status}): ${errText.slice(0, 300)}`);
  }
  const data = await res.json();
  const generated = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
  return JSON.parse(generated);
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function serveFile(filePath, contentType, res) {
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

async function handleExtract(req, res) {
  try {
    const rawBody = await readBody(req);
    const payload = rawBody ? JSON.parse(rawBody) : {};
    const { imageBase64, filename = 'upload.png', mimeType = 'image/png' } = payload;

    if (!imageBase64) return sendJson(res, 400, { error: 'Missing imageBase64' });

    // The Gemini API key lives ONLY on the server now (env var). The
    // frontend no longer collects or sends a key at all — every upload's
    // image data is handed to this backend, which does the analysis.
    const effectiveKey = process.env.GEMINI_API_KEY || '';
    let result;
    if (!effectiveKey) {
      result = validateAndFinalize(mockResult(filename), 'mock');
    } else {
      try {
        const raw = await callGemini(effectiveKey, imageBase64, mimeType, filename);
        result = validateAndFinalize(raw, 'llm');
      } catch (err) {
        const fallback = mockResult(filename);
        fallback.warnings = [`Live extraction failed (${err.message}); showing mock data instead.`];
        result = validateAndFinalize(fallback, 'mock');
      }
    }

    // Cache everything: the source image + the fully validated MTO result.
    const imageBuffer = Buffer.from(imageBase64, 'base64');
    const id = cacheJob({ filename, mimeType, imageBuffer, result });

    sendJson(res, 200, { id, ...result });
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
}

function handleHistoryList(req, res) {
  const rows = listJobsStmt.all();
  sendJson(res, 200, { jobs: rows.map(rowToHistoryEntry) });
}

function handleHistoryGet(req, res, id) {
  const row = getJobStmt.get(id);
  if (!row) return sendJson(res, 404, { error: 'Not found' });
  const result = JSON.parse(row.result_json);
  sendJson(res, 200, { id: row.id, filename: row.filename, mime_type: row.mime_type, created_at: row.created_at, image_url: `/api/image/${row.id}`, ...result });
}

function handleHistoryDelete(req, res, id) {
  const row = getJobStmt.get(id);
  if (!row) return sendJson(res, 404, { error: 'Not found' });
  try { fs.unlinkSync(row.image_path); } catch (_) {}
  deleteJobStmt.run(id);
  sendJson(res, 200, { deleted: true });
}

function handleImage(req, res, id) {
  const row = getJobStmt.get(id);
  if (!row) { res.writeHead(404); res.end('Not found'); return; }
  serveFile(row.image_path, row.mime_type, res);
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = requestUrl.pathname;

  // CORS (useful if the frontend is ever split out / run on another port)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
    return serveFile(path.join(PUBLIC_DIR, 'index.html'), 'text/html; charset=utf-8', res);
  }
  if (req.method === 'GET' && p === '/health') return sendJson(res, 200, { ok: true });
  if (req.method === 'POST' && p === '/api/extract') return handleExtract(req, res);
  if (req.method === 'GET' && p === '/api/history') return handleHistoryList(req, res);
  if (req.method === 'GET' && p.startsWith('/api/history/')) return handleHistoryGet(req, res, p.split('/')[3]);
  if (req.method === 'DELETE' && p.startsWith('/api/history/')) return handleHistoryDelete(req, res, p.split('/')[3]);
  if (req.method === 'GET' && p.startsWith('/api/image/')) return handleImage(req, res, p.split('/')[3]);

  sendJson(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => {
  console.log(`ISO/MTO backend (with SQLite cache) running at http://localhost:${PORT}`);
  console.log(`Database: ${DB_PATH}`);
});
