# Vagal Circuit Tracker - Setup

## Deploy

Drop `index.html` into your repo at the path that maps to `SurgHome.com/michelleVNS/`.

## Google Sheets Setup (5 minutes)

1. Create a new Google Sheet. Name it "Michelle VNS Tracker" or whatever.

2. Go to **Extensions > Apps Script**.

3. Delete the default code. Paste the contents of `apps-script.js`.

4. Click **Deploy > New deployment**.

5. Settings:
   - Type: **Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**

6. Click **Deploy**. Authorize when prompted.

7. Copy the **Web app URL** (looks like `https://script.google.com/macros/s/XXXXX/exec`).

8. Open `index.html` and paste the URL into the `SHEET_URL` constant near the top:
   ```js
   const SHEET_URL = 'https://script.google.com/macros/s/XXXXX/exec';
   ```

9. Commit and push.

## How It Works

- All data saves to localStorage in her browser (works offline, instant)
- Every submit also POSTs to your Google Sheet (durable backup you can see)
- The Sheet auto-creates three tabs: Checkins, Assessments, Events
- If Sheets sync fails (offline, etc), data is still saved locally
- She can export all local data as JSON from the home screen

## Protocol

8-week dose escalation built into the app:

| Week | Dose | Notes |
|------|------|-------|
| 1-2 | 30 min/day | Tolerance building |
| 3 | 1 hr/day | First escalation |
| 4 | 1-2 hrs/day | Assessment due |
| 5 | 2-3 hrs/day | Extended sessions |
| 6 | 3-4 hrs/day | Use EverCharge |
| 7 | 4+ hrs/day | Target maintenance |
| 8 | 4+ hrs/day | Assessment due |

## Files

- `index.html` - The tracker (single file, no dependencies beyond Google Fonts)
- `apps-script.js` - Paste into Google Sheets Apps Script editor
- `SETUP.md` - This file
