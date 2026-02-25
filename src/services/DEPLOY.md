# Procedure Config Wiring + PT/OT + Wound Photo Vision — Deploy Guide

## What This Adds

### 1. Procedure-Aware Opioid Alerts
Before: "Still on opioids at POD 14" → MONITOR alert for everyone.
After: System checks the patient's procedure type:
- **Lap chole at POD 14 on opioids** → URGENT (expected window is 3 days)
- **Total knee at POD 14 on opioids** → Suppressed (expected window is 14 days)
- **Total knee at POD 25 on opioids** → MONITOR (approaching 21-day warning threshold)
- **Total knee at POD 35 on opioids** → URGENT (past 30-day alert threshold)

All 13 procedure types from procedure-config.js are now active.
Surgeon overrides (JSONB on surgeons table) still work — they take priority over defaults.

### 2. PT/OT Conditional Questions
Ortho procedures (TKR, THR, rotator cuff, ACL, spinal fusion) now get extra questions:

**POD 14 (Late phase):**
- "Have you started physical therapy yet?" (Yes/No)
- If yes: "Any trouble getting to PT or doing exercises at home?"
- Alert if PT not started and past expected window

**POD 21 (Recovery phase):**
- "How is physical therapy going?" (Great / OK / Struggling / Haven't started)
- URGENT alert if PT still not started by POD 21
- MONITOR alert if patient reporting difficulty

Non-ortho patients (lap chole, hernia, colectomy, etc.) never see these questions.

### 3. Wound Photo Vision (Claude Vision API)
When a patient texts a photo:
- System fetches the image from Twilio (authenticated)
- Sends to Claude vision API with wound-specific analysis prompt
- AI generates structured findings (redness, drainage, swelling, wound edges, concern level)
- Patient gets a warm acknowledgment (never told what AI sees)
- Nurse gets the full AI analysis in the alert with structured findings
- ALL photos are escalated to nurse — AI does not make clinical decisions

## Files Modified
- `src/services/session-manager.js` — Procedure-aware opioid override + conditional question skipping
- `src/services/protocols.js` — PT/OT conditional questions in late + recovery phases
- `src/services/conversation-handler.js` — callVisionAI + fetchImageAsBase64

## Deploy

In PowerShell from your postop-sms folder:

```powershell
Copy-Item procedure-ptot-vision\session-manager.js src\services\
Copy-Item procedure-ptot-vision\protocols.js src\services\
Copy-Item procedure-ptot-vision\conversation-handler.js src\services\
Copy-Item procedure-ptot-vision\procedure-config.js src\services\

git add -A
git commit -m "Procedure-aware opioid alerts, PT/OT questions, wound photo vision, OPEN-aligned configs"
git push
```

No new migration needed — these are code-only changes.
