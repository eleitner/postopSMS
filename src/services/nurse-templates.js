/**
 * Nurse Response Templates — One-Click Dispositions
 * 
 * Each alert type has its own set of response templates.
 * Nurse sees the alert summary + mini-assessment data + one-click options.
 * Every disposition gets logged as structured data for QI outcomes analysis.
 * 
 * 9 Alert Types:
 *   1. Possible SSI
 *   2. Wound Photo Received
 *   3. Pain >7
 *   4. Possible DVT
 *   5. Fever
 *   6. Prolonged Opioids
 *   7. PHQ-2 Positive
 *   8. Wound Dehiscence / Seroma
 *   9. Between-Checkin AI Escalation (catch-all)
 * 
 * Template variables: {name}, {surgeon}, {officePhone}
 * {officePhone} auto-populated only for Office Visit and ED dispositions.
 * Free-text box always visible for nurse to add personal note.
 */
const { pool, audit } = require('../utils/db');
const { sendSMS } = require('./twilio');
const logger = require('../utils/logger');

// ═══════════════════════════════════════════════════
// TEMPLATE DEFINITIONS
// ═══════════════════════════════════════════════════

const TEMPLATES = {

  // ── 1. Possible SSI ──
  possible_ssi: {
    name: 'Possible Surgical Site Infection',
    alertTypes: ['redness', 'wound_concern'],
    dispositions: [
      {
        key: 'reassure_watch',
        label: 'Reassure & Watch',
        message: "Hi {name}, this is Dr. {surgeon}'s office RN. I reviewed what you reported about your incision. Some redness right around the incision edges is normal healing. Keep the area clean and dry. If the redness spreads, you see thick drainage, or you develop a fever above 100.4, text us right back.",
        autoFollowUp: null,
        clinicalGuidance: 'Use when: mild redness at incision edges without systemic symptoms, no fever, no purulent drainage.',
      },
      {
        key: 'monitor_followup',
        label: 'Monitor & Follow Up',
        message: "Hi {name}, this is Dr. {surgeon}'s office RN. Thanks for letting us know about your incision. I'd like to keep a close eye on this. Can you send us an updated photo in 2 days so we can see how it's doing? In the meantime, keep the area clean and dry, and text us immediately if you develop a fever or the redness spreads.",
        autoFollowUp: { hours: 48, type: 'photo_request', prompt: "Hey {name}, your nurse asked you to send an updated photo of your incision. Can you snap one and text it to us?" },
        clinicalGuidance: 'Use when: redness worth watching but not yet meeting office visit criteria. Auto-schedules 48h photo request.',
      },
      {
        key: 'office_visit',
        label: 'Office Visit',
        message: "Hi {name}, this is Dr. {surgeon}'s office RN. Based on what you described about your incision, I'd like you to come in so we can take a look. Please call us at {officePhone} to schedule a visit in the next day or two. If things get worse before then — spreading redness, fever, or heavy drainage — head to the ER.",
        autoFollowUp: null,
        clinicalGuidance: 'Use when: spreading redness, fever 100.4-101.5, purulent drainage described, or combination of concerning signs. Nurse has consulted with surgeon or surgeon\'s standing orders cover this.',
        includeOfficePhone: true,
      },
      {
        key: 'ed_sameday',
        label: 'ED / Same-Day Eval',
        message: "Hi {name}, this is Dr. {surgeon}'s office RN. What you're describing with your incision needs to be evaluated today. Please go to the emergency department or call our office at {officePhone} for same-day instructions. Don't wait on this one.",
        autoFollowUp: null,
        clinicalGuidance: 'Use when: high fever (>101.5), significant purulent drainage, rapidly spreading cellulitis, systemic symptoms.',
        includeOfficePhone: true,
      },
      {
        key: 'callback',
        label: 'Callback Requested',
        message: "Hi {name}, your nurse will be calling you shortly to talk through what you reported about your incision. If you don't hear back within an hour, please text us and we'll make sure someone reaches you.",
        autoFollowUp: null,
        clinicalGuidance: 'Use when: assessment is ambiguous, nurse needs to speak directly with patient.',
      },
    ],
  },

  // ── 2. Wound Photo Received ──
  wound_photo: {
    name: 'Wound Photo Review',
    alertTypes: ['photo', 'wound_photo'],
    dispositions: [
      {
        key: 'looks_normal',
        label: 'Looks Normal',
        message: "Hi {name}, this is Dr. {surgeon}'s office RN. I reviewed the photo you sent — your incision looks like it's healing well. Some redness and bruising at this stage is completely normal. Keep it clean and dry, and keep us posted if anything changes.",
        autoFollowUp: null,
      },
      {
        key: 'slightly_concerning',
        label: 'Slightly Concerning — Monitor',
        message: "Hi {name}, this is Dr. {surgeon}'s office RN. I reviewed the photo you sent. I'd like to keep an eye on this — can you send us another photo in 2 days? In the meantime, keep the area clean and dry.",
        autoFollowUp: { hours: 48, type: 'photo_request', prompt: "Hey {name}, your nurse asked you to send an updated photo of your incision. Can you snap one and text it to us?" },
      },
      {
        key: 'needs_visit',
        label: 'Needs Office Visit',
        message: "Hi {name}, this is Dr. {surgeon}'s office RN. I reviewed the photo you sent and I'd like the surgeon to take a look in person. Please call us at {officePhone} to schedule a visit in the next day or two.",
        autoFollowUp: null,
        includeOfficePhone: true,
      },
      {
        key: 'needs_ed',
        label: 'Needs ER Evaluation',
        message: "Hi {name}, this is Dr. {surgeon}'s office RN. Based on the photo you sent, I'd like you to be seen today. Please go to the emergency department. If you have questions, call us at {officePhone}.",
        autoFollowUp: null,
        includeOfficePhone: true,
      },
      {
        key: 'callback',
        label: 'Callback to Discuss',
        message: "Hi {name}, your nurse will be calling you shortly to talk through the photo you sent. If you don't hear back within an hour, please text us.",
        autoFollowUp: null,
      },
    ],
  },

  // ── 3. Pain >7 ──
  pain_high: {
    name: 'Pain Above Threshold',
    alertTypes: ['pain', 'pain_escalation'],
    dispositions: [
      {
        key: 'reassure_adjust',
        label: 'Reassure & Adjust',
        message: "Hi {name}, this is Dr. {surgeon}'s office RN. I see your pain has been pretty high. Make sure you're staying ahead of it — take your medications on schedule rather than waiting for the pain to get bad. Alternating Tylenol and ibuprofen (if your surgeon OK'd it) can help a lot. Ice the area for 15-20 minutes at a time. Text us back if it's not improving in the next day.",
        autoFollowUp: { hours: 24, type: 'pain_check', prompt: "Hey {name}, checking back on your pain. On the 0-10 scale, where are you today?" },
      },
      {
        key: 'medication_review',
        label: 'Medication Review',
        message: "Hi {name}, this is Dr. {surgeon}'s office RN. Your pain level is higher than we'd like to see. I'm going to check with the surgeon about your pain management plan. We'll text or call you back today with any updates.",
        autoFollowUp: null,
        clinicalGuidance: 'Use when: pain not controlled with current regimen, may need medication adjustment. Nurse discusses with surgeon.',
      },
      {
        key: 'office_visit',
        label: 'Office Visit',
        message: "Hi {name}, this is Dr. {surgeon}'s office RN. Given your pain level, I'd like the surgeon to evaluate you. Please call us at {officePhone} to come in for a visit.",
        autoFollowUp: null,
        includeOfficePhone: true,
      },
      {
        key: 'ed_eval',
        label: 'ED Evaluation',
        message: "Hi {name}, this is Dr. {surgeon}'s office RN. Your pain level and symptoms need to be evaluated. Please go to the emergency department today. If you have questions, call us at {officePhone}.",
        autoFollowUp: null,
        includeOfficePhone: true,
      },
      {
        key: 'callback',
        label: 'Callback',
        message: "Hi {name}, your nurse will be calling you shortly to talk through your pain. If you don't hear back within an hour, please text us.",
        autoFollowUp: null,
      },
    ],
  },

  // ── 4. Possible DVT ──
  possible_dvt: {
    name: 'Possible DVT',
    alertTypes: ['leg_swelling'],
    dispositions: [
      // NOTE: No "Reassure & Watch" — DVT suspicion always gets evaluation or callback
      {
        key: 'office_visit_urgent',
        label: 'Urgent Office Visit',
        message: "Hi {name}, this is Dr. {surgeon}'s office RN. The leg swelling you described needs to be checked out. Please call us at {officePhone} to come in today or tomorrow. If the swelling gets significantly worse, or if you develop chest pain or shortness of breath, go to the ER immediately.",
        autoFollowUp: null,
        includeOfficePhone: true,
        clinicalGuidance: 'DVT suspicion should almost always result in urgent evaluation. Reassure & Watch is NOT appropriate for suspected DVT.',
      },
      {
        key: 'ed_eval',
        label: 'ED Evaluation',
        message: "Hi {name}, this is Dr. {surgeon}'s office RN. The leg symptoms you described need to be evaluated right away. Please go to the emergency department today — they can do an ultrasound to check the blood flow. If you develop chest pain or trouble breathing, call 911.",
        autoFollowUp: null,
        includeOfficePhone: true,
      },
      {
        key: 'callback',
        label: 'Callback',
        message: "Hi {name}, your nurse will be calling you shortly to talk through the leg symptoms you reported. Please don't ignore this — if things get worse before we call, go to the ER. If you don't hear back within an hour, text us.",
        autoFollowUp: null,
      },
    ],
  },

  // ── 5. Fever ──
  fever: {
    name: 'Fever Reported',
    alertTypes: ['fever'],
    dispositions: [
      {
        key: 'monitor',
        label: 'Monitor & Recheck',
        message: "Hi {name}, this is Dr. {surgeon}'s office RN. Thanks for reporting your temperature. Stay hydrated and recheck in a few hours. If it goes above 101.5, if you develop chills, or if you notice any changes at your incision, text us right away.",
        autoFollowUp: { hours: 6, type: 'temp_check', prompt: "Hey {name}, can you check your temperature again and text us the number?" },
      },
      {
        key: 'office_visit',
        label: 'Office Visit',
        message: "Hi {name}, this is Dr. {surgeon}'s office RN. Your fever along with what else you've reported needs to be checked out. Please call us at {officePhone} to come in within the next day.",
        autoFollowUp: null,
        includeOfficePhone: true,
      },
      {
        key: 'ed_eval',
        label: 'ED Evaluation',
        message: "Hi {name}, this is Dr. {surgeon}'s office RN. With your fever and symptoms, I'd like you to be evaluated today. Please go to the emergency department. Call us at {officePhone} if you have questions on the way.",
        autoFollowUp: null,
        includeOfficePhone: true,
      },
      {
        key: 'callback',
        label: 'Callback',
        message: "Hi {name}, your nurse will be calling you shortly to discuss your fever. If you don't hear back within an hour, please text us.",
        autoFollowUp: null,
      },
    ],
  },

  // ── 6. Prolonged Opioid Use ──
  prolonged_opioids: {
    name: 'Prolonged Opioid Use',
    alertTypes: ['still_opioids', 'opioid_prolonged'],
    dispositions: [
      {
        key: 'gentle_outreach',
        label: 'Gentle Outreach',
        message: "Hi {name}, this is Dr. {surgeon}'s office RN. I noticed you're still needing pain medication — that's not unusual, and everyone's recovery timeline is different. A couple things that might help: alternating Tylenol and ibuprofen (if your surgeon is OK with it), ice for 15-20 min at a time, and trying to take the pain pills only when you really need them rather than on a set schedule. You're doing well — keep us posted.",
        autoFollowUp: null,
        clinicalGuidance: 'Default disposition for opioid alerts. The tone matters — patients are often embarrassed or worried about being judged. Warm, non-judgmental framing is essential.',
      },
      {
        key: 'taper_plan',
        label: 'Taper Plan Discussion',
        message: "Hi {name}, this is Dr. {surgeon}'s office RN. I'd like to talk through a plan for tapering down your pain medication. Your nurse will give you a call to work through this together. No rush and no judgment — we just want to make sure you're comfortable and on track.",
        autoFollowUp: null,
        clinicalGuidance: 'Use when: patient reports difficulty cutting back, high daily count, or approaching chronic use threshold.',
      },
      {
        key: 'callback',
        label: 'Callback',
        message: "Hi {name}, your nurse will be calling you to talk about your pain management. This is routine — we check in with all our patients about this. If you don't hear back within an hour, text us.",
        autoFollowUp: null,
      },
    ],
  },

  // ── 7. PHQ-2 Positive ──
  phq2_positive: {
    name: 'Depression Screen Positive',
    alertTypes: ['phq_mood'],
    dispositions: [
      {
        key: 'warm_outreach',
        label: 'Warm Outreach',
        message: "Hi {name}, this is Dr. {surgeon}'s office RN. Thank you for being honest on those mood questions — recovery from surgery can be tough on you emotionally too, and it's more common than people think. If you're feeling down or struggling, please know your care team is here for you. Would it be helpful to talk with someone? We can connect you with support.",
        autoFollowUp: null,
        clinicalGuidance: 'PHQ-2 ≥3 is a screening positive, not a diagnosis. Warm, destigmatizing outreach is the priority. Offer resources without pressure.',
      },
      {
        key: 'callback',
        label: 'Callback',
        message: "Hi {name}, your nurse will be calling you for a check-in. Recovery can be a lot to deal with, and we want to make sure you have the support you need. If you don't hear back within an hour, text us.",
        autoFollowUp: null,
      },
    ],
  },

  // ── 8. Wound Dehiscence / Seroma ──
  wound_dehiscence_seroma: {
    name: 'Wound Dehiscence or Seroma',
    alertTypes: ['wound_open', 'fluid_bulge'],
    dispositions: [
      {
        key: 'office_visit',
        label: 'Office Visit',
        message: "Hi {name}, this is Dr. {surgeon}'s office RN. What you described about your wound needs the surgeon to take a look. Please call us at {officePhone} to come in within the next day or two. Keep the area clean and covered in the meantime. If you see significant bleeding or the opening gets larger, head to the ER.",
        autoFollowUp: null,
        includeOfficePhone: true,
        clinicalGuidance: 'Most dehiscence and seroma require in-person evaluation. Default to office visit.',
      },
      {
        key: 'ed_eval',
        label: 'ED Evaluation',
        message: "Hi {name}, this is Dr. {surgeon}'s office RN. Based on what you described, I'd like you to be seen today. Please go to the emergency department. Call us at {officePhone} if you have questions.",
        autoFollowUp: null,
        includeOfficePhone: true,
      },
      {
        key: 'callback',
        label: 'Callback',
        message: "Hi {name}, your nurse will be calling you shortly to discuss your wound. If you don't hear back within an hour, please text us.",
        autoFollowUp: null,
      },
    ],
  },

  // ── 9. Catch-All: Between-Checkin AI Escalation ──
  conversation_escalation: {
    name: 'Between-Checkin AI Escalation',
    alertTypes: ['conversation'],
    dispositions: [
      {
        key: 'reassure',
        label: 'Reassure',
        message: "Hi {name}, this is Dr. {surgeon}'s office RN. I reviewed your message and everything sounds like it's in the range of normal recovery. If anything changes or gets worse, don't hesitate to text us.",
        autoFollowUp: null,
      },
      {
        key: 'monitor',
        label: 'Monitor',
        message: "Hi {name}, this is Dr. {surgeon}'s office RN. Thanks for reaching out — I'm making a note of what you reported and we'll keep an eye on it at your next check-in. If things change before then, text us.",
        autoFollowUp: null,
      },
      {
        key: 'office_visit',
        label: 'Office Visit',
        message: "Hi {name}, this is Dr. {surgeon}'s office RN. Based on what you described, I think it would be good for the surgeon to take a look. Please call us at {officePhone} to set up a visit.",
        autoFollowUp: null,
        includeOfficePhone: true,
      },
      {
        key: 'callback',
        label: 'Callback',
        message: "Hi {name}, your nurse will be calling you shortly to talk through what you reported. If you don't hear back within an hour, please text us and we'll make sure someone reaches you.",
        autoFollowUp: null,
      },
    ],
  },
};

// ═══════════════════════════════════════════════════
// TEMPLATE RESOLUTION
// ═══════════════════════════════════════════════════

/**
 * Get the template set for a given alert type.
 */
function getTemplatesForAlert(alertType) {
  for (const [key, template] of Object.entries(TEMPLATES)) {
    if (template.alertTypes.includes(alertType)) {
      return { templateKey: key, ...template };
    }
  }
  // Fallback to catch-all
  return { templateKey: 'conversation_escalation', ...TEMPLATES.conversation_escalation };
}

/**
 * Resolve template variables and send the nurse's chosen disposition.
 */
async function sendDisposition(patient, alert, templateKey, dispositionKey, nurseNote = null) {
  const template = TEMPLATES[templateKey];
  if (!template) {
    logger.error('Unknown template key', { templateKey });
    return null;
  }

  const disposition = template.dispositions.find(d => d.key === dispositionKey);
  if (!disposition) {
    logger.error('Unknown disposition key', { templateKey, dispositionKey });
    return null;
  }

  // Resolve variables
  const surgeonClean = (patient.surgeon_name || '').replace(/^Dr\.?\s*/i, '');
  let message = disposition.message
    .replace(/\{name\}/g, patient.first_name)
    .replace(/\{surgeon\}/g, surgeonClean);

  // Office phone — only populate for dispositions that need it
  if (disposition.includeOfficePhone) {
    const officePhone = await getOfficePhone(patient);
    message = message.replace(/\{officePhone\}/g, officePhone || 'your surgeon\'s office');
  }

  // Append nurse's free-text note if provided
  if (nurseNote) {
    message += `\n\n${nurseNote}`;
  }

  // Send to patient
  await sendSMS(patient.phone, message, { patientId: patient.id });

  // Log the disposition
  try {
    await pool.query(
      `INSERT INTO nurse_dispositions 
       (alert_id, patient_id, template_key, disposition_key, message_sent, nurse_note, auto_followup)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        alert.id,
        patient.id,
        templateKey,
        dispositionKey,
        message,
        nurseNote,
        disposition.autoFollowUp ? JSON.stringify(disposition.autoFollowUp) : null,
      ]
    );

    // Update alert status
    await pool.query(
      `UPDATE alerts SET status = 'resolved', resolved_at = NOW(), 
       resolution_note = $1, callback_made = $2
       WHERE id = $3`,
      [
        `Disposition: ${disposition.label}${nurseNote ? ' + note' : ''}`,
        dispositionKey === 'callback',
        alert.id,
      ]
    );

    await audit('nurse', 'disposition_sent', 'alert', alert.id, {
      templateKey, dispositionKey, label: disposition.label,
    });
  } catch (err) {
    logger.error('Failed to log nurse disposition', { error: err.message });
  }

  // Schedule auto-follow-up if applicable
  if (disposition.autoFollowUp) {
    await scheduleFollowUp(patient, disposition.autoFollowUp);
  }

  return { sent: true, dispositionKey, label: disposition.label };
}

/**
 * Get surgeon's office phone for the patient.
 */
async function getOfficePhone(patient) {
  try {
    let query, params;
    if (patient.surgeon_id) {
      query = 'SELECT office_phone FROM surgeons WHERE id = $1';
      params = [patient.surgeon_id];
    } else if (patient.surgeon_name) {
      query = `SELECT office_phone FROM surgeons WHERE active = TRUE AND LOWER(name) = LOWER($1) LIMIT 1`;
      params = [patient.surgeon_name];
    } else {
      return null;
    }

    const result = await pool.query(query, params);
    return result.rows[0]?.office_phone || null;
  } catch (err) {
    logger.warn('Failed to get office phone', { error: err.message });
    return null;
  }
}

/**
 * Schedule an auto-follow-up (photo request, pain check, temp check).
 */
async function scheduleFollowUp(patient, followUp) {
  const triggerAt = new Date(Date.now() + followUp.hours * 3600000);
  try {
    await pool.query(
      `INSERT INTO scheduled_followups (patient_id, type, prompt, trigger_at)
       VALUES ($1, $2, $3, $4)`,
      [patient.id, followUp.type, followUp.prompt.replace(/\{name\}/g, patient.first_name), triggerAt]
    );
    logger.info('Auto-follow-up scheduled', { patientId: patient.id, type: followUp.type, triggerAt });
  } catch (err) {
    logger.warn('Failed to schedule follow-up (table may not exist yet)', { error: err.message });
  }
}

module.exports = {
  TEMPLATES,
  getTemplatesForAlert,
  sendDisposition,
};
