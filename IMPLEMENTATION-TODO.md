# SurgHome — Implementation To-Do

## Current State
- **Deployed on Render:** Basic protocol engine, session manager, AI triage, dashboard shell
- **On GitHub but NOT deployed:** Dashboard rebuild, bug fixes (commit `b248d0e`)
- **Built locally, NOT on GitHub:** Surgeon infra, PHI scrubber, conversation handler, mini-assessments, nurse templates, procedure configs, consent page
- **Twilio:** Toll-free number acquired, verification pending (1-3 business days)

---

## STEP 1: Push Existing Code to GitHub
Everything below is already built and sitting in your local repo. Git shows it as modified/untracked. This is one commit.

```powershell
cd C:\Users\evanl\postop-sms

# If your local repo doesn't have these files yet, copy from Claude outputs:
# (Skip any you already have locally)

# From surgeon-infra build:
# NEW FILES:
#   src/routes/surgeons.js
#   src/services/phi-scrubber.js
#   src/services/conversation-handler.js
#
# MODIFIED FILES (replace existing):
#   src/index.js
#   src/routes/sms.js
#   src/routes/patients.js
#   src/routes/dashboard.js
#   src/services/twilio.js
#   src/services/session-manager.js
#   src/services/protocols.js
#   src/services/scheduler.js
#   migrations/run.js
#   dashboard/index.html

# From mini-assessment build:
# NEW FILES:
#   src/services/procedure-config.js
#   src/services/mini-assessments.js
#   src/services/nurse-templates.js
#   src/routes/alerts.js
#   migrations/003-mini-assessments.js
#   public/consent.html
#
# MODIFIED FILES (replace existing — these include BOTH surgeon-infra AND mini-assessment changes):
#   src/index.js              <- use mini-assessment-build version (includes both updates)
#   src/services/session-manager.js  <- use mini-assessment-build version
#   src/services/scheduler.js        <- use mini-assessment-build version
```

### Copy order matters — mini-assessment-build versions of shared files are newer:
```powershell
# 1. Copy surgeon-infra files first
copy surgeon-infra\surgeons.js           src\routes\
copy surgeon-infra\phi-scrubber.js       src\services\
copy surgeon-infra\conversation-handler.js src\services\
copy surgeon-infra\twilio.js             src\services\
copy surgeon-infra\protocols.js          src\services\
copy surgeon-infra\sms.js               src\routes\
copy surgeon-infra\patients.js           src\routes\
copy surgeon-infra\dashboard.js          src\routes\
copy surgeon-infra\run.js               migrations\
copy surgeon-infra\index.html           dashboard\

# 2. Then copy mini-assessment-build files (overwrites shared files with newer versions)
copy mini-assessment-build\src\services\procedure-config.js   src\services\
copy mini-assessment-build\src\services\mini-assessments.js   src\services\
copy mini-assessment-build\src\services\nurse-templates.js    src\services\
copy mini-assessment-build\src\routes\alerts.js               src\routes\
copy mini-assessment-build\migrations\003-mini-assessments.js migrations\
copy mini-assessment-build\public\consent.html                public\
copy mini-assessment-build\src\index.js                       src\
copy mini-assessment-build\src\services\session-manager.js    src\services\
copy mini-assessment-build\src\services\scheduler.js          src\services\

# 3. Commit and push
git add -A
git commit -m "Surgeon infra, PHI scrubber, conversation AI, mini-assessments, nurse templates, procedure configs, consent page"
git push
```

### Post-push verify:
- Render auto-deploys from GitHub
- Check Render logs for migration success (surgeons table, conversation_log, mini_assessments, nurse_dispositions, scheduled_followups)
- Hit `https://postopsms.onrender.com/health` — should return healthy
- Hit `https://postopsms.onrender.com/consent.html` — should show consent page

---

## STEP 2: Set Twilio Env Vars on Render
Once toll-free verification clears:

```
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_FROM_NUMBER=+18xxxxxxxxxx
DEMO_MODE=false
TRIAGE_NURSE_PHONE=+1xxxxxxxxxx
ANTHROPIC_API_KEY=sk-ant-xxxxx
```

Also set Twilio webhook URLs (if not already done):
- Inbound: `https://postopsms.onrender.com/api/sms/inbound` (POST)
- Status: `https://postopsms.onrender.com/api/sms/status` (POST)

---

## STEP 3: Build Nurse SMS Disposition Flow (NOT YET BUILT)
This is the #1 blocker for real clinical use. The templates and logic exist but nurses can't act on alerts via SMS yet.

**What needs to happen:**
- Nurse gets enriched alert SMS with numbered options (e.g., "Reply 1: Reassure, 2: Monitor+Photo, 3: Office Visit, 4: Callback")
- Nurse replies with a number
- System sends the corresponding template message to the patient
- Disposition logged to DB
- Auto-follow-ups scheduled if applicable

**Where it hooks in:**
- `src/services/twilio.js` → `sendNurseAlert()` needs to append disposition options
- `src/services/session-manager.js` → clinician command handler needs to recognize disposition replies
- `src/services/nurse-templates.js` → `sendDisposition()` already works, just needs SMS trigger

---

## STEP 4: Wire Procedure Config into Protocol Alerts (NOT YET BUILT)
The procedure-config module exists with all 13 procedure types, but the protocol alert triggers still use hardcoded thresholds.

**What needs to happen:**
- Opioid alerts at POD 14/21/30 should check procedure-specific expected duration instead of "still on opioids = MONITOR/URGENT"
- Activity questions should compare against procedure-specific milestone tiers
- On patient enrollment, system infers procedure config and sets `pt_ot_expected`

---

## STEP 5: Add PT/OT Screening Questions (NOT YET BUILT)
Mini-assessment for PT/OT barriers exists, but no screening questions trigger it.

**What needs to happen:**
- Late phase (POD 14) and Recovery phase (POD 21): conditionally add "Have you started PT?" and "Doing your home exercises?" for procedures where `ptOtExpected = true`
- Protocol question injection based on patient's procedure config
- Negative responses trigger the PT/OT barriers mini-assessment

---

## STEP 6: Wound Photo AI Vision (NOT YET BUILT)
MMS infrastructure exists (EXIF stripping, media URL extraction, nurse alert with photo attached). Claude never actually looks at the image.

**What needs to happen:**
- In conversation handler, when `mediaUrls` present, pass image to Claude vision API
- AI provides preliminary wound assessment (not diagnosis — just structured observation)
- Observation included in nurse alert alongside the image

---

## STEP 7: Dashboard Front-End for Rounding (NOT YET BUILT)
Dashboard shell exists but doesn't show mini-assessment data, disposition history, or procedure-config-aware views.

**What it should show (de-identified):**
- All active patients: procedure, POD, last check-in status, open alerts
- Aggregate pain trajectories by procedure type
- Opioid cessation curves by procedure type
- Alert volume and disposition patterns
- Mini-assessment completion rates
- PHQ-2 screen rates and positivity

---

## STEP 8: Tests (NOT YET BUILT)
At minimum before real patients:
- Inbound message → alert → mini-assessment → disposition → patient response
- Emergency keyword detection
- PHI scrubber catches names, DOBs, phones
- Procedure config matching (fuzzy)
- Session expiration
- STOP/HELP handling

---

## What's NOT on this list (future / Phase 2)
- Daily-light protocol cadence (POD 1-7 daily with 2-3 questions)
- Clinical guideline fallback (ACS/AHRQ when surgeon instructions missing)
- Conversation handler multi-turn memory
- AIMS intraoperative data linkage (Phase 2 / IRB required)
- OMOP mapping, deidentification pipeline, geographic enrichment
- Mobile app (SMS is the product)
