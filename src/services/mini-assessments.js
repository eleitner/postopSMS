/**
 * Mini-Assessment Engine — AI Scribe Layer
 * 
 * Architecture shift:
 *   OLD: Screening question → positive screen → alert fires → nurse calls to gather info
 *   NEW: Screening question → positive screen → AI scribe runs mini-assessment → 
 *         nurse gets complete summary + one-click options → nurse acts
 * 
 * The AI scribe sits BETWEEN the alert trigger and the nurse notification.
 * It does the intake work the nurse would otherwise do on callback.
 * Cuts per-alert time in half, generates structured data for QI.
 * 
 * CRITICAL alerts (chest pain, can't breathe) bypass this entirely — 
 * 911 guidance + nurse alert immediately, no mini-assessment.
 * 
 * 8 Mini-Assessment Types:
 *   1. Wound concern (SSI signs, photo request)
 *   2. Pain escalation (location, quality, onset, meds)
 *   3. GI complaints (nausea, bowel, intake)
 *   4. Urinary concerns (retention, burning, frequency)
 *   5. Breathing/chest (rest vs exertion, cough, DVT screen)
 *   6. Opioid use beyond expected window (schedule, taper, adjuncts)
 *   7. Activity behind milestones (limiting factors, falls, support)
 *   8. PT/OT non-compliance or barriers (attendance, exercises, barriers)
 */
const Anthropic = require('@anthropic-ai/sdk');
const { scrubText, buildSafeContext } = require('./phi-scrubber');
const { pool, audit } = require('../utils/db');
const logger = require('../utils/logger');

let client = null;
function getClient() {
  if (client) return client;
  client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

// ═══════════════════════════════════════════════════
// MINI-ASSESSMENT DEFINITIONS
// ═══════════════════════════════════════════════════

const ASSESSMENTS = {

  wound_concern: {
    name: 'Wound Concern',
    triggers: ['redness', 'wound_open', 'fluid_bulge', 'wound_closed'],
    triggerSeverities: ['URGENT', 'MONITOR'],
    checklist: [
      { key: 'fever_chills', q: 'Any fever, chills, or sweats today?', type: 'yn' },
      { key: 'redness_spread', q: 'Is the redness spreading or staying the same size?', type: 'text' },
      { key: 'swelling', q: 'Any swelling or puffiness around the incision?', type: 'yn' },
      { key: 'tenderness', q: 'Is the area tender or painful to touch?', type: 'yn' },
      { key: 'drainage_color', q: 'Any drainage? If so, is it clear, cloudy/white, or greenish?', type: 'text' },
      { key: 'wound_edges', q: 'Are the wound edges coming apart at all?', type: 'yn' },
    ],
    photoRequest: true,
    photoPrompt: 'Can you snap a photo of the area and text it to us? That really helps the nurse.',
    skipIfVolunteered: ['fever', 'redness'], // Skip items patient already answered in screening
  },

  pain_escalation: {
    name: 'Pain Escalation',
    triggers: ['pain'],
    triggerCondition: (parsed, allResponses) => parsed > 7,
    triggerSeverities: ['URGENT'],
    checklist: [
      { key: 'pain_location', q: 'Where exactly is the pain — at the incision, or somewhere else?', type: 'text' },
      { key: 'pain_quality', q: 'What does it feel like — sharp, dull, burning, or pressure?', type: 'text' },
      { key: 'pain_onset', q: 'Did this come on suddenly, or has it been building up?', type: 'text' },
      { key: 'pain_worse', q: 'Does anything make it worse — moving, breathing, eating?', type: 'text' },
      { key: 'pain_better', q: 'Does anything help — rest, ice, medication?', type: 'text' },
      { key: 'med_compliance', q: 'Have you been taking your pain meds as prescribed?', type: 'yn' },
      { key: 'last_dose', q: 'When did you last take a pain pill?', type: 'text' },
    ],
    photoRequest: false,
    skipIfVolunteered: ['pain_trend'],
  },

  gi_complaints: {
    name: 'GI Complaints',
    triggers: ['fluids', 'bowel'],
    triggerSeverities: ['URGENT', 'MONITOR'],
    checklist: [
      { key: 'nausea_vomiting', q: 'Any nausea or vomiting? If so, how many times today?', type: 'text' },
      { key: 'keeping_down', q: 'Are you able to keep anything down — sips of water, crackers, anything?', type: 'text' },
      { key: 'last_bm', q: 'When was your last bowel movement?', type: 'text' },
      { key: 'passing_gas', q: 'Are you able to pass gas? (Yes/No)', type: 'yn' },
      { key: 'blood_stool', q: 'Any blood in your stool? (Yes/No)', type: 'yn' },
      { key: 'oral_intake', q: 'What have you been able to eat or drink today?', type: 'text' },
    ],
    photoRequest: false,
    skipIfVolunteered: ['bowel'],
  },

  urinary_concerns: {
    name: 'Urinary Concerns',
    triggers: ['urination'],
    triggerSeverities: ['URGENT', 'MONITOR'],
    checklist: [
      { key: 'last_void', q: 'When did you last urinate?', type: 'text' },
      { key: 'burning', q: 'Any burning or pain when you urinate? (Yes/No)', type: 'yn' },
      { key: 'blood_urine', q: 'Any blood in your urine? (Yes/No)', type: 'yn' },
      { key: 'frequency', q: 'Going more often than usual, or less? (More/Same/Less)', type: 'text' },
      { key: 'complete_empty', q: 'Does it feel like you\'re fully emptying your bladder? (Yes/No)', type: 'yn' },
    ],
    photoRequest: false,
    skipIfVolunteered: [],
  },

  breathing_chest: {
    name: 'Breathing / Chest Concern',
    // Note: Most chest pain → CRITICAL (bypass mini-assessment). This catches borderline.
    triggers: ['groggy'], // catches "shortness of breath" flagged by conversation handler
    triggerSeverities: ['URGENT', 'MONITOR'],
    checklist: [
      { key: 'at_rest', q: 'Is the shortness of breath at rest, or only with activity?', type: 'text' },
      { key: 'new_vs_worse', q: 'Is this new since surgery, or getting worse?', type: 'text' },
      { key: 'chest_pressure', q: 'Any chest pain or pressure? (Yes/No)', type: 'yn', criticalEscalate: true },
      { key: 'calf_pain', q: 'Any pain or swelling in one calf or leg? (Yes/No)', type: 'yn' },
      { key: 'cough', q: 'Any new cough? (Yes/No)', type: 'yn' },
    ],
    photoRequest: false,
    skipIfVolunteered: [],
    escalateIfCritical: true, // If chest_pressure = yes → immediate CRITICAL, stop assessment
  },

  opioid_prolonged: {
    name: 'Opioid Use Beyond Expected Window',
    triggers: ['still_opioids', 'opioids'],
    triggerSeverities: ['URGENT', 'MONITOR'],
    // Triggered by procedure-config benchmark comparison, not just raw protocol alert
    checklist: [
      { key: 'schedule_vs_prn', q: 'Are you taking pain pills on a schedule, or only when the pain gets bad?', type: 'text' },
      { key: 'daily_count', q: 'About how many pills per day right now?', type: 'num' },
      { key: 'taper_attempts', q: 'Have you tried cutting back? How did that go?', type: 'text' },
      { key: 'adjuncts', q: 'Are you also using Tylenol, ibuprofen, ice, or heat? (Yes/No)', type: 'text' },
      { key: 'timing_pattern', q: 'When is the pain worst — all day, mostly at night, or mainly with activity?', type: 'text' },
    ],
    photoRequest: false,
    skipIfVolunteered: ['opioids'],
    tone: 'warm_nonjudgmental', // Special tone flag — patients may be embarrassed
  },

  activity_behind: {
    name: 'Activity Behind Milestones',
    triggers: ['moving', 'activity'],
    triggerSeverities: ['MONITOR'],
    // Triggered by procedure-config activity benchmark comparison
    checklist: [
      { key: 'limiting_factor', q: 'What\'s the main thing holding you back — pain, weakness, dizziness, fear of hurting something, or just fatigue?', type: 'text' },
      { key: 'falls', q: 'Any falls or near-falls since surgery? (Yes/No)', type: 'yn' },
      { key: 'support_at_home', q: 'Do you have someone at home who can help you get around? (Yes/No)', type: 'yn' },
      { key: 'bed_vs_up', q: 'On a typical day, are you mostly in bed, mostly sitting up, or up and moving some?', type: 'text' },
    ],
    photoRequest: false,
    skipIfVolunteered: ['moving'],
  },

  pt_ot_barriers: {
    name: 'PT/OT Non-Compliance or Barriers',
    triggers: ['pt_started', 'pt_exercises'],
    triggerSeverities: ['MONITOR'],
    // Only triggered for procedures where ptOtExpected = true
    checklist: [
      { key: 'pt_attendance', q: 'Have you been able to get to your PT appointments? (Yes/Some/Not yet)', type: 'text' },
      { key: 'attendance_barrier', q: 'If you haven\'t started or have missed sessions — is it an appointment issue, transportation, insurance, or something else?', type: 'text' },
      { key: 'exercise_compliance', q: 'Are you doing the home exercises your PT gave you? (Every day / Most days / Sometimes / Not really)', type: 'text' },
      { key: 'exercise_barrier', q: 'Is pain limiting your exercises, or are the instructions unclear, or are you worried about hurting something?', type: 'text' },
      { key: 'written_plan', q: 'Do you have a written exercise plan to follow at home? (Yes/No)', type: 'yn' },
    ],
    photoRequest: false,
    skipIfVolunteered: [],
  },
};

// ═══════════════════════════════════════════════════
// AI SCRIBE SYSTEM PROMPT
// ═══════════════════════════════════════════════════

const SCRIBE_SYSTEM_PROMPT = `You are an AI scribe conducting a focused mini-assessment for a post-surgical patient via text message. A screening question has triggered a concern, and you're gathering more detail before the information goes to the triage nurse.

YOUR ROLE:
- You are doing the intake work the nurse would do on a callback
- Ask the questions from the checklist you're given, ONE AT A TIME
- Skip items the patient already answered in the screening
- If the patient volunteers information that covers a checklist item, mark it complete and move on
- Keep it conversational — you're texting, not running a survey

YOUR TONE:
- Warm, calm, conversational — like a nurse who cares
- Brief — 1-2 sentences per message
- Never alarming, never dismissive
- If the assessment type is "warm_nonjudgmental" (opioid-related), be especially gentle — no judgment, no shame

RULES:
- Ask ONE question at a time. Wait for the response before asking the next.
- If a patient response reveals something CRITICAL (chest pain, can't breathe, uncontrolled bleeding), STOP the assessment immediately and escalate.
- When all items are covered, send a brief closing: "Thanks — I'm putting all of this together for your nurse."
- NEVER diagnose, prescribe, or give specific medical instructions
- NEVER ask for identifying information

You will receive:
- The triggering alert (what prompted this assessment)
- The checklist items to cover
- Items already answered (skip these)
- Patient's clinical context (procedure, POD, recent data)

RESPOND ONLY IN THIS JSON FORMAT:
{
  "message": "Your next text to the patient (1-2 sentences)",
  "nextAction": "ask_next" | "complete" | "critical_escalate",
  "coveredItems": ["key1", "key2"],
  "criticalReason": "reason (only if nextAction is critical_escalate)"
}`;

// ═══════════════════════════════════════════════════
// MINI-ASSESSMENT SESSION MANAGEMENT
// ═══════════════════════════════════════════════════

/**
 * Determine which mini-assessment(s) to run based on a triggered alert.
 * Returns the assessment type or null if no assessment applies.
 */
function selectAssessment(questionKey, alertSeverity, allResponses, procedureConfig) {
  // CRITICAL alerts bypass mini-assessment entirely
  if (alertSeverity === 'CRITICAL') return null;

  for (const [assessmentKey, assessment] of Object.entries(ASSESSMENTS)) {
    // Check if triggering question matches
    if (!assessment.triggers.includes(questionKey)) continue;

    // Check if severity matches
    if (!assessment.triggerSeverities.includes(alertSeverity)) continue;

    // Special checks for procedure-config-driven assessments
    if (assessmentKey === 'pt_ot_barriers' && !procedureConfig?.ptOtExpected) continue;

    return assessmentKey;
  }

  return null;
}

/**
 * Start a mini-assessment session. Creates the session record, determines
 * which checklist items to skip (already volunteered), and sends the first question.
 */
async function startMiniAssessment(patient, checkinSession, assessmentType, triggerContext) {
  const assessment = ASSESSMENTS[assessmentType];
  if (!assessment) {
    logger.warn('Unknown assessment type', { assessmentType });
    return null;
  }

  // Determine which items to skip (patient already answered in screening)
  const alreadyAnswered = assessment.skipIfVolunteered.filter(key =>
    triggerContext.allResponses && triggerContext.allResponses[key] !== undefined
  );

  // Build the checklist (excluding already-answered items)
  const pendingItems = assessment.checklist.filter(item =>
    !alreadyAnswered.includes(item.key)
  );

  if (pendingItems.length === 0) {
    // All items already covered — skip mini-assessment, go straight to nurse
    logger.info('Mini-assessment skipped — all items volunteered', { assessmentType });
    return null;
  }

  // Create mini-assessment session in DB
  let maSession;
  try {
    const result = await pool.query(
      `INSERT INTO mini_assessments 
       (patient_id, checkin_session_id, assessment_type, trigger_key, trigger_severity, trigger_reason,
        checklist_items, skipped_items, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active')
       RETURNING *`,
      [
        patient.id,
        checkinSession?.id || null,
        assessmentType,
        triggerContext.questionKey,
        triggerContext.severity,
        triggerContext.reason,
        JSON.stringify(pendingItems.map(i => i.key)),
        JSON.stringify(alreadyAnswered),
      ]
    );
    maSession = result.rows[0];
  } catch (err) {
    logger.error('Failed to create mini-assessment session', { error: err.message });
    return null;
  }

  // Send intro message
  const intro = getIntroMessage(assessmentType, triggerContext);
  const { sendSMS } = require('./twilio');
  await sendSMS(patient.phone, intro, { patientId: patient.id });

  // Send first question
  const firstItem = pendingItems[0];
  await sendSMS(patient.phone, firstItem.q, { patientId: patient.id });

  // Update session with current question index
  await pool.query(
    `UPDATE mini_assessments SET current_item_index = 0, started_at = NOW() WHERE id = $1`,
    [maSession.id]
  );

  await audit('system', 'mini_assessment_started', 'mini_assessment', maSession.id, {
    assessmentType, triggerKey: triggerContext.questionKey,
  });

  return maSession;
}

/**
 * Generate a warm intro message for the mini-assessment.
 */
function getIntroMessage(assessmentType, triggerContext) {
  const intros = {
    wound_concern: "I want to get a little more detail about your incision so the nurse has the full picture. Just a few quick questions.",
    pain_escalation: "I'm sorry you're dealing with that level of pain. Let me get a few details so the nurse knows exactly what's going on.",
    gi_complaints: "Let me get a few more details about how your stomach is doing so the nurse can help.",
    urinary_concerns: "Let me ask a couple more questions about that so the nurse has the full picture.",
    breathing_chest: "I want to check on a few things. This is important — please answer as best you can.",
    opioid_prolonged: "I just want to check in about your pain management — no judgment at all. A few quick questions to help the nurse support you.",
    activity_behind: "Let's see what's going on with getting moving. No pressure — just want to understand where you're at.",
    pt_ot_barriers: "Let me ask about your rehab so we can help with anything that's getting in the way.",
  };
  return intros[assessmentType] || "Let me get a few more details for the nurse.";
}

/**
 * Process a patient's response during an active mini-assessment.
 * Returns: { handled, complete, criticalEscalate, assessmentId }
 */
async function processMiniAssessmentResponse(patient, maSession, body) {
  const assessment = ASSESSMENTS[maSession.assessment_type];
  if (!assessment) return { handled: false };

  // Get pending items (excludes skipped)
  const skippedItems = maSession.skipped_items || [];
  const pendingItems = assessment.checklist.filter(item =>
    !skippedItems.includes(item.key)
  );

  const currentIndex = maSession.current_item_index || 0;
  const currentItem = pendingItems[currentIndex];
  if (!currentItem) {
    return completeMiniAssessment(patient, maSession);
  }

  // Store response
  const responses = maSession.responses || {};
  responses[currentItem.key] = {
    value: body.trim(),
    raw: body.trim(),
    time: new Date().toISOString(),
  };

  // Check for critical escalation (e.g., chest pain during breathing assessment)
  if (currentItem.criticalEscalate) {
    const lower = body.trim().toLowerCase();
    if (lower.includes('yes') || lower.includes('y')) {
      // Immediate critical escalation — stop assessment
      await pool.query(
        `UPDATE mini_assessments SET responses = $1, status = 'critical_escalated', completed_at = NOW() WHERE id = $2`,
        [JSON.stringify(responses), maSession.id]
      );

      const { sendSMS } = require('./twilio');
      await sendSMS(patient.phone,
        '🚨 Based on what you\'re describing, I want you to call 911 or go to the ER right away. We\'re also alerting your care team immediately.',
        { patientId: patient.id }
      );

      return {
        handled: true,
        complete: true,
        criticalEscalate: true,
        criticalReason: `${currentItem.key} positive during ${assessment.name} mini-assessment`,
        assessmentId: maSession.id,
        responses,
      };
    }
  }

  // Advance to next item
  const nextIndex = currentIndex + 1;
  await pool.query(
    `UPDATE mini_assessments SET current_item_index = $1, responses = $2 WHERE id = $3`,
    [nextIndex, JSON.stringify(responses), maSession.id]
  );

  // Check if assessment is complete
  if (nextIndex >= pendingItems.length) {
    // Request photo if applicable
    if (assessment.photoRequest) {
      const { sendSMS } = require('./twilio');
      await sendSMS(patient.phone, assessment.photoPrompt, { patientId: patient.id });
    }

    return completeMiniAssessment(patient, { ...maSession, responses });
  }

  // Send next question
  const nextItem = pendingItems[nextIndex];
  const { sendSMS } = require('./twilio');
  await sendSMS(patient.phone, nextItem.q, { patientId: patient.id });

  return { handled: true, complete: false, assessmentId: maSession.id };
}

/**
 * Complete a mini-assessment and generate the nurse summary.
 */
async function completeMiniAssessment(patient, maSession) {
  const assessment = ASSESSMENTS[maSession.assessment_type];
  const responses = maSession.responses || {};

  // Generate AI summary for nurse
  let nurseSummary;
  try {
    nurseSummary = await generateNurseSummary(patient, maSession, assessment, responses);
  } catch (err) {
    logger.error('Failed to generate AI nurse summary', { error: err.message });
    nurseSummary = buildFallbackSummary(maSession, assessment, responses);
  }

  // Update DB
  await pool.query(
    `UPDATE mini_assessments SET 
       status = 'completed', completed_at = NOW(), 
       responses = $1, nurse_summary = $2, data_points = $3
     WHERE id = $4`,
    [
      JSON.stringify(responses),
      nurseSummary.text,
      Object.keys(responses).length,
      maSession.id,
    ]
  );

  // Send closing message to patient
  const { sendSMS } = require('./twilio');
  await sendSMS(patient.phone,
    "Thanks — I'm putting all of this together for your nurse. Someone will follow up with you soon.",
    { patientId: patient.id }
  );

  await audit('system', 'mini_assessment_completed', 'mini_assessment', maSession.id, {
    type: maSession.assessment_type,
    dataPoints: Object.keys(responses).length,
    severity: nurseSummary.severity,
  });

  return {
    handled: true,
    complete: true,
    criticalEscalate: false,
    assessmentId: maSession.id,
    nurseSummary,
    responses,
  };
}

// ═══════════════════════════════════════════════════
// NURSE SUMMARY GENERATION
// ═══════════════════════════════════════════════════

/**
 * Generate a structured nurse summary from the mini-assessment data.
 * Uses AI to synthesize the conversational responses into a clinical summary.
 */
async function generateNurseSummary(patient, maSession, assessment, responses) {
  const anthropic = getClient();

  // Build de-identified context
  const { buildSafeContext } = require('./phi-scrubber');
  const safeCtx = buildSafeContext(patient, [], null);

  const prompt = `Summarize this mini-assessment for a triage nurse. Be concise and clinical.

Assessment type: ${assessment.name}
Trigger: ${maSession.trigger_reason}
Patient context: POD ${safeCtx.pod}, ${safeCtx.procedure}, ${safeCtx.phase}

Patient responses:
${Object.entries(responses).map(([key, val]) => `  ${key}: ${val.value}`).join('\n')}

Provide a JSON response:
{
  "text": "2-3 sentence clinical summary for the nurse",
  "severity": "URGENT or MONITOR",
  "keyFindings": ["finding1", "finding2"],
  "suggestedAction": "recommended next step"
}`;

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 400,
    system: 'You are a clinical summarization assistant. Produce concise, structured summaries for triage nurses. JSON only.',
    messages: [{ role: 'user', content: prompt }],
  });

  const text = message.content[0]?.text || '';
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
  } catch (err) {
    logger.warn('Failed to parse nurse summary AI response', { text: text.substring(0, 200) });
  }

  return buildFallbackSummary(maSession, assessment, responses);
}

/**
 * Fallback summary when AI is unavailable.
 */
function buildFallbackSummary(maSession, assessment, responses) {
  const findings = Object.entries(responses)
    .map(([key, val]) => `${key}: ${val.value}`)
    .join('; ');

  return {
    text: `${assessment.name} assessment completed. Trigger: ${maSession.trigger_reason}. Findings: ${findings}`,
    severity: maSession.trigger_severity || 'MONITOR',
    keyFindings: Object.keys(responses),
    suggestedAction: 'Nurse review recommended',
  };
}

// ═══════════════════════════════════════════════════
// SESSION LOOKUP
// ═══════════════════════════════════════════════════

/**
 * Check if a patient has an active mini-assessment.
 */
async function getActiveMiniAssessment(patientId) {
  try {
    const result = await pool.query(
      `SELECT * FROM mini_assessments 
       WHERE patient_id = $1 AND status = 'active' 
       ORDER BY created_at DESC LIMIT 1`,
      [patientId]
    );
    return result.rows[0] || null;
  } catch (err) {
    logger.warn('Failed to check for active mini-assessment', { error: err.message });
    return null;
  }
}

/**
 * Expire stale mini-assessments (no response in 30 minutes).
 */
async function expireStaleAssessments() {
  try {
    const result = await pool.query(
      `UPDATE mini_assessments 
       SET status = 'expired', completed_at = NOW() 
       WHERE status = 'active' AND started_at < NOW() - INTERVAL '30 minutes'
       RETURNING id, patient_id, assessment_type`
    );

    for (const expired of result.rows) {
      logger.info('Mini-assessment expired', { id: expired.id, type: expired.assessment_type });
      // Still send whatever we have to the nurse
      const maSession = await pool.query('SELECT * FROM mini_assessments WHERE id = $1', [expired.id]);
      if (maSession.rows[0]) {
        const assessment = ASSESSMENTS[maSession.rows[0].assessment_type];
        const summary = buildFallbackSummary(maSession.rows[0], assessment || { name: 'Unknown' }, maSession.rows[0].responses || {});
        await pool.query(
          `UPDATE mini_assessments SET nurse_summary = $1 WHERE id = $2`,
          [summary.text, expired.id]
        );
      }
    }

    return result.rows.length;
  } catch (err) {
    logger.error('Failed to expire stale assessments', { error: err.message });
    return 0;
  }
}

module.exports = {
  ASSESSMENTS,
  selectAssessment,
  startMiniAssessment,
  processMiniAssessmentResponse,
  getActiveMiniAssessment,
  expireStaleAssessments,
  completeMiniAssessment,
};
