# Little Nap Recliners — Quotation Generator

## Quick Start
```
npm install
npm start
# Open http://localhost:3000
```

---

## Google Sheet Setup (single sheet, 3 tabs)

### Tab 1: `Product list`
| Category | Model Name | Unit Price (Rs.) | Image |
|----------|------------|-----------------|-------|
| Motorized | Ritz Slider-PU | 45000 | https://... |

### Tab 2: `Banks`
| Label | Bank Name | Account Number | IFSC | Branch |
|-------|-----------|----------------|------|--------|
| PNB – South Ext. | Punjab National Bank | 01444011000328 | PUNB0014410 | South Extension, New Delhi |

### Tab 3: `History`
| Date | Sales Person | OPF Number | PI Link |
|------|-------------|------------|---------|
(auto-filled by the app — just create the tab with these headers)

---

## Google Service Account Setup

### 1. Create a Service Account
1. Go to https://console.cloud.google.com → create or select a project
2. **APIs & Services → Enable APIs**: Google Drive API, Google Sheets API
3. **APIs & Services → Credentials → Create Credentials → Service Account**
4. Click the service account → **Keys → Add Key → JSON** → Download
5. Rename the file to `service-account-key.json` and place it in this folder

### 2. Share the Google Sheet with the service account
- Open your Google Sheet → **Share**
- Paste the service account email (`xxx@xxx.iam.gserviceaccount.com`)
- Role: **Editor** → Share

### 3. Share the Google Drive folder with the service account
The Drive folder MUST be a Shared Drive (Team Drive) to work with service accounts.

**Option A (recommended) — Use a Shared Drive:**
1. Create a Shared Drive in Google Drive
2. Add the service account email as a **Member** with **Content Manager** role
3. Create a folder inside the Shared Drive for PDFs
4. Copy the folder ID from the URL

**Option B — Regular "My Drive" folder:**
- Share the folder with the service account email as **Editor**
- This works but may have quota limitations

### 4. Configure .env
```
GOOGLE_SHEET_ID=your_sheet_id_from_url
GOOGLE_DRIVE_FOLDER_ID=your_drive_folder_id
```

---

## Deployment (Railway / Render / Fly.io)
1. Push to GitHub
2. Connect to Railway/Render
3. Set environment variables:
   - `GOOGLE_SHEET_ID`
   - `GOOGLE_DRIVE_FOLDER_ID`
   - `GOOGLE_CREDENTIALS` — paste the entire `service-account-key.json` content as one line
4. Set `PORT` if required by the platform
