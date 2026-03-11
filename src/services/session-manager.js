/**
 * Session Manager — SMS Conversation Engine
 * 
 * Handles the stateful question-by-question flow for each patient.
 * Manages: inbound message routing, response parsing, alert detection,
 * session advancement, and check-in completion with AI triage.
 */
const { pool, audit } = require('../utils/db');
const { PROTOCOLS, parseResponse, isEmergency, getPhaseForPOD } = require('./protocols');
const { sendSMS, logInbound, sendNurseAlert } = require('./twilio');
const { triageSession } = require('./ai-triage');
const { handleConversation } = require('./conversation-handler');
const { selectAssessment, startMiniAssessment, processMiniAssessmentResponse, getActiveMiniAssessment } = require('./mini-assessments');
const { getConfigForPatient } = require('./procedure-config');
const { isSelfEnrollmentTrigger, hasActiveEnrollmentSession, handleSelfEnrollment } = require('./self-enrollment');
const { getPriorResponses, buildGreeting, personalizeQuestion, buildClosing } = require('./empathic-greetings');
const logger = require('../utils/logger');

// ═══════════════════════════════════════════════════
// NURSE DISPOSITION REPLY HANDLER
// ═══════════════════════════════════════════════════
// When a nurse gets an alert SMS with numbered options and replies "2",
// this routes it to the correct alert and fires the matching disposition.
// Also handles: "NOTE <text>" to add a free-text note to the disposition.
// Also handles: "ALERTS" to list all open alerts for the nurse.

async function handleNurseDispositionReply(phone, body) {
  // Only check authorized clinician phones
  if (!isAuthorizedClinician(phone)) return null;

  const trimmed = body.trim();
  const upper = trimmed.toUpperCase();

  // ── "ALERTS" command — list all open alerts needing disposition ──
  if (upper === 'ALERTS') {
    return await cmdNurseAlertsList(phone);
  }

  // ── REPLY <alert-id-prefix> <number> — explicit alert targeting ──
  const replyMatch = upper.match(/^REPLY\s+([A-F0-9]{4,})\s+(\d+)$/i);
  if (replyMatch) {
    return await handleExplicitReply(phone, replyMatch[1], parseInt(replyMatch[2]), null);
  }

  // ── REPLY <alert-id-prefix> <number> NOTE <text> ──
  const replyNoteMatch = trimmed.match(/^REPLY\s+([A-Fa-f0-9]{4,})\s+(\d+)\s+NOTE\s+(.+)$/i);
  if (replyNoteMatch) {
    return await handleExplicitReply(phone, replyNoteMatch[1], parseInt(replyNoteMatch[2]), replyNoteMatch[3].trim());
  }

  // ── Simple number reply (1-9) — targets most recent pending alert ──
  const numMatch = trimmed.match(/^(\d)$/);
  if (numMatch) {
    return await handleQuickReply(phone, parseInt(numMatch[1]), null);
  }

  // ── Number + NOTE: "2 NOTE patient says redness improving" ──
  const numNoteMatch = trimmed.match(/^(\d)\s+NOTE\s+(.+)$/i);
  if (numNoteMatch) {
    return await handleQuickReply(phone, parseInt(numNoteMatch[1]), numNoteMatch[2].trim());
  }

  // ── Just "NOTE <text>" — add note to most recent pending alert without disposition ──
  const noteOnlyMatch = trimmed.match(/^NOTE\s+(.+)$/i);
  if (noteOnlyMatch) {
    return await handleNoteOnly(phone, noteOnlyMatch[1].trim());
  }

  // Not a disposition reply — fall through
  return null;
}

/**
 * Quick reply: nurse texts "2" → fires disposition #2 on their most recent pending alert
 */
async function handleQuickReply(phone, number, nurseNote) {
  const { getNursePendingAlert, clearNursePendingAlert, sendSMS: twilioSend } = require('./twilio');
  const { getTemplatesForAlert, sendDisposition } = require('./nurse-templates');

  const pending = await getNursePendingAlert(phone);
  if (!pending) return null; // No pending alert — fall through to other handlers

  // Load patient
  const patientResult = await pool.query('SELECT * FROM patients WHERE id = $1', [pending.patient_id]);
  if (patientResult.rows.length === 0) {
    await twilioSend(phone, 'Alert patient not found. Use ALERTS to see open alerts.');
    return { handled: true, type: 'nurse_reply_error' };
  }
  const patient = patientResult.rows[0];

  // Get templates
  const templates = getTemplatesForAlert(inferAlertTypeForReply(pending));
  const dispositionIndex = number - 1;

  if (dispositionIndex < 0 || dispositionIndex >= templates.dispositions.length) {
    await twilioSend(phone, `Invalid option. Reply 1-${templates.dispositions.length}:\n${templates.dispositions.map((d, i) => `${i + 1}. ${d.label}`).join('\n')}`);
    return { handled: true, type: 'nurse_reply_invalid' };
  }

  const disposition = templates.dispositions[dispositionIndex];
  const alert = { id: pending.alert_id, severity: pending.severity, reason: pending.reason };

  // Fire the disposition — sends template message to patient
  const result = await sendDisposition(patient, alert, templates.templateKey, disposition.key, nurseNote);

  if (result?.sent) {
    await clearNursePendingAlert(phone);
    let confirmMsg = `✓ Sent "${disposition.label}" to ${patient.first_name} ${patient.last_name}.`;
    if (disposition.autoFollowUp) {
      confirmMsg += `\nAuto follow-up scheduled: ${disposition.autoFollowUp.type} in ${disposition.autoFollowUp.hours}h.`;
    }
    if (nurseNote) {
      confirmMsg += `\nNote added: "${nurseNote}"`;
    }
    await twilioSend(phone, confirmMsg);
    
    logger.info('Nurse disposition via SMS', {
      nursePhone: phone.slice(-4),
      alertId: pending.alert_id,
      disposition: disposition.key,
      hasNote: !!nurseNote,
    });
    return { handled: true, type: 'nurse_disposition_sent', dispositionKey: disposition.key };
  } else {
    await twilioSend(phone, 'Failed to send disposition. Try again or use the dashboard.');
    return { handled: true, type: 'nurse_reply_error' };
  }
}

/**
 * Explicit reply: nurse texts "REPLY abc123 2" → targets a specific alert by ID prefix
 */
async function handleExplicitReply(phone, alertIdPrefix, number, nurseNote) {
  const { sendSMS: twilioSend, setNursePendingAlert } = require('./twilio');
  const { getTemplatesForAlert, sendDisposition } = require('./nurse-templates');

  // Find the alert
  const alertResult = await pool.query(
    `SELECT a.*, p.* FROM alerts a JOIN patients p ON p.id = a.patient_id 
     WHERE a.id::text LIKE $1 AND a.status IN ('open', 'pending_assessment') LIMIT 1`,
    [alertIdPrefix.toLowerCase() + '%']
  );

  if (alertResult.rows.length === 0) {
    await twilioSend(phone, `No open alert found matching "${alertIdPrefix}". Reply ALERTS to see open alerts.`);
    return { handled: true, type: 'nurse_explicit_reply_miss' };
  }

  const row = alertResult.rows[0];
  const patient = {
    id: row.patient_id, first_name: row.first_name, last_name: row.last_name,
    phone: row.phone, surgeon_name: row.surgeon_name, surgeon_id: row.surgeon_id,
    procedure_name: row.procedure_name,
  };
  const alert = { id: row.id, severity: row.severity, reason: row.reason };

  const alertType = inferAlertTypeForReply(row);
  const templates = getTemplatesForAlert(alertType);
  const dispositionIndex = number - 1;

  if (dispositionIndex < 0 || dispositionIndex >= templates.dispositions.length) {
    await twilioSend(phone, `Invalid option for this alert. Reply 1-${templates.dispositions.length}:\n${templates.dispositions.map((d, i) => `${i + 1}. ${d.label}`).join('\n')}`);
    return { handled: true, type: 'nurse_explicit_reply_invalid' };
  }

  const disposition = templates.dispositions[dispositionIndex];
  const result = await sendDisposition(patient, alert, templates.templateKey, disposition.key, nurseNote);

  if (result?.sent) {
    let confirmMsg = `✓ Sent "${disposition.label}" to ${patient.first_name} ${patient.last_name}.`;
    if (nurseNote) confirmMsg += `\nNote: "${nurseNote}"`;
    await twilioSend(phone, confirmMsg);
    
    logger.info('Nurse explicit disposition via SMS', {
      nursePhone: phone.slice(-4), alertId: row.id, disposition: disposition.key,
    });
    return { handled: true, type: 'nurse_disposition_sent', dispositionKey: disposition.key };
  } else {
    await twilioSend(phone, 'Failed to send disposition. Try again or use the dashboard.');
    return { handled: true, type: 'nurse_reply_error' };
  }
}

/**
 * NOTE only — add a note to the pending alert without choosing a disposition
 */
async function handleNoteOnly(phone, noteText) {
  const { getNursePendingAlert, sendSMS: twilioSend } = require('./twilio');

  const pending = await getNursePendingAlert(phone);
  if (!pending) return null; // No pending alert — fall through

  try {
    await pool.query(
      `UPDATE alerts SET resolution_note = COALESCE(resolution_note, '') || $1 WHERE id = $2`,
      [`\n[Nurse note] ${noteText}`, pending.alert_id]
    );
    await twilioSend(phone, `✓ Note added to alert. Reply with a number (1-5) to send a response to the patient, or ALERTS to see all open alerts.`);
    return { handled: true, type: 'nurse_note_added' };
  } catch (err) {
    logger.error('Failed to add nurse note', { error: err.message });
    return null;
  }
}

/**
 * ALERTS command — list all open alerts for the nurse
 */
async function cmdNurseAlertsList(phone) {
  const { sendSMS: twilioSend, setNursePendingAlert } = require('./twilio');

  const openAlerts = (await pool.query(`
    SELECT a.id, a.severity, a.reason, a.created_at,
           p.first_name, p.last_name, p.procedure_name
    FROM alerts a 
    JOIN patients p ON p.id = a.patient_id
    WHERE a.status IN ('open', 'pending_assessment')
    ORDER BY 
      CASE a.severity WHEN 'CRITICAL' THEN 1 WHEN 'URGENT' THEN 2 WHEN 'MONITOR' THEN 3 ELSE 4 END,
      a.created_at DESC
    LIMIT 10
  `)).rows;

  if (openAlerts.length === 0) {
    await twilioSend(phone, '✓ No open alerts.');
    return { handled: true, type: 'nurse_alerts_list_empty' };
  }

  let msg = `⚠️ ${openAlerts.length} OPEN ALERT(S):\n\n`;
  openAlerts.forEach((a, i) => {
    const idShort = a.id.substring(0, 8);
    const timeSince = Math.round((Date.now() - new Date(a.created_at).getTime()) / 3600000);
    msg += `${i + 1}. [${a.severity}] ${a.first_name} ${a.last_name}\n`;
    msg += `   ${a.procedure_name} · ${a.reason.substring(0, 60)}\n`;
    msg += `   ${timeSince}h ago · ID: ${idShort}\n\n`;
  });

  msg += `Reply: REPLY <id> <#> to respond\nExample: REPLY ${openAlerts[0].id.substring(0, 8)} 1`;

  // Set the most recent alert as the pending target for quick "1/2/3" replies
  if (openAlerts.length > 0) {
    const topAlert = openAlerts[0];
    const alertType = inferAlertTypeForReply(topAlert);
    const { getTemplatesForAlert } = require('./nurse-templates');
    const templates = getTemplatesForAlert(alertType);
    await setNursePendingAlert(phone, topAlert.id, templates.templateKey);
  }

  await twilioSend(phone, msg);
  return { handled: true, type: 'nurse_alerts_list' };
}

/**
 * Infer alert type from a pending reply or alert row for template matching
 */
function inferAlertTypeForReply(row) {
  const reason = (row.reason || '').toLowerCase();
  if (reason.includes('ssi') || reason.includes('redness') || reason.includes('discharge')) return 'redness';
  if (reason.includes('dvt') || reason.includes('leg swell')) return 'leg_swelling';
  if (reason.includes('pain')) return 'pain';
  if (reason.includes('fever')) return 'fever';
  if (reason.includes('opioid')) return 'still_opioids';
  if (reason.includes('phq') || reason.includes('depression')) return 'phq_mood';
  if (reason.includes('dehiscence') || reason.includes('wound_open')) return 'wound_open';
  if (reason.includes('seroma') || reason.includes('fluid_bulge')) return 'fluid_bulge';
  if (reason.includes('photo')) return 'photo';
  if (reason.includes('bleeding')) return 'bleeding';
  return 'conversation';
}

/**
 * Find a patient by phone number (hashed lookup)
 */
async function findPatientByPhone(phone) {
  const crypto = require('crypto');
  const hash = crypto.createHash('sha256').update(phone).digest('hex');
  const result = await pool.query(
    `SELECT * FROM patients WHERE phone_hash = $1 AND status IN ('enrolled', 'active') ORDER BY surgery_date DESC LIMIT 1`,
    [hash]
  );
  return result.rows[0] || null;
}

/**
 * Get the active session for a patient
 */
async function getActiveSession(patientId) {
  const result = await pool.query(
    `SELECT * FROM checkin_sessions WHERE patient_id = $1 AND status = 'active' ORDER BY created_at DESC LIMIT 1`,
    [patientId]
  );
  return result.rows[0] || null;
}

// ═══════════════════════════════════════════════════
// CLINICIAN SWITCHBOARD
// ═══════════════════════════════════════════════════
//
// Design principle: NO PHI leaves the database via SMS.
// The system acts as a relay — clinician never sees patient phone/name.
//
// Commands (authorized phones only):
//   CALL <id>                — Twilio connects a call between clinician and patient
//   TEXT <id> <message>      — System forwards message to patient from Twilio number
//   STATUS <id>              — Returns de-identified clinical summary (no name/phone)
//   LIST                     — Active patients (de-identified) + open alert count
//   HELP                     — Command list
// ═══════════════════════════════════════════════════

/**
 * Authorized clinician phones — the ONLY numbers that can use switchboard commands.
 * Set in .env: AUTHORIZED_CLINICIAN_PHONES=+14105551234,+14105555678
 */
function getAuthorizedPhones() {
  const raw = process.env.AUTHORIZED_CLINICIAN_PHONES || '';
  const phones = raw.split(',').map(p => p.trim()).filter(Boolean);
  // Triage nurse is always authorized
  if (process.env.TRIAGE_NURSE_PHONE && !phones.includes(process.env.TRIAGE_NURSE_PHONE)) {
    phones.push(process.env.TRIAGE_NURSE_PHONE);
  }
  return phones;
}

function isAuthorizedClinician(phone) {
  return getAuthorizedPhones().includes(phone);
}

/**
 * Handle clinician commands. Returns null if not a command (falls through to patient flow).
 */
async function handleClinicianCommand(phone, body) {
  const trimmed = body.trim();
  const upper = trimmed.toUpperCase();

  // Only intercept if it looks like a command
  const isCommand = upper.startsWith('TEXT ') || upper.startsWith('ENROLL ') ||
                    upper.startsWith('STATUS ') || upper === 'LIST' || upper === 'CMDS';
  if (!isCommand) return null;

  // Auth check — if not authorized, silently fall through (don't reveal commands exist)
  if (!isAuthorizedClinician(phone)) return null;

  if (upper === 'CMDS') {
    await sendSMS(phone, [
      '📋 CLINICIAN COMMANDS:',
      'ENROLL First Last +1Phone Surgeon Procedure — Enroll patient',
      'TEXT <id> <msg> — Relay message to patient',
      'STATUS <id> — Clinical summary (no PHI)',
      'LIST — Active patients + alerts',
      'CMDS — This help message',
      '',
      'Patient IDs shown on dashboard. First 8 chars of UUID work.',
    ].join('\n'));
    return { handled: true, type: 'clinician_help' };
  }

  if (upper === 'LIST') return await cmdList(phone);
  if (upper.startsWith('ENROLL ')) return await cmdEnroll(phone, trimmed.substring(7).trim());
  if (upper.startsWith('TEXT ')) return await cmdText(phone, trimmed.substring(5).trim());
  if (upper.startsWith('STATUS ')) return await cmdStatus(phone, trimmed.substring(7).trim());

  return null;
}

/**
 * Find patient by ID prefix (first 8+ chars of UUID)
 */
async function findPatientByIdPrefix(idFragment) {
  if (!idFragment || idFragment.length < 4) return null;
  const result = await pool.query(
    `SELECT * FROM patients WHERE id::text LIKE $1 AND status IN ('enrolled', 'active', 'completed') LIMIT 1`,
    [idFragment.toLowerCase() + '%']
  );
  return result.rows[0] || null;
}

/**
 * ENROLL — Register a new patient via SMS.
 * Format: ENROLL FirstName LastName +1XXXXXXXXXX SurgeonLastName ProcedureName
 * Example: ENROLL Margaret Thompson +13015551234 Patel Lap Chole
 * 
 * Minimal — no goal, no ASA, no age. Those can be added via dashboard later.
 * The point is to make enrollment frictionless at discharge.
 */
async function cmdEnroll(clinicianPhone, rawArgs) {
  // Parse: FirstName LastName +1Phone Surgeon everything-else-is-procedure
  const parts = rawArgs.split(/\s+/);

  if (parts.length < 5) {
    await sendSMS(clinicianPhone, [
      'Usage: ENROLL First Last +1Phone Surgeon Procedure',
      'Example: ENROLL Margaret Thompson +13015551234 Patel Lap Chole',
      '',
      'Phone must be +1XXXXXXXXXX format.',
      'Everything after surgeon name = procedure.',
    ].join('\n'));
    return { handled: true, type: 'clinician_enroll_usage' };
  }

  const firstName = parts[0];
  const lastName = parts[1];
  const phone = parts[2];
  const surgeonName = parts[3].replace(/^Dr\.?\s*/i, '');
  // Everything remaining is the procedure name
  const procedure = parts.slice(4).join(' ');

  // Validate phone
  const cleanPhone = phone.replace(/[^\d+]/g, '');
  if (!/^\+1\d{10}$/.test(cleanPhone)) {
    await sendSMS(clinicianPhone, `Invalid phone: ${phone}. Must be +1XXXXXXXXXX (e.g., +13015551234)`);
    return { handled: true, type: 'clinician_enroll_bad_phone' };
  }

  const crypto = require('crypto');
  const phoneHash = crypto.createHash('sha256').update(cleanPhone).digest('hex');
  const today = new Date().toISOString().split('T')[0];

  try {
    // Check for duplicate
    const existing = await pool.query(
      `SELECT id FROM patients WHERE phone_hash = $1 AND status IN ('enrolled', 'active') AND surgery_date = $2`,
      [phoneHash, today]
    );
    if (existing.rows.length > 0) {
      await sendSMS(clinicianPhone, `Patient already enrolled today (${existing.rows[0].id.substring(0, 8)}...). Use STATUS ${existing.rows[0].id.substring(0, 8)} to check.`);
      return { handled: true, type: 'clinician_enroll_duplicate' };
    }

    const result = await pool.query(
      `INSERT INTO patients (first_name, last_name, phone, phone_hash, surgeon_name, procedure_name, surgery_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, status`,
      [firstName, lastName, cleanPhone, phoneHash, surgeonName, procedure, today]
    );

    const patient = result.rows[0];
    await audit('clinician:' + clinicianPhone.slice(-4), 'patient_enrolled_sms', 'patient', patient.id, {
      procedure, surgeonName, method: 'sms_enrollment',
    });

    logger.info('Patient enrolled via SMS', { patientId: patient.id, procedure });

    await sendSMS(clinicianPhone, [
      `✓ Enrolled: ${firstName} ${lastName.charAt(0)}.`,
      `ID: ${patient.id.substring(0, 8)}...`,
      `${procedure} · Dr. ${surgeonName}`,
      `POD 0 check-in sends at 6 PM today.`,
      `To add goal: update via dashboard.`,
    ].join('\n'));

    return { handled: true, type: 'clinician_enroll' };
  } catch (err) {
    logger.error('SMS enrollment failed', { error: err.message });
    await sendSMS(clinicianPhone, `Enrollment failed: ${err.message}`);
    return { handled: true, type: 'clinician_enroll_error' };
  }
}

/**
 * TEXT — Relay a message from clinician to patient via the Twilio number.
 * Patient sees it from the same number they've been texting with.
 * Clinician never reveals their personal number.
 */
async function cmdText(clinicianPhone, rawArgs) {
  // Parse: first token is the ID, rest is the message
  const spaceIdx = rawArgs.indexOf(' ');
  if (spaceIdx === -1) {
    await sendSMS(clinicianPhone, `Usage: TEXT <patient-id> <your message>\nExample: TEXT 7f3a Please call the office about your wound.`);
    return { handled: true, type: 'clinician_text_usage' };
  }

  const idFragment = rawArgs.substring(0, spaceIdx).trim();
  const message = rawArgs.substring(spaceIdx + 1).trim();

  if (!message) {
    await sendSMS(clinicianPhone, `No message provided. Usage: TEXT <id> <your message>`);
    return { handled: true, type: 'clinician_text_usage' };
  }

  const patient = await findPatientByIdPrefix(idFragment);
  if (!patient) {
    await sendSMS(clinicianPhone, `No patient found matching "${idFragment}".`);
    return { handled: true, type: 'clinician_text_miss' };
  }

  // Forward the message to the patient — comes from the Twilio number, not the clinician's phone
  const forwarded = `Message from your care team at ${process.env.FACILITY_NAME || 'TidalHealth'}: ${message}`;
  await sendSMS(patient.phone, forwarded, { patientId: patient.id });

  // Confirm to clinician (no patient identity in the confirmation)
  await sendSMS(clinicianPhone, `✓ Message delivered to patient ${idFragment.substring(0, 8)}...`);

  await audit('clinician:' + clinicianPhone.slice(-4), 'text_relayed', 'patient', patient.id, { messageLength: message.length });
  return { handled: true, type: 'clinician_text' };
}

/**
 * STATUS — De-identified clinical summary. No name, no phone, no identifiers.
 */
async function cmdStatus(clinicianPhone, idFragment) {
  const patient = await findPatientByIdPrefix(idFragment);
  if (!patient) {
    await sendSMS(clinicianPhone, `No patient found matching "${idFragment}".`);
    return { handled: true, type: 'clinician_status_miss' };
  }

  const pod = Math.floor((Date.now() - new Date(patient.surgery_date).getTime()) / 86400000);

  // Latest completed session
  const session = (await pool.query(
    `SELECT phase, pod, ai_summary, ai_severity, completed_at
     FROM checkin_sessions WHERE patient_id = $1 AND status = 'completed'
     ORDER BY completed_at DESC LIMIT 1`,
    [patient.id]
  )).rows[0];

  // Open alerts (count + severity only)
  const openAlerts = (await pool.query(
    `SELECT severity, reason FROM alerts WHERE patient_id = $1 AND status IN ('open', 'acknowledged')
     ORDER BY created_at DESC LIMIT 5`,
    [patient.id]
  )).rows;

  // Build de-identified summary
  let msg = `📊 ${idFragment.substring(0, 8)}... | ${patient.procedure_name} | POD ${pod} | ${patient.status}\n`;

  if (session) {
    msg += `Last check-in: ${session.phase} (POD ${session.pod})\n`;
    if (session.ai_severity) msg += `AI severity: ${session.ai_severity}\n`;
    if (session.ai_summary) msg += `${session.ai_summary}\n`;
  } else {
    msg += `No check-ins completed yet.\n`;
  }

  if (openAlerts.length > 0) {
    msg += `\n⚠️ ${openAlerts.length} open alert(s):\n`;
    openAlerts.forEach(a => { msg += `[${a.severity}] ${a.reason}\n`; });
  } else {
    msg += `\n✓ No open alerts.`;
  }

  await sendSMS(clinicianPhone, msg);
  await audit('clinician:' + clinicianPhone.slice(-4), 'status_viewed', 'patient', patient.id, {});
  return { handled: true, type: 'clinician_status' };
}

/**
 * LIST — De-identified summary of active patients + alert counts
 */
async function cmdList(clinicianPhone) {
  const active = (await pool.query(`
    SELECT COUNT(*) as count FROM patients WHERE status IN ('enrolled', 'active')
  `)).rows[0];

  const openAlerts = (await pool.query(`
    SELECT severity, COUNT(*) as count FROM alerts WHERE status = 'open' GROUP BY severity
    ORDER BY CASE severity WHEN 'CRITICAL' THEN 1 WHEN 'URGENT' THEN 2 WHEN 'MONITOR' THEN 3 ELSE 4 END
  `)).rows;

  const recentCheckins = (await pool.query(`
    SELECT cs.phase, cs.pod, p.procedure_name, cs.ai_severity, p.id
    FROM checkin_sessions cs JOIN patients p ON p.id = cs.patient_id
    WHERE cs.completed_at > NOW() - INTERVAL '24 hours' AND cs.status = 'completed'
    ORDER BY cs.completed_at DESC LIMIT 5
  `)).rows;

  let msg = `📋 ACTIVE: ${active.count} patients\n`;

  if (openAlerts.length > 0) {
    msg += `\n⚠️ OPEN ALERTS:\n`;
    openAlerts.forEach(a => { msg += `  ${a.severity}: ${a.count}\n`; });
  } else {
    msg += `✓ No open alerts.\n`;
  }

  if (recentCheckins.length > 0) {
    msg += `\nLast 24h check-ins:\n`;
    recentCheckins.forEach(c => {
      const flag = c.ai_severity === 'URGENT' || c.ai_severity === 'CRITICAL' ? '⚠️' : '✓';
      msg += `  ${flag} ${c.id.substring(0, 8)}... ${c.procedure_name} POD ${c.pod} (${c.phase})\n`;
    });
  }

  await sendSMS(clinicianPhone, msg);
  await audit('clinician:' + clinicianPhone.slice(-4), 'list_viewed', null, null, {});
  return { handled: true, type: 'clinician_list' };
}

/**
 * Start a new check-in session for a patient
 */
async function startCheckin(patientId, phase, pod) {
  const protocol = PROTOCOLS[phase];
  if (!protocol) throw new Error(`Unknown protocol phase: ${phase}`);

  const patient = (await pool.query('SELECT * FROM patients WHERE id = $1', [patientId])).rows[0];
  if (!patient) throw new Error(`Patient not found: ${patientId}`);

  // Create session
  const session = (await pool.query(
    `INSERT INTO checkin_sessions (patient_id, phase, pod, status, scheduled_at, started_at, current_question_index)
     VALUES ($1, $2, $3, 'active', NOW(), NOW(), 0) RETURNING *`,
    [patientId, phase, pod]
  )).rows[0];

  // Update patient status
  await pool.query(`UPDATE patients SET status = 'active' WHERE id = $1`, [patientId]);

  // Fetch prior responses for personalization
  const prior = await getPriorResponses(patientId);

  // Build personalized greeting
  const greeting = buildGreeting(phase, patient, prior, pod);

  await sendSMS(patient.phone, greeting, { patientId, sessionId: session.id });

  // Send first question
  await sendNextQuestion(patient, session);

  await audit('scheduler', 'checkin_started', 'session', session.id, { phase, pod });
  logger.info('Check-in started', { patientId, phase, pod, sessionId: session.id });

  return session;
}

/**
 * Send the next question in the sequence.
 * Skips conditional questions that don't apply to this patient's procedure.
 */
async function sendNextQuestion(patient, session) {
  const protocol = PROTOCOLS[session.phase];
  let qi = session.current_question_index;

  // Skip conditional questions that don't apply
  while (qi < protocol.questions.length) {
    const q = protocol.questions[qi];
    
    if (q.conditional) {
      const shouldInclude = await checkConditional(patient, q, session.responses || {});
      if (!shouldInclude) {
        // Skip this question — advance index
        qi++;
        await pool.query(
          `UPDATE checkin_sessions SET current_question_index = $1 WHERE id = $2`,
          [qi, session.id]
        );
        continue;
      }
    }
    break;
  }

  if (qi >= protocol.questions.length) {
    return finishCheckin(patient, session);
  }

  let qText = protocol.questions[qi].q
    .replace('{goal}', patient.pre_surgical_goal || 'your recovery goals');

  // Personalize question text based on prior responses
  try {
    const prior = await getPriorResponses(patient.id);
    qText = personalizeQuestion(protocol.questions[qi].key, qText, session.phase, prior);
  } catch (err) {
    // Fall through with original text if personalization fails
  }

  await sendSMS(patient.phone, qText, { patientId: patient.id, sessionId: session.id });
}

/**
 * Check if a conditional question should be included for this patient.
 */
async function checkConditional(patient, question, currentResponses) {
  // PT/OT conditional — only show for ortho procedures
  if (question.conditional === 'ptOtExpected') {
    try {
      const { getConfigForPatient } = require('./procedure-config');
      const config = await getConfigForPatient(patient);
      if (!config.ptOtExpected) return false;

      // Check dependent conditions (e.g., only ask pt_barriers if pt_started = 'yes')
      if (question.conditionalDependsOn) {
        for (const [key, expectedValue] of Object.entries(question.conditionalDependsOn)) {
          if (currentResponses[key] !== expectedValue) return false;
        }
      }

      return true;
    } catch (err) {
      logger.warn('Conditional check failed', { error: err.message });
      return false; // Skip if we can't determine
    }
  }

  return true; // Default: include the question
}

/**
 * Process an inbound SMS response
 * This is the main entry point called by the webhook route.
 */
async function processInbound(phone, body, twilioSid = null, mediaUrls = []) {
  const patient = await findPatientByPhone(phone);
  
  // Log inbound regardless
  await logInbound(phone, body, {
    patientId: patient?.id,
    twilioSid,
  });

  // Emergency keyword check — ALWAYS active, even without a session
  if (isEmergency(body)) {
    await sendSMS(phone, '🚨 This sounds like it could be an emergency. Please call 911 or go to your nearest ER immediately. We are also alerting your care team.', { patientId: patient?.id });
    
    if (patient) {
      const session = await getActiveSession(patient.id);
      await sendNurseAlert(patient, session || { id: null, pod: '?' }, 'CRITICAL', `Emergency keyword detected: "${body.substring(0, 50)}"`);
    }
    return { handled: true, type: 'emergency' };
  }

  // STOP handling
  if (body.trim().toLowerCase() === 'stop') {
    if (patient) {
      await pool.query(
        `UPDATE patients SET status = 'withdrawn', withdrawn_at = NOW(), withdraw_reason = 'STOP keyword' WHERE id = $1`,
        [patient.id]
      );
      // Close any active session
      await pool.query(
        `UPDATE checkin_sessions SET status = 'skipped' WHERE patient_id = $1 AND status = 'active'`,
        [patient.id]
      );
      await audit('patient', 'patient_withdrawn', 'patient', patient.id, { reason: 'STOP keyword' });
    }
    return { handled: true, type: 'stop' };
  }

  // HELP handling
  if (body.trim().toLowerCase() === 'help') {
    await sendSMS(phone, `If this is an emergency, call 911. For urgent concerns, call the hospital at your surgeon's office number. To stop these messages, reply STOP.`, { patientId: patient?.id });
    return { handled: true, type: 'help' };
  }

  // ═══════════════════════════════════════════════════
  // NURSE DISPOSITION REPLIES — "1", "2", "3", "NOTE <text>"
  // Must check BEFORE clinician commands since these are short numeric replies
  // ═══════════════════════════════════════════════════
  const nurseDispoResult = await handleNurseDispositionReply(phone, body);
  if (nurseDispoResult) return nurseDispoResult;

  // ═══════════════════════════════════════════════════
  // CLINICIAN COMMANDS — authorized phones only
  // ═══════════════════════════════════════════════════
  const clinicianResult = await handleClinicianCommand(phone, body);
  if (clinicianResult) return clinicianResult;

  // ═══════════════════════════════════════════════════
  // PATIENT SELF-ENROLLMENT — JOIN, START, SIGNUP
  // ═══════════════════════════════════════════════════
  if (!patient && (isSelfEnrollmentTrigger(body) || hasActiveEnrollmentSession(phone))) {
    try {
      const enrollResult = await handleSelfEnrollment(phone, body);
      if (enrollResult.handled) return enrollResult;
    } catch (err) {
      logger.error('Self-enrollment failed', { error: err.message });
    }
  }

  // No known patient
  if (!patient) {
    await sendSMS(phone, `Thanks for your message. If you're a surgical patient, please contact your care team directly. Reply STOP to opt out.`);
    return { handled: true, type: 'unknown_patient' };
  }

  // Get active session
  const session = await getActiveSession(patient.id);
  if (!session) {
    // Check for active mini-assessment first
    const activeMiniAssessment = await getActiveMiniAssessment(patient.id);
    if (activeMiniAssessment) {
      try {
        const maResult = await processMiniAssessmentResponse(patient, activeMiniAssessment, body);
        if (maResult.handled) {
          // If mini-assessment complete, now send enriched alert to nurse
          if (maResult.complete) {
            if (maResult.criticalEscalate) {
              await sendNurseAlert(patient, { id: null, pod: '?' }, 'CRITICAL', maResult.criticalReason);
            } else if (maResult.nurseSummary) {
              // Send enriched alert with mini-assessment data
              await sendEnrichedNurseAlert(patient, activeMiniAssessment, maResult.nurseSummary);
            }
          }
          return { handled: true, type: 'mini_assessment_response', ...maResult };
        }
      } catch (err) {
        logger.error('Mini-assessment processing failed', { error: err.message, maId: activeMiniAssessment.id });
        // Fall through to conversation handler
      }
    }

    // No active check-in or mini-assessment — check for escalation outcome follow-up
    try {
      const { getActiveEscalationFollowUp, processEscalationResponse } = require('./escalation-followup');
      const activeEscFollowUp = await getActiveEscalationFollowUp(patient.id);
      if (activeEscFollowUp) {
        const escResult = await processEscalationResponse(patient, activeEscFollowUp, body);
        if (escResult.handled) {
          return { handled: true, type: 'escalation_outcome_response', ...escResult };
        }
      }
    } catch (err) {
      logger.debug('Escalation follow-up check failed', { error: err.message });
    }

    // No active check-in, mini-assessment, or escalation follow-up — route to conversational AI
    // Patient can text questions, concerns, photos anytime
    try {
      return await handleConversation(patient, body, { mediaUrls, twilioSid });
    } catch (err) {
      logger.error('Conversation handler failed', { error: err.message, patientId: patient.id });
      await sendSMS(phone, `Thanks for reaching out! I'm passing your message along to the nurse. Someone will get back to you soon. If it's urgent, call your surgeon's office.`, { patientId: patient.id });
      return { handled: true, type: 'conversation_error' };
    }
  }

  // Process the response for the current question
  const protocol = PROTOCOLS[session.phase];
  const qi = session.current_question_index;

  if (qi >= protocol.questions.length) {
    return finishCheckin(patient, session);
  }

  const question = protocol.questions[qi];
  const parsed = parseResponse(question.type, body);

  // Store response
  let alertTriggered = false;
  let alertSeverity = null;
  let alertReason = null;

  if (question.alert) {
    const alertResult = question.alert(parsed, session.responses || {});
    if (alertResult) {
      alertTriggered = true;
      [alertSeverity, alertReason] = alertResult;
    }
  }

  // ── Procedure-aware opioid alert override ──
  // Static protocol says "opioids at POD 14 = MONITOR" regardless of procedure.
  // A total knee at POD 14 is expected to still be on opioids. A lap chole is not.
  // Override the severity (or suppress the alert) based on procedure-specific windows.
  if (alertTriggered && (question.key === 'still_opioids' || question.key === 'opioids') && parsed !== 'no') {
    try {
      const { getConfigForPatient, checkOpioidStatus } = require('./procedure-config');
      const procConfig = await getConfigForPatient(patient);
      const pod = session.pod || 0;
      const opioidStatus = checkOpioidStatus(procConfig, pod, parsed === 'yes' ? 'yes' : parsed);

      if (opioidStatus === 'within') {
        // Patient is within expected window for this procedure — suppress alert
        alertTriggered = false;
        alertSeverity = null;
        alertReason = null;
        logger.info('Opioid alert suppressed — within expected window', {
          procedure: patient.procedure_name, pod, expected: procConfig.opioid?.expectedDurationDays,
        });
      } else if (opioidStatus === 'warning') {
        // Approaching limit — downgrade to MONITOR regardless of protocol severity
        alertSeverity = 'MONITOR';
        alertReason = `Opioids continuing at POD ${pod} (${procConfig.displayName || patient.procedure_name}: expected ≤${procConfig.opioid?.expectedDurationDays} days, warning at ${procConfig.opioid?.warningDays} days)`;
      } else if (opioidStatus === 'alert') {
        // Past expected window — ensure at least URGENT
        alertSeverity = alertSeverity === 'CRITICAL' ? 'CRITICAL' : 'URGENT';
        alertReason = `Opioids continuing at POD ${pod} — past expected window (${procConfig.displayName || patient.procedure_name}: expected ≤${procConfig.opioid?.expectedDurationDays} days)`;
      }
    } catch (err) {
      logger.warn('Procedure config check failed, using static alert', { error: err.message });
      // Fall through with original static alert
    }
  }

  // Save response to DB
  const responseRecord = (await pool.query(
    `INSERT INTO responses (session_id, patient_id, question_key, question_text, response_raw, response_parsed, response_type, phase, pod, alert_triggered, alert_severity, alert_reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
    [session.id, patient.id, question.key, question.q, body.trim(), String(parsed), question.type, session.phase, session.pod,
     alertTriggered, alertSeverity, alertReason]
  )).rows[0];

  // Update session state
  const updatedResponses = { ...(session.responses || {}), [question.key]: parsed };
  await pool.query(
    `UPDATE checkin_sessions SET current_question_index = $1, responses = $2 WHERE id = $3`,
    [qi + 1, JSON.stringify(updatedResponses), session.id]
  );

  // Fire alert if triggered
  if (alertTriggered) {
    if (alertSeverity === 'CRITICAL') {
      // CRITICAL: immediate 911 + nurse alert, no mini-assessment
      await sendNurseAlert(patient, session, alertSeverity, alertReason);
      await sendSMS(patient.phone, '🚨 This sounds like it could be an emergency. Please call 911 or go to your nearest ER immediately.', { patientId: patient.id, sessionId: session.id });
      await pool.query(`UPDATE checkin_sessions SET status = 'completed', completed_at = NOW() WHERE id = $1`, [session.id]);
      return { handled: true, type: 'critical_alert' };
    }

    // URGENT/MONITOR: Note the alert, but defer nurse notification.
    // Mini-assessment will run after check-in completes and THEN send enriched alert.
    // For now, just log the alert record (nurse notification deferred).
    try {
      await pool.query(
        `INSERT INTO alerts (session_id, patient_id, severity, reason, source, status)
         VALUES ($1, $2, $3, $4, 'protocol', 'pending_assessment')`,
        [session.id, patient.id, alertSeverity, alertReason]
      );
    } catch (err) {
      logger.error('Failed to create deferred alert', { error: err.message });
      // Fallback: send alert immediately if we can't defer
      await sendNurseAlert(patient, session, alertSeverity, alertReason);
    }
  }

  // Advance to next question or finish
  const nextQi = qi + 1;
  if (nextQi >= protocol.questions.length) {
    // Refresh session with updated responses
    const updatedSession = { ...session, current_question_index: nextQi, responses: updatedResponses };
    return finishCheckin(patient, updatedSession);
  }

  // Send next question
  const updatedSession = (await pool.query('SELECT * FROM checkin_sessions WHERE id = $1', [session.id])).rows[0];
  await sendNextQuestion(patient, updatedSession);

  return { handled: true, type: 'response_recorded', questionKey: question.key, alertTriggered };
}

/**
 * Complete a check-in session — send closing, run AI triage
 */
async function finishCheckin(patient, session) {
  const protocol = PROTOCOLS[session.phase];

  // Send personalized closing message
  let closing;
  try {
    const prior = await getPriorResponses(patient.id);
    closing = buildClosing(session.phase, patient, prior);
  } catch (err) {
    const surgeonClean = (patient.surgeon_name || '').replace(/^Dr\.?\s*/i, '');
    closing = (protocol.closing || 'Thanks for checking in!')
      .replace('{firstName}', patient.first_name)
      .replace('{surgeon}', surgeonClean)
      .replace('{facility}', process.env.FACILITY_NAME || 'TidalHealth Peninsula Regional');
  }

  await sendSMS(patient.phone, closing, { patientId: patient.id, sessionId: session.id });

  // Mark session complete
  await pool.query(
    `UPDATE checkin_sessions SET status = 'completed', completed_at = NOW() WHERE id = $1`,
    [session.id]
  );

  // Get all responses for this session
  const allResponses = (await pool.query(
    `SELECT * FROM responses WHERE session_id = $1 ORDER BY created_at`,
    [session.id]
  )).rows;

  // Check for deferred alerts that need mini-assessment
  const deferredAlerts = (await pool.query(
    `SELECT * FROM alerts WHERE session_id = $1 AND status = 'pending_assessment' ORDER BY 
     CASE severity WHEN 'CRITICAL' THEN 1 WHEN 'URGENT' THEN 2 WHEN 'MONITOR' THEN 3 ELSE 4 END
     LIMIT 1`,
    [session.id]
  )).rows;

  if (deferredAlerts.length > 0) {
    const topAlert = deferredAlerts[0];
    
    // Try to start a mini-assessment for the highest-priority deferred alert
    let miniAssessmentStarted = false;
    try {
      const procedureConfig = await getConfigForPatient(patient);
      const assessmentType = selectAssessment(
        topAlert.reason.split(':')[0]?.toLowerCase().trim() || topAlert.reason,
        topAlert.severity,
        session.responses || {},
        procedureConfig
      );

      // Also try matching by question key from the alert reason
      const alertQuestionKey = findAlertQuestionKey(topAlert.reason, allResponses);
      const assessmentByKey = alertQuestionKey 
        ? selectAssessment(alertQuestionKey, topAlert.severity, session.responses || {}, procedureConfig) 
        : null;

      const finalAssessmentType = assessmentType || assessmentByKey;

      if (finalAssessmentType) {
        const maSession = await startMiniAssessment(patient, session, finalAssessmentType, {
          questionKey: alertQuestionKey || 'unknown',
          severity: topAlert.severity,
          reason: topAlert.reason,
          allResponses: session.responses || {},
        });

        if (maSession) {
          miniAssessmentStarted = true;
          // Link alert to mini-assessment
          await pool.query(
            `UPDATE alerts SET mini_assessment_id = $1 WHERE id = $2`,
            [maSession.id, topAlert.id]
          );
          logger.info('Mini-assessment started after check-in', { 
            assessmentType: finalAssessmentType, alertId: topAlert.id, maId: maSession.id 
          });
        }
      }
    } catch (err) {
      logger.error('Failed to start mini-assessment', { error: err.message });
    }

    // If no mini-assessment was started, send nurse alerts immediately (fallback)
    if (!miniAssessmentStarted) {
      for (const alert of deferredAlerts) {
        await sendNurseAlert(patient, session, alert.severity, alert.reason);
        await pool.query(`UPDATE alerts SET status = 'open', nurse_notified_at = NOW() WHERE id = $1`, [alert.id]);
      }
    }
  }

  // Run AI triage (de-identified) — runs regardless of mini-assessment
  try {
    const triage = await triageSession(patient, session, allResponses);
    logger.info('AI triage complete', { sessionId: session.id, severity: triage.severity });

    // If AI found something the protocol rules missed, create an additional alert
    if (triage.severity === 'URGENT' || triage.severity === 'CRITICAL') {
      const protocolAlerts = allResponses.filter(r => r.alert_triggered);
      const protocolMaxSeverity = protocolAlerts.length > 0
        ? protocolAlerts.reduce((max, a) => {
            const order = { CRITICAL: 4, URGENT: 3, MONITOR: 2, LOW: 1 };
            return order[a.alert_severity] > order[max] ? a.alert_severity : max;
          }, 'LOW')
        : 'LOW';

      // AI escalated beyond what protocol caught
      if (triage.severity === 'CRITICAL' || (triage.severity === 'URGENT' && protocolMaxSeverity !== 'URGENT' && protocolMaxSeverity !== 'CRITICAL')) {
        await sendNurseAlert(patient, session, triage.severity, `AI triage: ${triage.summary}`);
        await pool.query(
          `INSERT INTO alerts (session_id, patient_id, severity, reason, source) VALUES ($1, $2, $3, $4, 'ai')`,
          [session.id, patient.id, triage.severity, triage.summary]
        );
      }
    }
  } catch (err) {
    logger.error('AI triage failed — protocol alerts still active', { error: err.message });
  }

  // Update patient status if this was the final check-in
  if (session.phase === 'closure') {
    await pool.query(
      `UPDATE patients SET status = 'completed', completed_at = NOW() WHERE id = $1`,
      [patient.id]
    );
  }

  await audit('system', 'checkin_completed', 'session', session.id, { phase: session.phase, pod: session.pod });
  return { handled: true, type: 'checkin_completed' };
}

/**
 * Send an enriched nurse alert that includes mini-assessment data.
 * Much more useful than the raw protocol alert.
 */
async function sendEnrichedNurseAlert(patient, maSession, nurseSummary) {
  const { sendNurseAlert: sendAlert } = require('./twilio');
  const pod = patient.surgery_date
    ? Math.floor((Date.now() - new Date(patient.surgery_date).getTime()) / 86400000)
    : '?';

  const pseudoSession = { id: maSession.checkin_session_id, pod };
  const enrichedReason = `[AI Scribe Summary] ${nurseSummary.text}\n\nKey findings: ${(nurseSummary.keyFindings || []).join(', ')}\nSuggested: ${nurseSummary.suggestedAction || 'Nurse review'}`;

  await sendAlert(patient, pseudoSession, nurseSummary.severity || maSession.trigger_severity, enrichedReason);

  // Update the deferred alert to 'open' (nurse has been notified)
  try {
    await pool.query(
      `UPDATE alerts SET status = 'open', nurse_notified_at = NOW() WHERE mini_assessment_id = $1 AND status = 'pending_assessment'`,
      [maSession.id]
    );
  } catch (err) {
    logger.warn('Failed to update deferred alert status', { error: err.message });
  }
}

/**
 * Try to extract the question key from an alert reason string.
 * Alert reasons look like: "Pain 8/10 in acute phase" or "Possible SSI: redness/discharge"
 */
function findAlertQuestionKey(reason, allResponses) {
  const lower = (reason || '').toLowerCase();

  // Map common alert phrases to question keys
  const keywordMap = {
    'pain': 'pain',
    'ssi': 'redness',
    'redness': 'redness',
    'discharge': 'redness',
    'bleeding': 'bleeding',
    'fluid': 'fluids',
    'urination': 'urination',
    'urinary': 'urination',
    'dvt': 'leg_swelling',
    'leg swelling': 'leg_swelling',
    'fever': 'fever',
    'bowel': 'bowel',
    'opioid': 'still_opioids',
    'dehiscence': 'wound_open',
    'seroma': 'fluid_bulge',
    'phq': 'phq_mood',
    'depression': 'phq_mood',
    'ambulating': 'moving',
    'not moving': 'moving',
    'wound not': 'wound_closed',
    'confusion': 'groggy',
    'sedation': 'groggy',
  };

  for (const [keyword, questionKey] of Object.entries(keywordMap)) {
    if (lower.includes(keyword)) return questionKey;
  }

  // Fallback: check if any response triggered an alert and return that key
  const alertResponse = allResponses?.find(r => r.alert_triggered);
  return alertResponse?.question_key || null;
}

module.exports = { processInbound, startCheckin, findPatientByPhone, getActiveSession };
