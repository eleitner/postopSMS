# Nurse SMS Disposition Flow — Deploy Guide

## What This Adds

Nurses can now respond to alerts entirely via SMS. No browser needed.

### The Flow
1. Patient triggers an alert (pain >7, SSI signs, fever, etc.)
2. Nurse gets an SMS with the alert details + numbered options:
   ```
   ⚠️ POSTOP ALERT [URGENT]
   Patient: Margaret Thompson | POD 5
   Procedure: Lap Chole (Dr. Patel)
   Issue: Possible SSI: redness/discharge
   
   ACTION: Callback within 2 hours.
   
   Reply with a number:
   1. Reassure & Watch
   2. Monitor & Follow Up
   3. Office Visit
   4. ED / Same-Day Eval
   5. Callback Requested
   
   Or reply NOTE <text> to add a note.
   ```
3. Nurse replies `2` → system sends the "Monitor & Follow Up" template to the patient, auto-schedules a 48h photo request
4. Nurse gets confirmation: `✓ Sent "Monitor & Follow Up" to Margaret Thompson. Auto follow-up scheduled: photo_request in 48h.`

### Nurse Commands
| Command | Example | What it does |
|---------|---------|-------------|
| `1`-`9` | `2` | Quick reply — fires disposition on most recent alert |
| `2 NOTE redness improving` | | Disposition + free-text note appended |
| `NOTE checked with Dr. Patel` | | Add note without choosing disposition |
| `ALERTS` | | List all open alerts with IDs |
| `REPLY abc123 2` | | Target a specific alert by ID prefix |
| `REPLY abc123 3 NOTE seen in office` | | Explicit alert + disposition + note |

### Files Modified
- `src/services/twilio.js` — `sendNurseAlert` now includes numbered options, tracks pending reply
- `src/services/session-manager.js` — New `handleNurseDispositionReply` routes nurse number-replies to dispositions
- `src/services/scheduler.js` — Cleans up expired pending replies (>24h)
- `migrations/run.js` — Added `nurse_pending_replies` table (idempotent)
- `migrations/004-nurse-pending-replies.js` — Standalone migration file

### New Table
```sql
nurse_pending_replies (
  nurse_phone     TEXT PRIMARY KEY,   -- one pending alert per nurse
  alert_id        UUID REFERENCES alerts(id),
  template_key    TEXT NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW()
)
```

## Deploy Steps

```bash
cd ~/postop-sms

# Copy files
cp nurse-disposition-flow/twilio.js           src/services/
cp nurse-disposition-flow/session-manager.js  src/services/
cp nurse-disposition-flow/scheduler.js        src/services/
cp nurse-disposition-flow/run.js              migrations/
cp nurse-disposition-flow/004-nurse-pending-replies.js  migrations/

# Push
git add -A
git commit -m "Nurse SMS disposition flow — reply 1/2/3 to alerts"
git push

# Migration runs on next deploy (idempotent in run.js)
# Or run standalone: node migrations/004-nurse-pending-replies.js
```

## Testing (works in demo mode)

1. Set your phone as `TRIAGE_NURSE_PHONE` in Render env
2. Enroll a test patient: `ENROLL Test Patient +15551234567 Patel Lap Chole`
3. Trigger a check-in and give pain >7 → you'll get an alert with numbered options
4. Reply `1` → patient gets the "Reassure & Adjust" template
5. Reply `ALERTS` → see all open alerts
6. Reply `REPLY <id> 3` → target a specific alert

## What's NOT in this build
- Dashboard UI for dispositions (API routes already exist from last session)
- Nurse auth beyond phone number matching (fine for pilot)
- Multi-nurse routing for the same alert (first responder wins)
