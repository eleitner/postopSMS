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
    greeting: `Hey {firstName}, it's your care team at {facility} checking in after your surgery with Dr. {surgeon} today. Just a few quick questions to make sure you're settling in OK tonight — takes about a minute.`,
    questions: [
      {
        key: 'pain', type: 'num',
        q: 'How is your pain right now? Give me a number 0-10.',
        alert: (v) => v > 7 ? ['URGENT', `Pain ${v}/10 on evening of surgery`] : null,
      },
      {
        key: 'bleeding', type: 'yn',
        q: 'Any bleeding soaking through your dressing? (Yes/No)',
        alert: (v) => v === 'yes' ? ['URGENT', 'Active bleeding through dressing POD 0'] : null,
      },
      {
        key: 'fluids', type: 'yn',
        q: 'Have you been able to keep fluids down? (Yes/No)',
        alert: (v) => v === 'no' ? ['URGENT', 'Unable to tolerate fluids POD 0'] : null,
      },
      {
        key: 'clearheaded', type: 'yn',
        q: 'Feeling clearheaded, or still pretty foggy? (Clear/Foggy)',
        alert: (v) => v === 'no' ? ['MONITOR', 'Not clearheaded POD 0 — possible residual sedation'] : null,
      },
      {
        key: 'urination', type: 'yn',
        q: 'Have you been able to pee since surgery? (Yes/No)',
        alert: (v) => v === 'no' ? ['MONITOR', 'No urination since surgery POD 0'] : null,
      },
    ],
    closing: `Sounds good — rest up tonight. If anything worries you, just text us back anytime or reply HELP. We'll check in again tomorrow.`,
  },

  acute: {
    name: 'Acute Phase (POD 1-3)',
    targetPOD: [1, 2, 3],
    greeting: `Hey {firstName}, day {pod} check-in. How are you doing today?`,
    questions: [
      {
        key: 'pain', type: 'num',
        q: 'How\'s the pain? 0-10 for me.',
        alert: (v) => v > 7 ? ['URGENT', `Pain ${v}/10 in acute phase`] : null,
      },
      {
        key: 'fluids', type: 'yn',
        q: 'Keeping fluids down OK? (Yes/No)',
        alert: (v) => v === 'no' ? ['URGENT', 'Not tolerating fluids in acute phase'] : null,
      },
      {
        key: 'urination', type: 'yn',
        q: 'Peeing normally? (Yes/No)',
        alert: (v) => v === 'no' ? ['MONITOR', 'Urinary retention concern'] : null,
      },
      {
        key: 'bleeding', type: 'yn',
        q: 'Any bleeding coming through the dressing? (Yes/No)',
        alert: (v) => v === 'yes' ? ['URGENT', 'Bleeding through dressing acute phase'] : null,
      },
      {
        key: 'groggy', type: 'yn',
        q: 'Feeling overly groggy, confused, or itchy? (Yes/No)',
        alert: (v) => v === 'yes' ? ['MONITOR', 'Excess sedation/confusion/pruritus — possible opioid effect'] : null,
      },
      {
        key: 'opioids', type: 'num',
        q: 'How many pain pills have you taken today?',
      },
      {
        key: 'moving', type: 'yn',
        q: 'Have you been getting up and moving around? (Yes/No)',
        alert: (v) => v === 'no' ? ['MONITOR', 'Not ambulating — DVT/PE risk'] : null,
      },
    ],
    closing: `Thanks! Keep sipping fluids and walking when you can — even short trips around the house help. Text me anytime if something comes up.`,
  },

  infectious: {
    name: 'Infectious Phase (POD 4-7)',
    targetPOD: [4, 5, 6, 7],
    greeting: `Good morning {firstName} — day {pod} check-in. This is the window where we keep a close eye on your incision, so a few questions about that today.`,
    questions: [
      {
        key: 'redness', type: 'yn',
        q: 'Take a look at your incision — any spreading redness, warmth, or thick discharge? (Yes/No)',
        alert: (v) => v === 'yes' ? ['URGENT', 'Possible SSI: redness/discharge at incision'] : null,
      },
      {
        key: 'leg_swelling', type: 'yn',
        q: 'Is one leg noticeably more swollen or painful than the other? (Yes/No)',
        alert: (v) => v === 'yes' ? ['URGENT', 'Unilateral leg swelling — possible DVT'] : null,
      },
      {
        key: 'bowel', type: 'yn',
        q: 'Have you had a bowel movement since surgery? (Yes/No)',
        alert: (v) => v === 'no' ? ['MONITOR', 'No bowel movement by infectious phase — possible ileus'] : null,
      },
      {
        key: 'fever', type: 'text',
        q: 'Any fever or chills? If yes, what\'s your temperature?',
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
        q: 'Compared to a couple days ago, is your pain: Better / Same / Worse?',
        alert: (v) => {
          const lower = (v || '').toLowerCase();
          if (lower.includes('worse')) return ['URGENT', 'Pain worsening in infectious window'];
          return null;
        },
      },
      {
        key: 'opioids', type: 'num',
        q: 'How many pain pills per day are you taking now?',
      },
    ],
    closing: `Thanks for checking in. You're doing the right thing staying on top of this. If you notice a fever above 100.4, new redness, or your pain gets worse, text us right away.`,
  },

  late: {
    name: 'Late Phase (POD 14)',
    targetPOD: 14,
    greeting: `Hey {firstName}, it's been 2 weeks since your surgery — nice milestone! Quick check on how things are healing.`,
    questions: [
      {
        key: 'wound_open', type: 'yn',
        q: 'Have the edges of your incision pulled apart at all? (Yes/No)',
        alert: (v) => v === 'yes' ? ['URGENT', 'Possible wound dehiscence at POD 14'] : null,
      },
      {
        key: 'fluid_bulge', type: 'yn',
        q: 'Any fluid-filled bulge or swelling under the incision? (Yes/No)',
        alert: (v) => v === 'yes' ? ['URGENT', 'Possible seroma/hematoma at POD 14'] : null,
      },
      {
        key: 'still_opioids', type: 'yn',
        q: 'Still taking any prescription pain meds? (Yes/No)',
        alert: (v) => v === 'yes' ? ['MONITOR', 'Still on opioids at POD 14'] : null,
      },
      {
        key: 'wound_closed', type: 'yn',
        q: 'Is your incision fully closed? (Yes/No)',
        alert: (v) => v === 'no' ? ['MONITOR', 'Wound not fully closed at POD 14'] : null,
      },
      {
        key: 'activity', type: 'text',
        q: 'How active are you? Walking around the house, around the neighborhood, or not really yet?',
      },
    ],
    closing: `Great — most of the hard part is behind you! We'll check in at 3 weeks and then one final time at 30 days. Text anytime if something comes up before then.`,
  },

  recovery: {
    name: 'Recovery (POD 21)',
    targetPOD: 21,
    greeting: `Hey {firstName}, 3 weeks since your surgery with Dr. {surgeon}. Almost there — a few questions today including a quick mood check.`,
    questions: [
      {
        key: 'pain_trend', type: 'text',
        q: 'Compared to last week, how\'s the pain? Better / Same / Worse?',
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
        q: 'Have you been able to drive? (Yes/No)',
      },
      {
        key: 'phq_interest', type: 'num',
        q: 'Over the past 2 weeks, how often have you had little interest or pleasure in doing things? 0=Not at all, 1=Several days, 2=More than half the days, 3=Nearly every day',
      },
      {
        key: 'phq_mood', type: 'num',
        q: 'And how often have you been feeling down, depressed, or hopeless? Same 0-3 scale.',
        alert: (v, allResponses) => {
          const interest = parseInt(allResponses.phq_interest) || 0;
          const mood = parseInt(v) || 0;
          const total = interest + mood;
          if (total >= 3) return ['URGENT', `PHQ-2 score ${total} (≥3 threshold) — depression screen positive`];
          return null;
        },
      },
    ],
    closing: `Thanks for doing that! Recovery from surgery can be tough on your mood too, so those last questions are important. One final check-in at 30 days and then we're all done. You're doing great.`,
  },

  closure: {
    name: 'Outcomes Closure (POD 30)',
    targetPOD: 30,
    greeting: `Hey {firstName}, it's been a month since your {procedure} with Dr. {surgeon}. This is our last check-in — we'd really love to hear how you're doing.`,
    questions: [
      {
        key: 'satisfaction', type: 'text',
        q: 'Overall, how do you feel about your surgery results? (Very satisfied / Satisfied / Neutral / Dissatisfied / Very dissatisfied)',
      },
      {
        key: 'would_repeat', type: 'text',
        q: 'Knowing what you know now, would you have the surgery again? (Definitely / Probably / Unsure / Probably not / Definitely not)',
      },
      {
        key: 'still_opioids', type: 'yn',
        q: 'Still taking any prescription pain medication? (Yes/No)',
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
      {
        key: 'checkin_frequency', type: 'text',
        q: 'Last one — were these text check-ins: Too many / About right / Too few?',
      },
    ],
    closing: `Thank you so much, {firstName}. It's been a pleasure keeping an eye on your recovery. Your feedback helps us take better care of the next patient. Wishing you all the best from your team at {facility}!`,
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
