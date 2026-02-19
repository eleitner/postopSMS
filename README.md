# PostOp SMS Protocol — TidalHealth Pilot

Post-discharge SMS recovery screening for surgical patients. Automated check-ins at 6 clinically timed timepoints (POD 0, 2, 5, 14, 21, 30) with AI-assisted triage and nurse alert routing.

## Architecture

```
Patient (SMS) ←→ Twilio ←→ Express Server ←→ PostgreSQL
                                ↓
                     De-identify → Claude API → Re-identify
                                ↓
                         Nurse Dashboard
                         (alerts + analytics)
```

**HIPAA boundary:** The AI layer never sees patient identifiers. All data sent to Claude is stripped of name, phone, DOB, MRN via the `deidentify.js` module. The server maps responses back to patients using short-lived session tokens.

## Quick Start (Demo Mode)

```bash
# Clone and install
npm install

# Start PostgreSQL (Docker)
docker compose up db -d

# Run migrations
cp .env.example .env
# Edit .env: set DATABASE_URL, set DEMO_MODE=true
npm run migrate

# Start server
npm run dev

# Dashboard: http://localhost:3000/dashboard
# First visit: POST /api/auth/setup to create admin user
```

## Production Deployment

### Prerequisites

1. **Twilio HIPAA-eligible account** — Request BAA through Twilio console (self-serve, ~days)
2. **PostgreSQL 14+** with SSL enabled
3. **Anthropic API key** — No BAA needed (data is de-identified before API call)
4. **Domain + TLS certificate** (Twilio requires HTTPS for webhooks)

### Deploy

```bash
# Set environment variables
cp .env.example .env
# Fill in all values — especially:
#   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER
#   TRIAGE_NURSE_PHONE
#   ANTHROPIC_API_KEY
#   JWT_SECRET (generate: node -e "console.log(require('crypto').randomBytes(64).toString('hex'))")
#   DATABASE_URL

# Docker deployment
docker compose up -d

# Run migrations
docker compose exec app npm run migrate

# Create admin user
curl -X POST http://localhost:3000/api/auth/setup \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@tidalhealth.org","password":"CHANGE_ME","name":"Admin"}'
```

### Configure Twilio Webhooks

In your Twilio console, set the webhook URLs for your phone number:

- **Incoming Messages:** `https://your-domain.com/api/sms/inbound` (POST)
- **Status Callback:** `https://your-domain.com/api/sms/status` (POST)

## API Reference

### Auth
- `POST /api/auth/setup` — Create initial admin (works once)
- `POST /api/auth/login` — Returns JWT token
- `POST /api/auth/users` — Create users (admin only)

### Patients
- `POST /api/patients` — Enroll patient (requires auth)
- `GET /api/patients` — List patients
- `GET /api/patients/:id` — Patient detail + timeline

### Dashboard
- `GET /api/dashboard/alerts?status=open` — Open alerts
- `PATCH /api/dashboard/alerts/:id` — Acknowledge/resolve
- `GET /api/dashboard/stats` — Aggregate QI metrics

### SMS (Twilio webhooks)
- `POST /api/sms/inbound` — Inbound patient messages
- `POST /api/sms/status` — Delivery status callbacks

### System
- `GET /health` — Health check
- `GET /dashboard` — Nurse triage dashboard

## Enrolling a Patient

```bash
curl -X POST https://your-domain.com/api/patients \
  -H 'Authorization: Bearer YOUR_JWT' \
  -H 'Content-Type: application/json' \
  -d '{
    "firstName": "Margaret",
    "lastName": "Thompson",
    "phone": "+13015551234",
    "surgeonName": "Dr. Patel",
    "procedure": "Laparoscopic Cholecystectomy",
    "surgeryDate": "2026-02-19",
    "preSurgicalGoal": "eat without pain and get back to gardening",
    "asaClass": 2,
    "age": 67
  }'
```

The scheduler will automatically trigger the POD 0 check-in at 6 PM on the surgery date.

## Check-in Schedule

| POD | Phase | Time | Screening Focus |
|-----|-------|------|-----------------|
| 0 | Evening Safety | 6 PM | Pain, bleeding, fluids, mental clarity, urination |
| 2 | Acute | 10 AM | Pain, fluids, bleeding, sedation, opioid count, ambulation |
| 5 | Infectious | 10 AM | SSI signs, DVT, bowel, fever, pain trend, opioids |
| 14 | Late | 10 AM | Wound dehiscence, seroma, opioid status, wound closure |
| 21 | Recovery | 10 AM | Pain trend, opioid status, driving, PHQ-2 depression screen |
| 30 | Closure | 10 AM | Satisfaction, regret, opioids, complications, goal attainment |

## HIPAA & De-identification

**No PHI ever leaves the database via any external channel.** Three layers enforce this:

### 1. AI Layer — De-identified
The `src/utils/deidentify.js` module strips all identifiers before Claude API calls. The AI sees `"SESSION_7f3a, POD 5, lap chole, fever 101.8"` — never a name or phone. A secondary `assertNoPHI()` check blocks the call entirely if identifiers leak through.

### 2. Dashboard — De-identified
The web dashboard shows only short patient IDs (e.g., `7f3a1b2c...`), procedure type, surgeon, POD, and clinical data. No names, no phone numbers, no DOB. Surgeons and residents can review trajectories and alert history without accessing PHI.

### 3. Clinician Switchboard — Relay, Not Directory
When a clinician needs to contact a patient, the system acts as a relay. PHI never appears on any screen or in any text message to the clinician.

**Commands** (text to the Twilio number from an authorized phone):

| Command | What happens |
|---------|-------------|
| `TEXT 7f3a1b2c Please call the office` | System forwards the message to the patient from the Twilio number. Patient sees it from their care team. |
| `STATUS 7f3a1b2c` | Returns de-identified clinical summary (procedure, POD, AI severity, open alerts). No name/phone. |
| `LIST` | Active patient count + open alert counts. De-identified. |
| `CMDS` | Command help. |

Only phones listed in `AUTHORIZED_CLINICIAN_PHONES` (plus the triage nurse phone) can use these commands. Unauthorized numbers get no response — the commands' existence isn't revealed.

**Nurse triage alerts** sent via SMS to the triage nurse DO contain patient identity (name, phone, procedure). The nurse needs to know who to call. This is clinician-to-clinician communication over a HIPAA-covered channel (Twilio BAA).

## File Structure

```
postop-sms/
├── src/
│   ├── index.js                 # Express server
│   ├── routes/
│   │   ├── sms.js               # Twilio webhooks
│   │   ├── patients.js          # Enrollment API
│   │   └── dashboard.js         # Alerts + analytics + auth
│   ├── services/
│   │   ├── protocols.js         # 6-phase screening logic
│   │   ├── session-manager.js   # SMS conversation engine
│   │   ├── twilio.js            # Twilio wrapper + audit
│   │   ├── ai-triage.js         # De-identified Claude integration
│   │   └── scheduler.js         # Hourly cron for check-ins
│   ├── middleware/
│   │   └── auth.js              # JWT auth
│   └── utils/
│       ├── db.js                # PostgreSQL pool + audit
│       ├── deidentify.js        # PHI stripping (HIPAA boundary)
│       └── logger.js            # Winston logger
├── dashboard/
│   └── index.html               # Nurse triage dashboard (SPA)
├── migrations/
│   └── run.js                   # Database schema
├── docker-compose.yml
├── Dockerfile
└── .env.example
```
