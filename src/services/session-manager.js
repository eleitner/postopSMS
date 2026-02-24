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
const logger = require('../utils/logger');

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

  // Build and send greeting
  const surgeonClean = (patient.surgeon_name || '').replace(/^Dr\.?\s*/i, '');
  const greeting = protocol.greeting
    .replace('{firstName}', patient.first_name)
    .replace('{pod}', pod)
    .replace('{surgeon}', surgeonClean)
    .replace('{procedure}', patient.procedure_name)
    .replace('{facility}', process.env.FACILITY_NAME || 'TidalHealth Peninsula Regional');

  await sendSMS(patient.phone, greeting, { patientId, sessionId: session.id });

  // Send first question
  await sendNextQuestion(patient, session);

  await audit('scheduler', 'checkin_started', 'session', session.id, { phase, pod });
  logger.info('Check-in started', { patientId, phase, pod, sessionId: session.id });

  return session;
}

/**
 * Send the next question in the sequence
 */
async function sendNextQuestion(patient, session) {
  const protocol = PROTOCOLS[session.phase];
  const qi = session.current_question_index;

  if (qi >= protocol.questions.length) {
    return finishCheckin(patient, session);
  }

  let qText = protocol.questions[qi].q
    .replace('{goal}', patient.pre_surgical_goal || 'your recovery goals');

  await sendSMS(patient.phone, qText, { patientId: patient.id, sessionId: session.id });
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
  // CLINICIAN COMMANDS — authorized phones only
  // ═══════════════════════════════════════════════════
  const clinicianResult = await handleClinicianCommand(phone, body);
  if (clinicianResult) return clinicianResult;

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

    // No active check-in or mini-assessment — route to conversational AI
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

  // Send closing message
  const surgeonClean = (patient.surgeon_name || '').replace(/^Dr\.?\s*/i, '');
  const closing = (protocol.closing || 'Thanks for checking in!')
    .replace('{firstName}', patient.first_name)
    .replace('{surgeon}', surgeonClean)
    .replace('{facility}', process.env.FACILITY_NAME || 'TidalHealth Peninsula Regional');

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
