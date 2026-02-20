# PostOp SMS — Build Update

## Files Changed (5)

### 1. `dashboard/index.html` — REBUILT
- Tab navigation: Alerts | Patients | Analytics | Enroll | Export
- Patient list with journey progress dots (phases completed)
- Patient detail panel: timeline, pain bar chart, opioid status, AI summaries, alerts
- Enrollment form (web-based, in addition to SMS)
- CSV export buttons for 6 data types
- Alert management: filter by status, acknowledge, resolve
- Manual check-in trigger per patient (with phase selector)

### 2. `src/routes/dashboard.js` — REBUILT
- `GET /api/dashboard/patients` — patient list with journey progress
- `GET /api/dashboard/patients/:id` — full journey detail (sessions, responses, alerts, trajectories)
- `POST /api/dashboard/trigger` — manual check-in trigger (admin only, auth required)
- `GET /api/dashboard/export/:type` — CSV exports (responses, pain, opioids, alerts, patients, sessions)
- Existing endpoints preserved (alerts, stats, auth)

### 3. `src/services/scheduler.js` — BUG FIX
- Fixed: `today.getHours()` → Eastern timezone conversion
- Server runs UTC; scheduler now correctly evaluates 6 PM / 10 AM in Eastern

### 4. `src/routes/patients.js` — BUG FIX
- Fixed: "Dr. Dr. Patel" — strips "Dr." prefix from surgeon name on enrollment

### 5. `src/services/session-manager.js` — BUG FIX
- Fixed: "Dr. Dr. Patel" — strips "Dr." prefix in SMS enrollment command too
