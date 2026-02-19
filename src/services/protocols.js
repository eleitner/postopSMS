/**
 * Screening Protocols — Clinical Logic
 * 
 * 6 phases: POD 0, Acute (1-3), Infectious (4-7), Late (14), Recovery (21), Closure (30)
 * Each question has: key, text, type, and optional alert trigger function.
 * Alert triggers return [severity, reason] or null.
 */

const EMERGENCY_KEYWORDS = [
  'cant breathe', "can't breathe", 'chest pain', 'chest hurts',
  "bleeding won't stop", 'bleeding wont stop', 'passed out', 'call 911',
  'stroke', 'seizure', 'unconscious', 'not breathing',
];

const PROTOCOLS = {
  pod0: {
    name: 'POD 0 — Evening Safety',
    targetPOD: 0,
    greeting: `Hi {firstName}, this is the postop care team at {facility} checking in after your surgery today with Dr. {surgeon}. We'll ask a few quick questions to make sure you're doing well tonight. Reply to each one — it only takes a minute.`,
    questions: [
      {
        key: 'pain', type: 'num',
        q: 'How is your pain right now? Reply 0-10.',
        alert: (v) => v > 7 ? ['URGENT', `Pain ${v}/10 on evening of surgery`] : null,
      },
      {
        key: 'bleeding', type: 'yn',
        q: 'Any bleeding soaking through your dressing? (Yes/No)',
        alert: (v) => v === 'yes' ? ['URGENT', 'Active bleeding through dressing POD 0'] : null,
      },
      {
        key: 'fluids', type: 'yn',
        q: 'Are you able to keep fluids down? (Yes/No)',
        alert: (v) => v === 'no' ? ['URGENT', 'Unable to tolerate fluids POD 0'] : null,
      },
      {
        key: 'clearheaded', type: 'yn',
        q: 'Are you feeling clearheaded? (Yes/No)',
        alert: (v) => v === 'no' ? ['MONITOR', 'Not clearheaded POD 0 — possible residual sedation'] : null,
      },
      {
        key: 'urination', type: 'yn',
        q: 'Have you been able to urinate since surgery? (Yes/No)',
        alert: (v) => v === 'no' ? ['MONITOR', 'No urination since surgery POD 0'] : null,
      },
    ],
    closing: `Thank you! Rest well tonight. If anything concerns you, reply HELP or call the hospital. We'll check in again tomorrow.`,
  },

  acute: {
    name: 'Acute Phase (POD 1-3)',
    targetPOD: [1, 2, 3],
    greeting: `Hi {firstName}, POD {pod} check-in from {facility}.`,
    questions: [
      {
        key: 'pain', type: 'num',
        q: 'Rate your pain 0-10.',
        alert: (v) => v > 7 ? ['URGENT', `Pain ${v}/10 in acute phase`] : null,
      },
      {
        key: 'fluids', type: 'yn',
        q: 'Keeping fluids down? (Yes/No)',
        alert: (v) => v === 'no' ? ['URGENT', 'Not tolerating fluids in acute phase'] : null,
      },
      {
        key: 'urination', type: 'yn',
        q: 'Passed urine in last 6-8 hours? (Yes/No)',
        alert: (v) => v === 'no' ? ['MONITOR', 'Urinary retention concern'] : null,
      },
      {
        key: 'bleeding', type: 'yn',
        q: 'Any bleeding through dressing? (Yes/No)',
        alert: (v) => v === 'yes' ? ['URGENT', 'Bleeding through dressing acute phase'] : null,
      },
      {
        key: 'groggy', type: 'yn',
        q: 'Feeling overly groggy, confused, or itchy? (Yes/No)',
        alert: (v) => v === 'yes' ? ['MONITOR', 'Excess sedation/confusion/pruritus — possible opioid effect'] : null,
      },
      {
        key: 'opioids', type: 'num',
        q: 'How many pain pills today?',
      },
      {
        key: 'moving', type: 'yn',
        q: 'Getting up and moving around? (Yes/No)',
        alert: (v) => v === 'no' ? ['MONITOR', 'Not ambulating — DVT/PE risk'] : null,
      },
    ],
    closing: `Thanks! Keep moving when you can. Reply HELP anytime if you need us.`,
  },

  infectious: {
    name: 'Infectious Phase (POD 4-7)',
    targetPOD: [4, 5, 6, 7],
    greeting: `Good morning {firstName}, POD {pod} check-in from {facility}.`,
    questions: [
      {
        key: 'redness', type: 'yn',
        q: 'Any spreading redness, heat, or thick discharge at your incision? (Yes/No)',
        alert: (v) => v === 'yes' ? ['URGENT', 'Possible SSI: redness/discharge at incision'] : null,
      },
      {
        key: 'leg_swelling', type: 'yn',
        q: 'Is one leg significantly more swollen or painful than the other? (Yes/No)',
        alert: (v) => v === 'yes' ? ['URGENT', 'Unilateral leg swelling — possible DVT'] : null,
      },
      {
        key: 'bowel', type: 'yn',
        q: 'Have you had a bowel movement since surgery? (Yes/No)',
        alert: (v) => v === 'no' ? ['MONITOR', 'No bowel movement by infectious phase — possible ileus'] : null,
      },
      {
        key: 'fever', type: 'text',
        q: 'Any fever or chills? If yes, what is your temperature?',
        alert: (v) => {
          const lower = (v || '').toLowerCase();
          if (lower === 'no' || lower === 'n') return null;
          // Extract temperature if provided
          const tempMatch = lower.match(/(\d{2,3}\.?\d?)/);
          if (tempMatch) {
            const temp = parseFloat(tempMatch[1]);
            if (temp >= 100.4) return ['URGENT', `Fever reported: ${temp}°F in infectious window`];
          }
          if (lower.includes('yes') || lower.includes('chills')) {
            return ['URGENT', 'Fever/chills reported in infectious window'];
          }
          return null;
        },
      },
      {
        key: 'pain_trend', type: 'text',
        q: 'Compared to 2 days ago, is your pain: Better / Same / Worse?',
        alert: (v) => {
          const lower = (v || '').toLowerCase();
          if (lower.includes('worse')) return ['URGENT', 'Pain worsening in infectious window'];
          return null;
        },
      },
      {
        key: 'opioids', type: 'num',
        q: 'How many pain pills per day now?',
      },
    ],
    closing: `Thanks for checking in. If you develop a fever above 100.4°F, new redness, or increasing pain, reply HELP immediately.`,
  },

  late: {
    name: 'Late Phase (POD 14)',
    targetPOD: 14,
    greeting: `Hi {firstName}, your 2-week postop check-in from {facility}.`,
    questions: [
      {
        key: 'wound_open', type: 'yn',
        q: 'Have the edges of your wound pulled apart? (Yes/No)',
        alert: (v) => v === 'yes' ? ['URGENT', 'Possible wound dehiscence at POD 14'] : null,
      },
      {
        key: 'fluid_bulge', type: 'yn',
        q: 'Any fluid-filled bulge under the incision? (Yes/No)',
        alert: (v) => v === 'yes' ? ['URGENT', 'Possible seroma/hematoma at POD 14'] : null,
      },
      {
        key: 'still_opioids', type: 'yn',
        q: 'Still taking prescription pain meds? (Yes/No)',
        alert: (v) => v === 'yes' ? ['MONITOR', 'Still on opioids at POD 14'] : null,
      },
      {
        key: 'wound_closed', type: 'yn',
        q: 'Is your incision fully closed? (Yes/No)',
        alert: (v) => v === 'no' ? ['MONITOR', 'Wound not fully closed at POD 14'] : null,
      },
      {
        key: 'activity', type: 'text',
        q: 'Back to walking around the house/neighborhood? (Yes/Some/Not yet)',
      },
    ],
    closing: `Thanks! You're at 2 weeks — most of the hard part is behind you. We'll check in once more at 3 weeks.`,
  },

  recovery: {
    name: 'Recovery (POD 21)',
    targetPOD: 21,
    greeting: `Hi {firstName}, it's been 3 weeks since your surgery with Dr. {surgeon}. Quick check-in.`,
    questions: [
      {
        key: 'pain_trend', type: 'text',
        q: 'Compared to LAST WEEK, is your pain: Better / Same / Worse?',
        alert: (v) => {
          const lower = (v || '').toLowerCase();
          if (lower.includes('worse')) return ['URGENT', 'Pain worsening at POD 21 — unexpected trajectory'];
          return null;
        },
      },
      {
        key: 'still_opioids', type: 'yn',
        q: 'Still taking prescription pain meds? (Yes/No)',
        alert: (v) => v === 'yes' ? ['URGENT', 'Still on opioids at 3 weeks — prolonged use risk'] : null,
      },
      {
        key: 'driving', type: 'yn',
        q: 'Are you able to drive? (Yes/No)',
      },
      {
        key: 'phq_interest', type: 'num',
        q: 'Over the past 2 weeks, how often have you had little interest or pleasure in doing things? (0=Not at all, 1=Several days, 2=More than half, 3=Nearly every day)',
      },
      {
        key: 'phq_mood', type: 'num',
        q: 'How often have you been feeling down, depressed, or hopeless? (0-3, same scale)',
        alert: (v, allResponses) => {
          const interest = parseInt(allResponses.phq_interest) || 0;
          const mood = parseInt(v) || 0;
          const total = interest + mood;
          if (total >= 3) return ['URGENT', `PHQ-2 score ${total} (≥3 threshold) — depression screen positive`];
          return null;
        },
      },
    ],
    closing: `Thanks! One final check-in at 30 days, then we're done. You're doing great.`,
  },

  closure: {
    name: 'Outcomes Closure (POD 30)',
    targetPOD: 30,
    greeting: `Hi {firstName}, it's been a month since your {procedure} with Dr. {surgeon}. Last check-in — we'd love your feedback.`,
    questions: [
      {
        key: 'satisfaction', type: 'text',
        q: 'Overall, are you satisfied with your surgery results? (Very satisfied / Satisfied / Neutral / Dissatisfied / Very dissatisfied)',
      },
      {
        key: 'would_repeat', type: 'text',
        q: 'Knowing what you know now, would you have the surgery again? (Definitely / Probably / Unsure / Probably not / Definitely not)',
      },
      {
        key: 'still_opioids', type: 'yn',
        q: 'Still taking prescription pain medication? (Yes/No)',
        alert: (v) => v === 'yes' ? ['URGENT', 'Still on opioids at 30 days — chronic use risk'] : null,
      },
      {
        key: 'complications', type: 'text',
        q: 'Any new symptoms, ER visits, or unexpected doctor visits since surgery?',
      },
      {
        key: 'goals_met', type: 'yn',
        q: 'Before surgery you hoped for: "{goal}". Do you feel that goal has been met? (Yes/Partially/No)',
      },
    ],
    closing: `Thank you, {firstName}. Your feedback helps us improve care at {facility}. Wishing you a full recovery!`,
  },
};

/**
 * Parse a patient response based on expected type
 */
function parseResponse(type, text) {
  const t = (text || '').trim().toLowerCase();
  if (type === 'num') {
    const n = parseInt(t.replace(/[^0-9]/g, ''));
    return isNaN(n) ? t : n;
  }
  if (type === 'yn') {
    if (/^(y|yes|yeah|yep|yea)$/i.test(t)) return 'yes';
    if (/^(n|no|nah|nope)$/i.test(t)) return 'no';
    return t;
  }
  return t;
}

/**
 * Check if text contains emergency keywords
 */
function isEmergency(text) {
  const lower = (text || '').trim().toLowerCase();
  return EMERGENCY_KEYWORDS.some(kw => lower.includes(kw));
}

/**
 * Get the scheduled phases for a given POD
 */
function getPhaseForPOD(pod) {
  if (pod === 0) return 'pod0';
  if (pod >= 1 && pod <= 3) return 'acute';
  if (pod >= 4 && pod <= 7) return 'infectious';
  if (pod === 14) return 'late';
  if (pod === 21) return 'recovery';
  if (pod === 30) return 'closure';
  return null;
}

/**
 * Get all scheduled check-in PODs
 */
function getScheduledPODs() {
  return [0, 2, 5, 14, 21, 30]; // Default schedule — POD 2 for acute, POD 5 for infectious
}

module.exports = { PROTOCOLS, EMERGENCY_KEYWORDS, parseResponse, isEmergency, getPhaseForPOD, getScheduledPODs };
