/**
 * Patient Self-Enrollment — SMS Conversational Flow
 * 
 * Patient texts JOIN to enroll themselves. System walks them through:
 *   Step 1: First and last name
 *   Step 2: Surgeon's last name
 *   Step 3: Procedure (with examples)
 *   Step 4: Surgery date (today, tomorrow, or a date)
 *   Step 5: Pre-surgical goal (optional)
 *   Step 6: Confirmation + consent
 * 
 * State is tracked in a lightweight in-memory map keyed by phone hash.
 * On completion, patient is inserted into the DB exactly like clinician enrollment.
 * 
 * Trigger keywords: JOIN, START, SIGNUP, ENROLL ME (from non-clinician phones)
 */
const crypto = require('crypto');
const { pool, audit } = require('../utils/db');
const { sendSMS } = require('./twilio');
const logger = require('../utils/logger');

// In-memory enrollment sessions (phone_hash -> state)
// These are short-lived (expire after 30 min of inactivity)
const enrollmentSessions = new Map();

const ENROLLMENT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

const FACILITY_NAME = process.env.FACILITY_NAME || 'TidalHealth Peninsula Regional';

/**
 * Check if an inbound message is a self-enrollment trigger.
 */
function isSelfEnrollmentTrigger(body) {
  const upper = body.trim().toUpperCase();
  return upper === 'JOIN' || upper === 'START' || upper === 'SIGNUP' || upper === 'ENROLL ME';
}

/**
 * Check if there's an active enrollment session for this phone.
 */
function hasActiveEnrollmentSession(phone) {
  const hash = crypto.createHash('sha256').update(phone).digest('hex');
  const session = enrollmentSessions.get(hash);
  if (!session) return false;
  
  // Check expiry
  if (Date.now() - session.lastActivity > ENROLLMENT_TIMEOUT_MS) {
    enrollmentSessions.delete(hash);
    return false;
  }
  return true;
}

/**
 * Start or continue a self-enrollment conversation.
 * Returns { handled: true/false, type: string }
 */
async function handleSelfEnrollment(phone, body) {
  const hash = crypto.createHash('sha256').update(phone).digest('hex');
  
  // Check if already enrolled
  const existing = await pool.query(
    `SELECT id, first_name, procedure_name, status FROM patients 
     WHERE phone_hash = $1 AND status IN ('enrolled', 'active') 
     ORDER BY surgery_date DESC LIMIT 1`,
    [hash]
  );
  
  if (existing.rows.length > 0 && isSelfEnrollmentTrigger(body)) {
    const p = existing.rows[0];
    await sendSMS(phone, 
      `You're already enrolled for post-surgical check-ins, ${p.first_name}. ` +
      `We'll keep texting you at your scheduled times. Reply STOP to opt out.`
    );
    return { handled: true, type: 'self_enroll_already_enrolled' };
  }

  // Check for active enrollment session
  let session = enrollmentSessions.get(hash);
  
  // New enrollment trigger
  if (isSelfEnrollmentTrigger(body)) {
    session = {
      step: 'name',
      data: {},
      phone,
      phoneHash: hash,
      startedAt: Date.now(),
      lastActivity: Date.now(),
    };
    enrollmentSessions.set(hash, session);
    
    await sendSMS(phone, [
      `Welcome to SurgHome post-surgical recovery check-ins at ${FACILITY_NAME}.`,
      ``,
      `I'll get you set up in about a minute. First:`,
      ``,
      `What is your first and last name?`,
    ].join('\n'));
    
    return { handled: true, type: 'self_enroll_started' };
  }
  
  // No active session and not a trigger — don't handle
  if (!session) return { handled: false };
  
  // Update activity timestamp
  session.lastActivity = Date.now();
  
  // Check for cancel
  const upper = body.trim().toUpperCase();
  if (upper === 'CANCEL' || upper === 'QUIT' || upper === 'NEVERMIND') {
    enrollmentSessions.delete(hash);
    await sendSMS(phone, `No problem — enrollment cancelled. Text JOIN anytime to start again.`);
    return { handled: true, type: 'self_enroll_cancelled' };
  }
  
  // Route to current step
  switch (session.step) {
    case 'name':
      return await handleNameStep(phone, body, session);
    case 'surgeon':
      return await handleSurgeonStep(phone, body, session);
    case 'procedure':
      return await handleProcedureStep(phone, body, session);
    case 'surgery_date':
      return await handleDateStep(phone, body, session);
    case 'goal':
      return await handleGoalStep(phone, body, session);
    case 'confirm':
      return await handleConfirmStep(phone, body, session);
    default:
      enrollmentSessions.delete(hash);
      return { handled: false };
  }
}

// ===================================================
// STEP HANDLERS
// ===================================================

async function handleNameStep(phone, body, session) {
  const trimmed = body.trim();
  const parts = trimmed.split(/\s+/);
  
  if (parts.length < 2) {
    await sendSMS(phone, `Please reply with your first and last name. Example: Margaret Thompson`);
    return { handled: true, type: 'self_enroll_name_retry' };
  }
  
  session.data.firstName = parts[0].charAt(0).toUpperCase() + parts[0].slice(1).toLowerCase();
  session.data.lastName = parts.slice(1).map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join(' ');
  session.step = 'surgeon';
  
  await sendSMS(phone, `Thanks ${session.data.firstName}! What is your surgeon's last name?`);
  return { handled: true, type: 'self_enroll_name_captured' };
}

async function handleSurgeonStep(phone, body, session) {
  const trimmed = body.trim().replace(/^Dr\.?\s*/i, '');
  
  if (trimmed.length < 2) {
    await sendSMS(phone, `Please reply with your surgeon's last name. Example: Patel`);
    return { handled: true, type: 'self_enroll_surgeon_retry' };
  }
  
  session.data.surgeonName = trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase();
  session.step = 'procedure';
  
  await sendSMS(phone, [
    `Dr. ${session.data.surgeonName} — got it.`,
    ``,
    `What procedure are you having? Just describe it however you know it.`,
    ``,
    `Examples: gallbladder removal, knee replacement, hernia repair, appendectomy`,
  ].join('\n'));
  return { handled: true, type: 'self_enroll_surgeon_captured' };
}

async function handleProcedureStep(phone, body, session) {
  const trimmed = body.trim();
  
  if (trimmed.length < 3) {
    await sendSMS(phone, `Please describe your procedure — even a short description is fine. Example: gallbladder removal`);
    return { handled: true, type: 'self_enroll_procedure_retry' };
  }
  
  session.data.procedure = normalizeProcedure(trimmed);
  session.step = 'surgery_date';
  
  await sendSMS(phone, [
    `Got it: ${session.data.procedure}.`,
    ``,
    `When is your surgery? Reply:`,
    `  TODAY`,
    `  TOMORROW`,
    `  Or a date like: March 5`,
  ].join('\n'));
  return { handled: true, type: 'self_enroll_procedure_captured' };
}

async function handleDateStep(phone, body, session) {
  const trimmed = body.trim().toLowerCase();
  let surgeryDate;
  
  if (trimmed === 'today') {
    surgeryDate = new Date();
  } else if (trimmed === 'tomorrow') {
    surgeryDate = new Date(Date.now() + 86400000);
  } else {
    surgeryDate = parseFlexibleDate(trimmed);
    if (!surgeryDate) {
      await sendSMS(phone, `I couldn't understand that date. Please reply TODAY, TOMORROW, or a date like "March 5" or "3/5".`);
      return { handled: true, type: 'self_enroll_date_retry' };
    }
  }
  
  // Sanity check
  const now = new Date();
  const daysDiff = Math.floor((surgeryDate - now) / 86400000);
  if (daysDiff < -1) {
    await sendSMS(phone, `That date seems to be in the past. Please reply with your upcoming surgery date, or TODAY if it's today.`);
    return { handled: true, type: 'self_enroll_date_past' };
  }
  if (daysDiff > 30) {
    await sendSMS(phone, `That's more than 30 days out. Text us back closer to your surgery date — we'll be here! Text JOIN when you're ready.`);
    enrollmentSessions.delete(session.phoneHash);
    return { handled: true, type: 'self_enroll_date_too_far' };
  }
  
  session.data.surgeryDate = surgeryDate.toISOString().split('T')[0];
  session.step = 'goal';
  
  await sendSMS(phone, [
    `Surgery date: ${formatDateFriendly(surgeryDate)}.`,
    ``,
    `Last question — what's your #1 goal for after surgery? This helps us check in on what matters to you.`,
    ``,
    `Example: "get back to walking my dog" or "eat without pain"`,
    ``,
    `Or reply SKIP if you'd rather not answer.`,
  ].join('\n'));
  return { handled: true, type: 'self_enroll_date_captured' };
}

async function handleGoalStep(phone, body, session) {
  const trimmed = body.trim();
  
  if (trimmed.toUpperCase() === 'SKIP') {
    session.data.goal = null;
  } else {
    session.data.goal = trimmed;
  }
  
  session.step = 'confirm';
  
  const goalLine = session.data.goal 
    ? `Goal: "${session.data.goal}"` 
    : `Goal: (skipped)`;
  
  await sendSMS(phone, [
    `Here's what I have:`,
    ``,
    `Name: ${session.data.firstName} ${session.data.lastName}`,
    `Surgeon: Dr. ${session.data.surgeonName}`,
    `Procedure: ${session.data.procedure}`,
    `Surgery: ${formatDateFriendly(new Date(session.data.surgeryDate))}`,
    goalLine,
    ``,
    `Reply YES to confirm and enroll, or NO to cancel.`,
    ``,
    `By confirming, you agree to receive automated SMS check-ins for 30 days after surgery. Reply STOP anytime to opt out. Msg & data rates may apply.`,
  ].join('\n'));
  return { handled: true, type: 'self_enroll_goal_captured' };
}

async function handleConfirmStep(phone, body, session) {
  const upper = body.trim().toUpperCase();
  
  if (upper === 'NO' || upper === 'N' || upper === 'CANCEL') {
    enrollmentSessions.delete(session.phoneHash);
    await sendSMS(phone, `Enrollment cancelled. Text JOIN anytime to start again.`);
    return { handled: true, type: 'self_enroll_declined' };
  }
  
  if (upper !== 'YES' && upper !== 'Y' && upper !== 'CONFIRM') {
    await sendSMS(phone, `Please reply YES to confirm enrollment or NO to cancel.`);
    return { handled: true, type: 'self_enroll_confirm_retry' };
  }
  
  // Create the patient record
  try {
    const result = await pool.query(
      `INSERT INTO patients (first_name, last_name, phone, phone_hash, surgeon_name, procedure_name, surgery_date, pre_surgical_goal, enrollment_method)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'self_sms') RETURNING id, status`,
      [
        session.data.firstName,
        session.data.lastName,
        phone,
        session.phoneHash,
        session.data.surgeonName,
        session.data.procedure,
        session.data.surgeryDate,
        session.data.goal,
      ]
    );
    
    const patient = result.rows[0];
    
    await audit('patient:self', 'patient_enrolled_self_sms', 'patient', patient.id, {
      procedure: session.data.procedure,
      surgeonName: session.data.surgeonName,
      method: 'self_sms',
    });
    
    logger.info('Patient self-enrolled via SMS', { 
      patientId: patient.id, 
      procedure: session.data.procedure,
    });
    
    const surgeryDate = new Date(session.data.surgeryDate);
    const today = new Date().toISOString().split('T')[0];
    const isToday = session.data.surgeryDate === today;
    
    await sendSMS(phone, [
      `You're enrolled, ${session.data.firstName}! Here's what to expect:`,
      ``,
      isToday 
        ? `We'll check in this evening after your surgery.`
        : `We'll check in the evening of your surgery (${formatDateFriendly(surgeryDate)}).`,
      ``,
      `Over the next 30 days, you'll get 6 quick check-ins by text. Each takes about a minute. If we spot anything concerning, your care team will follow up.`,
      ``,
      `Reply STOP anytime to opt out.`,
      `Reply HELP if you need assistance.`,
    ].join('\n'));
    
    enrollmentSessions.delete(session.phoneHash);
    
    return { handled: true, type: 'self_enroll_complete', patientId: patient.id };
    
  } catch (err) {
    logger.error('Self-enrollment DB insert failed', { error: err.message, phone: phone.slice(-4) });
    
    if (err.message?.includes('duplicate') || err.code === '23505') {
      await sendSMS(phone, `It looks like you're already enrolled. We'll keep checking in at your scheduled times. Reply STOP to opt out.`);
    } else {
      await sendSMS(phone, `Sorry, something went wrong. Please try again or ask your care team to enroll you.`);
    }
    
    enrollmentSessions.delete(session.phoneHash);
    return { handled: true, type: 'self_enroll_error' };
  }
}

// ===================================================
// HELPERS
// ===================================================

/**
 * Normalize common patient descriptions to clinical procedure names.
 */
function normalizeProcedure(input) {
  const lower = input.toLowerCase();
  
  const map = [
    { patterns: ['gallbladder', 'cholecystectomy', 'gall bladder'], result: 'Laparoscopic Cholecystectomy' },
    { patterns: ['appendix', 'appendectomy', 'appy'], result: 'Laparoscopic Appendectomy' },
    { patterns: ['knee replacement', 'total knee', 'tka', 'tkr'], result: 'Total Knee Arthroplasty' },
    { patterns: ['hip replacement', 'total hip', 'tha', 'thr'], result: 'Total Hip Arthroplasty' },
    { patterns: ['hernia'], result: 'Hernia Repair' },
    { patterns: ['hysterectomy'], result: 'Hysterectomy' },
    { patterns: ['colectomy', 'colon resection', 'colon removal', 'bowel resection'], result: 'Colectomy' },
    { patterns: ['mastectomy', 'breast removal'], result: 'Mastectomy' },
    { patterns: ['lumpectomy', 'breast lump'], result: 'Lumpectomy' },
    { patterns: ['rotator cuff', 'shoulder repair'], result: 'Rotator Cuff Repair' },
    { patterns: ['acl', 'knee scope', 'knee arthroscopy'], result: 'Knee Arthroscopy' },
    { patterns: ['back surgery', 'spinal fusion', 'laminectomy', 'spine'], result: 'Spinal Surgery' },
    { patterns: ['thyroid', 'thyroidectomy'], result: 'Thyroidectomy' },
  ];
  
  for (const entry of map) {
    if (entry.patterns.some(p => lower.includes(p))) {
      return entry.result;
    }
  }
  
  // If no match, title-case whatever they said
  return input.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

/**
 * Parse flexible date input from patients.
 */
function parseFlexibleDate(input) {
  const clean = input.trim().toLowerCase();
  
  const months = {
    jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2,
    apr: 3, april: 3, may: 4, jun: 5, june: 5,
    jul: 6, july: 6, aug: 7, august: 7, sep: 8, september: 8,
    oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
  };
  
  // "March 5" or "Mar 5"
  const monthNameMatch = clean.match(/^(\w+)\s+(\d{1,2})(?:st|nd|rd|th)?$/);
  if (monthNameMatch) {
    const monthNum = months[monthNameMatch[1]];
    if (monthNum !== undefined) {
      const day = parseInt(monthNameMatch[2]);
      const year = new Date().getFullYear();
      const date = new Date(year, monthNum, day);
      if (date < new Date() - 86400000) {
        date.setFullYear(year + 1);
      }
      return date;
    }
  }
  
  // "3/5" or "03/05"
  const slashMatch = clean.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (slashMatch) {
    const month = parseInt(slashMatch[1]) - 1;
    const day = parseInt(slashMatch[2]);
    let year = slashMatch[3] ? parseInt(slashMatch[3]) : new Date().getFullYear();
    if (year < 100) year += 2000;
    return new Date(year, month, day);
  }
  
  // "3-5" or "03-05"
  const dashMatch = clean.match(/^(\d{1,2})-(\d{1,2})(?:-(\d{2,4}))?$/);
  if (dashMatch) {
    const month = parseInt(dashMatch[1]) - 1;
    const day = parseInt(dashMatch[2]);
    let year = dashMatch[3] ? parseInt(dashMatch[3]) : new Date().getFullYear();
    if (year < 100) year += 2000;
    return new Date(year, month, day);
  }
  
  return null;
}

/**
 * Format a date in a friendly way for SMS.
 */
function formatDateFriendly(date) {
  const today = new Date();
  const tomorrow = new Date(Date.now() + 86400000);
  
  const dateStr = date.toISOString().split('T')[0];
  const todayStr = today.toISOString().split('T')[0];
  const tomorrowStr = tomorrow.toISOString().split('T')[0];
  
  if (dateStr === todayStr) return 'today';
  if (dateStr === tomorrowStr) return 'tomorrow';
  
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  return `${monthNames[date.getMonth()]} ${date.getDate()}`;
}

/**
 * Clean up expired enrollment sessions (call periodically)
 */
function cleanupExpiredSessions() {
  const now = Date.now();
  for (const [hash, session] of enrollmentSessions.entries()) {
    if (now - session.lastActivity > ENROLLMENT_TIMEOUT_MS) {
      enrollmentSessions.delete(hash);
    }
  }
}

// Run cleanup every 10 minutes
setInterval(cleanupExpiredSessions, 10 * 60 * 1000);

module.exports = {
  isSelfEnrollmentTrigger,
  hasActiveEnrollmentSession,
  handleSelfEnrollment,
  normalizeProcedure,
};
