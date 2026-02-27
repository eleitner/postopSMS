/**
 * Escalation Outcome Follow-Up
 * 
 * When a nurse dispositions with office_visit, office_visit_urgent, or ed_sameday,
 * the system schedules a 48h follow-up asking the patient what happened.
 * 
 * Flow:
 *   1. "Did you go to [office/ED]?" → Yes / No / Scheduled
 *   2a. If Yes → "What was done?" (free text) → "How are you feeling now?" Better/Same/Worse
 *   2b. If No → "Why not?" (free text) → "Still having the issue?" Yes/No → re-escalate if yes
 *   2c. If Scheduled → "When?" (free text) → schedule another follow-up
 * 
 * All responses logged. Re-escalation fires URGENT alert to nurse.
 */
const { pool, audit } = require('../utils/db');
const { sendSMS, sendNurseAlert } = require('./twilio');
const logger = require('../utils/logger');

// Disposition keys that represent escalated care requiring outcome follow-up
const ESCALATION_DISPOSITIONS = [
  'office_visit',
  'office_visit_urgent',
  'ed_sameday',
];

// Human-readable labels for the follow-up message
const DISPOSITION_LABELS = {
  office_visit: "see your surgeon's office",
  office_visit_urgent: "see your surgeon's office urgently",
  ed_sameday: 'go to the ER or urgent care',
};

// ═══════════════════════════════════════════════════
// SCHEDULE OUTCOME FOLLOW-UP
// ═══════════════════════════════════════════════════

/**
 * Called from sendDisposition in nurse-templates.js after an escalation disposition.
 * Schedules a follow-up 48h later asking the patient what happened.
 */
async function scheduleEscalationFollowUp(patient, alert, dispositionKey) {
  if (!ESCALATION_DISPOSITIONS.includes(dispositionKey)) return;

  const label = DISPOSITION_LABELS[dispositionKey] || 'follow up on the recommendation';
  const triggerAt = new Date(Date.now() + 48 * 3600000); // 48 hours

  const prompt = `Hi ${patient.first_name}, a couple days ago we recommended you ${label}. Were you able to do that? Reply YES, NO, or SCHEDULED if you have an appointment coming up.`;

  try {
    await pool.query(
      `INSERT INTO scheduled_followups (patient_id, type, prompt, trigger_at, metadata)
       VALUES ($1, 'escalation_outcome', $2, $3, $4)`,
      [
        patient.id,
        prompt,
        triggerAt,
        JSON.stringify({
          alertId: alert.id,
          dispositionKey,
          label,
          step: 'initial', // tracks where we are in the branching flow
        }),
      ]
    );
    logger.info('Escalation outcome follow-up scheduled', {
      patientId: patient.id,
      dispositionKey,
      triggerAt,
    });
  } catch (err) {
    logger.warn('Failed to schedule escalation follow-up', { error: err.message });
  }
}


// ═══════════════════════════════════════════════════
// PROCESS PATIENT RESPONSE TO OUTCOME FOLLOW-UP
// ═══════════════════════════════════════════════════

/**
 * Check if the patient has an active escalation follow-up waiting for a response.
 * Returns the follow-up row or null.
 */
async function getActiveEscalationFollowUp(patientId) {
  try {
    const result = await pool.query(
      `SELECT * FROM scheduled_followups 
       WHERE patient_id = $1 
         AND type = 'escalation_outcome' 
         AND status IN ('sent', 'awaiting_response')
       ORDER BY sent_at DESC LIMIT 1`,
      [patientId]
    );
    return result.rows[0] || null;
  } catch (err) {
    logger.debug('Escalation follow-up check failed', { error: err.message });
    return null;
  }
}

/**
 * Process a patient's response to an escalation outcome follow-up.
 * Manages the branching conversation flow across multiple messages.
 * 
 * Returns { handled: true/false, ... } to indicate if this consumed the message.
 */
async function processEscalationResponse(patient, followUp, body) {
  const text = body.trim();
  const lower = text.toLowerCase();
  let metadata;
  try {
    metadata = typeof followUp.metadata === 'string' ? JSON.parse(followUp.metadata) : (followUp.metadata || {});
  } catch {
    metadata = {};
  }
  const step = metadata.step || 'initial';

  // ── STEP: initial — "Did you go?" → Yes / No / Scheduled ──
  if (step === 'initial') {
    if (/^(y|yes|yeah|yep|i did|went)$/i.test(lower) || lower.includes('yes')) {
      // Patient went — ask what was done
      await updateFollowUp(followUp.id, 'awaiting_response', {
        ...metadata,
        step: 'what_was_done',
        wentToAppointment: true,
        initialResponse: text,
      });
      await sendSMS(patient.phone, `Good — glad you were able to go. Can you tell us briefly what was done? (e.g., "got antibiotics", "wound was rechecked", "had a CT scan")`, { patientId: patient.id });
      await logOutcomeResponse(followUp.id, patient.id, 'initial', text, 'yes');
      return { handled: true, type: 'escalation_outcome', step: 'what_was_done' };

    } else if (/^(n|no|nah|nope|didn|not yet|haven)/.test(lower)) {
      // Patient didn't go — ask why
      await updateFollowUp(followUp.id, 'awaiting_response', {
        ...metadata,
        step: 'why_not',
        wentToAppointment: false,
        initialResponse: text,
      });
      await sendSMS(patient.phone, `No worries — can you tell us why you weren't able to go? (e.g., "couldn't get a ride", "feeling better", "couldn't get an appointment")`, { patientId: patient.id });
      await logOutcomeResponse(followUp.id, patient.id, 'initial', text, 'no');
      return { handled: true, type: 'escalation_outcome', step: 'why_not' };

    } else if (/schedul|appoint|booked|going|plan/i.test(lower)) {
      // Patient has it scheduled
      await updateFollowUp(followUp.id, 'awaiting_response', {
        ...metadata,
        step: 'when_scheduled',
        wentToAppointment: 'scheduled',
        initialResponse: text,
      });
      await sendSMS(patient.phone, `OK great — when is your appointment? (You can just type the date or day, like "Thursday" or "March 3")`, { patientId: patient.id });
      await logOutcomeResponse(followUp.id, patient.id, 'initial', text, 'scheduled');
      return { handled: true, type: 'escalation_outcome', step: 'when_scheduled' };

    } else {
      // Ambiguous — nudge
      await sendSMS(patient.phone, `Just to clarify — were you able to ${metadata.label || 'follow up as recommended'}? Reply YES, NO, or SCHEDULED.`, { patientId: patient.id });
      return { handled: true, type: 'escalation_outcome', step: 'initial_retry' };
    }
  }

  // ── STEP: what_was_done — free text about what happened ──
  if (step === 'what_was_done') {
    await updateFollowUp(followUp.id, 'awaiting_response', {
      ...metadata,
      step: 'how_feeling',
      whatWasDone: text,
    });
    await sendSMS(patient.phone, `Thanks for sharing that. How are you feeling now compared to before you went? Reply BETTER, SAME, or WORSE.`, { patientId: patient.id });
    await logOutcomeResponse(followUp.id, patient.id, 'what_was_done', text, null);
    return { handled: true, type: 'escalation_outcome', step: 'how_feeling' };
  }

  // ── STEP: how_feeling — Better / Same / Worse ──
  if (step === 'how_feeling') {
    let feeling = 'unknown';
    if (/better|good|great|improv/i.test(lower)) feeling = 'better';
    else if (/same|ok|okay|unchanged|no change/i.test(lower)) feeling = 'same';
    else if (/worse|bad|awful|terrible|not good/i.test(lower)) feeling = 'worse';

    await logOutcomeResponse(followUp.id, patient.id, 'how_feeling', text, feeling);

    if (feeling === 'worse') {
      // Patient went but feeling worse — re-escalate
      await completeFollowUp(followUp.id, {
        ...metadata,
        howFeeling: feeling,
        outcome: 'went_but_worse',
      });
      await sendSMS(patient.phone, `I'm sorry to hear that. We're going to flag this for your nurse so they can follow up with you. Hang tight.`, { patientId: patient.id });
      await sendNurseAlert(
        patient,
        { id: metadata.alertId, pod: '?' },
        'URGENT',
        `Escalation follow-up: Patient went to ${metadata.label || 'recommended care'} but reports feeling WORSE. Treatment received: "${metadata.whatWasDone || 'not specified'}". Original alert: ${metadata.dispositionKey}. Needs re-evaluation.`
      );
      return { handled: true, type: 'escalation_outcome', step: 'complete', outcome: 'went_but_worse' };
    } else {
      // Better or same — log and close
      await completeFollowUp(followUp.id, {
        ...metadata,
        howFeeling: feeling,
        outcome: feeling === 'better' ? 'resolved' : 'stable',
      });
      const msg = feeling === 'better'
        ? `Great to hear you're doing better! Keep us posted if anything changes. You can always text us.`
        : `Thanks for the update. We'll keep an eye on things. Text us anytime if something changes or you have concerns.`;
      await sendSMS(patient.phone, msg, { patientId: patient.id });
      return { handled: true, type: 'escalation_outcome', step: 'complete', outcome: feeling };
    }
  }

  // ── STEP: why_not — free text reason for not going ──
  if (step === 'why_not') {
    await updateFollowUp(followUp.id, 'awaiting_response', {
      ...metadata,
      step: 'still_having_issue',
      whyNot: text,
    });
    await sendSMS(patient.phone, `Got it. Are you still having the issue we were concerned about? (Yes/No)`, { patientId: patient.id });
    await logOutcomeResponse(followUp.id, patient.id, 'why_not', text, null);
    return { handled: true, type: 'escalation_outcome', step: 'still_having_issue' };
  }

  // ── STEP: still_having_issue — Yes/No ──
  if (step === 'still_having_issue') {
    const stillIssue = /^(y|yes|yeah|yep|still|kind of|a little|some)/i.test(lower);

    await logOutcomeResponse(followUp.id, patient.id, 'still_having_issue', text, stillIssue ? 'yes' : 'no');

    if (stillIssue) {
      // Didn't go AND still symptomatic — re-escalate
      await completeFollowUp(followUp.id, {
        ...metadata,
        stillHavingIssue: true,
        outcome: 'did_not_go_still_symptomatic',
      });
      await sendSMS(patient.phone, `Thanks for being honest with us. We're going to flag this for your nurse to follow up. It's important we make sure you're OK.`, { patientId: patient.id });
      await sendNurseAlert(
        patient,
        { id: metadata.alertId, pod: '?' },
        'URGENT',
        `Escalation follow-up: Patient did NOT go to ${metadata.label || 'recommended care'} and reports STILL having the issue. Reason: "${metadata.whyNot || 'not specified'}". Original alert: ${metadata.dispositionKey}. Needs nurse outreach.`
      );
      return { handled: true, type: 'escalation_outcome', step: 'complete', outcome: 'did_not_go_still_symptomatic' };
    } else {
      // Didn't go but issue resolved on its own
      await completeFollowUp(followUp.id, {
        ...metadata,
        stillHavingIssue: false,
        outcome: 'self_resolved',
      });
      await sendSMS(patient.phone, `Glad to hear the issue has improved. Keep us posted if anything comes back or you have new concerns. Text us anytime.`, { patientId: patient.id });
      return { handled: true, type: 'escalation_outcome', step: 'complete', outcome: 'self_resolved' };
    }
  }

  // ── STEP: when_scheduled — free text appointment date ──
  if (step === 'when_scheduled') {
    await logOutcomeResponse(followUp.id, patient.id, 'when_scheduled', text, null);

    // Schedule a post-appointment follow-up (72h from now as a reasonable buffer)
    const nextFollowUp = new Date(Date.now() + 72 * 3600000);
    await completeFollowUp(followUp.id, {
      ...metadata,
      appointmentDate: text,
      outcome: 'appointment_scheduled',
    });

    // Schedule a new follow-up to check after the appointment
    try {
      const prompt = `Hi ${patient.first_name}, you mentioned you had an appointment ${text.length < 30 ? 'on ' + text : 'coming up'}. Were you able to go? Reply YES or NO.`;
      await pool.query(
        `INSERT INTO scheduled_followups (patient_id, type, prompt, trigger_at, metadata)
         VALUES ($1, 'escalation_outcome', $2, $3, $4)`,
        [
          patient.id,
          prompt,
          nextFollowUp,
          JSON.stringify({
            alertId: metadata.alertId,
            dispositionKey: metadata.dispositionKey,
            label: metadata.label,
            step: 'initial',
            isPostAppointmentFollowUp: true,
            originalAppointmentDate: text,
          }),
        ]
      );
    } catch (err) {
      logger.warn('Failed to schedule post-appointment follow-up', { error: err.message });
    }

    await sendSMS(patient.phone, `OK, noted — appointment ${text.length < 30 ? text : 'coming up'}. We'll check back with you after that. Good luck!`, { patientId: patient.id });
    return { handled: true, type: 'escalation_outcome', step: 'complete', outcome: 'appointment_scheduled' };
  }

  // Unrecognized step — shouldn't happen, but close it out
  logger.warn('Escalation follow-up in unknown step', { step, followUpId: followUp.id });
  await completeFollowUp(followUp.id, { ...metadata, outcome: 'unknown_step' });
  return { handled: false };
}


// ═══════════════════════════════════════════════════
// DATABASE HELPERS
// ═══════════════════════════════════════════════════

async function updateFollowUp(id, status, metadata) {
  await pool.query(
    `UPDATE scheduled_followups SET status = $1, metadata = $2 WHERE id = $3`,
    [status, JSON.stringify(metadata), id]
  );
}

async function completeFollowUp(id, metadata) {
  await pool.query(
    `UPDATE scheduled_followups SET status = 'completed', responded_at = NOW(), metadata = $1 WHERE id = $2`,
    [JSON.stringify(metadata), id]
  );
}

async function logOutcomeResponse(followUpId, patientId, step, responseText, parsedValue) {
  try {
    await pool.query(
      `INSERT INTO escalation_outcome_responses 
       (followup_id, patient_id, step, response_text, parsed_value, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [followUpId, patientId, step, responseText, parsedValue]
    );
  } catch (err) {
    // Table might not exist yet — log but don't fail
    logger.debug('Could not log escalation outcome response', { error: err.message });
  }
}


// ═══════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════

module.exports = {
  ESCALATION_DISPOSITIONS,
  scheduleEscalationFollowUp,
  getActiveEscalationFollowUp,
  processEscalationResponse,
};
