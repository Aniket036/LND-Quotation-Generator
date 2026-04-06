require('dotenv').config();
const express      = require('express');
const fetch        = require('node-fetch');
const path         = require('path');
const fs           = require('fs');
const { Readable } = require('stream');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Config ──────────────────────────────────────────────────────────────────
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL    || '';
const DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID || '';
const SHEET_ID        = process.env.GOOGLE_SHEET_ID    || '';
const KEY_FILE        = path.resolve(
  process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE || './service-account-key.json'
);

// Tabs inside the single Google Sheet
const TAB_PRODUCTS = process.env.TAB_PRODUCTS || 'Product list';
const TAB_BANKS    = process.env.TAB_BANKS    || 'Banks';
const TAB_HISTORY  = process.env.TAB_HISTORY  || 'History';

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '25mb' }));

// ── Google Auth ───────────────────────────────────────────────────────────────
let _auth = null;
async function getAuth() {
  if (_auth) return _auth;
  const { google } = require('googleapis');
  const scopes = [
    'https://www.googleapis.com/auth/drive',         // full Drive (Shared Drive support)
    'https://www.googleapis.com/auth/spreadsheets'   // read + write sheets
  ];
  if (process.env.GOOGLE_CREDENTIALS) {
    _auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS), scopes
    });
  } else if (fs.existsSync(KEY_FILE)) {
    _auth = new google.auth.GoogleAuth({ keyFile: KEY_FILE, scopes });
  } else {
    throw new Error(
      'Google credentials not found. Place service-account-key.json in the project root, ' +
      'or set GOOGLE_CREDENTIALS env var with the full JSON content.'
    );
  }
  return _auth;
}

// ── Helper: normalise a sheet row object ──────────────────────────────────────
// rows from sheets.values.get → array of arrays
// rows from Apps Script doGet → array of objects
function normaliseRow(row, headers) {
  // If already an object (from Apps Script), return as-is
  if (!Array.isArray(row)) return row;
  // Convert array row + header array into an object
  const obj = {};
  headers.forEach((h, i) => { obj[h] = row[i] || ''; });
  return obj;
}

function getField(obj, ...keys) {
  for (const k of Object.keys(obj)) {
    for (const q of keys) {
      if (k.toLowerCase().trim().includes(q.toLowerCase())) return String(obj[k]||'').trim();
    }
  }
  return '';
}

// ── Shared Sheets reader ──────────────────────────────────────────────────────
async function readTab(tabName) {
  if (!SHEET_ID || SHEET_ID.includes('YOUR_')) {
    throw new Error('GOOGLE_SHEET_ID not configured in .env');
  }
  const { google } = require('googleapis');
  const auth   = await getAuth();
  const sheets = google.sheets({ version:'v4', auth });
  const result = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `'${tabName}'!A:Z`          // single-quoted tab name handles spaces
  });
  const rows = result.data.values || [];
  if (rows.length < 2) return [];
  const headers = rows[0].map(h => String(h).trim());
  return rows.slice(1)
    .filter(r => r.some(c => String(c).trim()))  // skip fully empty rows
    .map(r => normaliseRow(r, headers));
}

// ── GET /api/products ─────────────────────────────────────────────────────────
// Primary: Sheets API reading "Product list" tab directly (no Apps Script needed)
// Fallback: APPS_SCRIPT_URL if configured (keeps backwards compat)
app.get('/api/products', async (req, res) => {
  try {
    let rows;

    // Try direct Sheets read first
    if (SHEET_ID && !SHEET_ID.includes('YOUR_')) {
      rows = await readTab(TAB_PRODUCTS);
    } else if (APPS_SCRIPT_URL && !APPS_SCRIPT_URL.includes('YOUR_')) {
      // Fallback to Apps Script
      const r = await fetch(APPS_SCRIPT_URL, { redirect:'follow', headers:{ Accept:'application/json' } });
      if (!r.ok) throw new Error(`Apps Script HTTP ${r.status}`);
      const raw = await r.text();
      rows = JSON.parse(raw.replace(/^[^([{]*/, '').replace(/[^}\]]*$/, ''));
    } else {
      return res.status(503).json({ error: 'GOOGLE_SHEET_ID not configured in .env' });
    }

    const products = rows.map(row => ({
      category: getField(row, 'category', 'cat'),
      model:    getField(row, 'model name', 'model'),
      price:    parseFloat(getField(row, 'unit price', 'price').replace(/,/g,'')) || 0,
      image:    getField(row, 'image')
    })).filter(p => p.model);

    res.set('Cache-Control', 'public, max-age=180');
    res.json(products);
  } catch(err) {
    console.error('[/api/products]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/banks ────────────────────────────────────────────────────────────
// Reads "Banks" tab from the single Google Sheet
// Columns: Label | Bank Name | Account Number | IFSC | Branch
app.get('/api/banks', async (req, res) => {
  try {
    const rows = await readTab(TAB_BANKS);
    const banks = rows.map(row => ({
      label:   getField(row, 'label', 'display', 'name') || getField(row, 'bank'),
      name:    getField(row, 'bank name', 'bank'),
      account: getField(row, 'account', 'a/c', 'acc', 'number'),
      ifsc:    getField(row, 'ifsc'),
      branch:  getField(row, 'branch')
    })).filter(b => b.name || b.label);

    res.set('Cache-Control', 'public, max-age=300');
    res.json(banks);
  } catch(err) {
    console.error('[/api/banks]', err.message);
    // Return a sensible default so the UI still works
    res.json([{
      label:   'Punjab National Bank',
      name:    'Punjab National Bank',
      account: '01444011000328',
      ifsc:    'PUNB0014410',
      branch:  'South Extension, New Delhi'
    }]);
  }
});

// ── GET /api/image-proxy ──────────────────────────────────────────────────────
app.get('/api/image-proxy', async (req, res) => {
  const imageUrl = req.query.url;
  if (!imageUrl) return res.status(400).json({ error: 'Missing url param' });
  try {
    const response = await fetch(imageUrl, { timeout: 8000 });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const contentType = response.headers.get('content-type') || 'image/jpeg';
    const buffer      = await response.buffer();
    res.set('Cache-Control', 'public, max-age=3600');
    res.json({ dataUrl: `data:${contentType};base64,${buffer.toString('base64')}` });
  } catch(err) {
    console.error('[/api/image-proxy]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/save-quotation ──────────────────────────────────────────────────
// Uploads PDF to Google Drive, appends row to History tab
app.post('/api/save-quotation', async (req, res) => {
  const { pdfBase64, fileName, salesPerson, opfNumber, date } = req.body;
  if (!pdfBase64 || !fileName)
    return res.status(400).json({ error: 'Missing pdfBase64 or fileName' });

  const missing = [];
  if (!DRIVE_FOLDER_ID)                          missing.push('GOOGLE_DRIVE_FOLDER_ID');
  if (!SHEET_ID || SHEET_ID.includes('YOUR_'))   missing.push('GOOGLE_SHEET_ID');
  if (missing.length)
    return res.status(503).json({ error: `Not configured in .env: ${missing.join(', ')}` });

  try {
    const { google } = require('googleapis');
    const auth   = await getAuth();
    const drive  = google.drive({ version:'v3', auth });
    const sheets = google.sheets({ version:'v4', auth });

    // 1. Upload PDF to Google Drive ─────────────────────────────────────────
    // supportsAllDrives:true is REQUIRED for Shared Drives.
    // This resolves "Service Accounts do not have storage quota" error.
    const readable = Readable.from(Buffer.from(pdfBase64, 'base64'));
    const driveRes = await drive.files.create({
      supportsAllDrives: true,
      requestBody: {
        name:     fileName,
        parents:  [DRIVE_FOLDER_ID],
        mimeType: 'application/pdf'
      },
      media: { mimeType: 'application/pdf', body: readable },
      fields: 'id,webViewLink'
    });

    const fileId      = driveRes.data.id;
    const webViewLink = driveRes.data.webViewLink;

    // 2. Make file viewable by anyone with the link ─────────────────────────
    await drive.permissions.create({
      fileId,
      supportsAllDrives: true,
      requestBody: { role: 'reader', type: 'anyone' }
    });

    // 3. Append row to History tab ──────────────────────────────────────────
    const today = date || new Date().toLocaleDateString('en-IN', {
      day: '2-digit', month: 'short', year: 'numeric'
    });
    await sheets.spreadsheets.values.append({
      spreadsheetId:    SHEET_ID,
      range:            `'${TAB_HISTORY}'!A:D`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[ today, salesPerson||'', opfNumber||'', '=HYPERLINK("' + webViewLink + '","View PDF")' ]]
      }
    });

    console.log(`[save-quotation] ✓ ${fileName} → ${fileId}`);
    res.json({ success: true, driveLink: webViewLink, fileId });

  } catch(err) {
    console.error('[/api/save-quotation]', err.message);
    let msg = err.message;
    if (msg.includes('storage quota'))
      msg = 'Drive storage quota error. Your Drive folder must be inside a Shared Drive, AND the service account email must be added as a Member (Content Manager or above) of that Shared Drive.';
    else if (msg.includes('404'))
      msg = 'Drive folder or Sheet not found (404). Verify GOOGLE_DRIVE_FOLDER_ID and GOOGLE_SHEET_ID.';
    else if (msg.includes('403') || msg.includes('Permission'))
      msg = 'Permission denied (403). Share both the Drive folder and the Google Sheet with the service account email as Editor.';
    else if (msg.toLowerCase().includes('history'))
      msg = `Could not write to "${TAB_HISTORY}" tab. Make sure that tab exists in your Google Sheet.`;
    res.status(500).json({ error: msg });
  }
});

// ── Catch-all SPA ─────────────────────────────────────────────────────────────
app.get('*', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
);

app.listen(PORT, () => {
  const ok  = v => (v && !v.includes('YOUR_')) ? '✅' : '⚠️ ';
  const key = fs.existsSync(KEY_FILE) || !!process.env.GOOGLE_CREDENTIALS;
  console.log(`\n🛋  Little Nap Recliners — Quotation Generator`);
  console.log(`   http://localhost:${PORT}`);
  console.log(`   Sheet ID:  ${ok(SHEET_ID)}${SHEET_ID || 'not set'}`);
  console.log(`     → Products tab : "${TAB_PRODUCTS}"`);
  console.log(`     → Banks tab    : "${TAB_BANKS}"`);
  console.log(`     → History tab  : "${TAB_HISTORY}"`);
  console.log(`   Drive:     ${DRIVE_FOLDER_ID ? '✅' : '⚠️ '}${DRIVE_FOLDER_ID || 'not set'}`);
  console.log(`   Auth:      ${key ? '✅ credentials found' : '⚠️  service-account-key.json not found'}\n`);
});
