/**
 * Empathic Greetings & Personalized Questions
 * 
 * Makes each check-in feel like a caregiver who remembers you,
 * not a survey bot running through a script.
 * 
 * Pulls prior response data to personalize greetings and transition questions.
 * Falls back gracefully if no prior data exists.
 */
const { pool } = require('../utils/db');
const logger = require('../utils/logger');

/**
 * Get prior responses for a patient across all completed sessions.
 * Returns a flat object: { pain: 6, fluids: 'yes', ... } with most recent values.
 */
async function getPriorResponses(patientId) {
  try {
    const result = await pool.query(
      `SELECT r.question_key, r.response_parsed, r.phase, r.pod
       FROM responses r
       JOIN checkin_sessions cs ON cs.id = r.session_id
       WHERE r.patient_id = $1 AND cs.status = 'completed'
       ORDER BY r.created_at ASC`,
      [patientId]
    );
    
    const responses = {};
    const history = [];
    for (const row of result.rows) {
      responses[row.question_key] = row.response_parsed;
      history.push({ key: row.question_key, value: row.response_parsed, phase: row.phase, pod: row.pod });
    }
    return { latest: responses, history };
  } catch (err) {
    logger.debug('Failed to fetch prior responses', { error: err.message });
    return { latest: {}, history: [] };
  }
}

/**
 * Build a personalized greeting for the given phase.
 */
function buildGreeting(phase, patient, prior, pod) {
  const name = patient.first_name;
  const surgeon = (patient.surgeon_name || '').replace(/^Dr\.?\s*/i, '');
  const procedure = patient.procedure_name || 'surgery';
  const facility = process.env.FACILITY_NAME || 'TidalHealth Peninsula Regional';
  const goal = patient.pre_surgical_goal;
  
  switch (phase) {
    case 'pod0':
      return `Hey ${name}, it's your care team at ${facility} checking in after your surgery with Dr. ${surgeon} today. Just a few quick questions to make sure you're settling in OK tonight — takes about a minute.`;
    
    case 'acute': {
      const lastPain = prior.latest.pain;
      const painRef = (typeof lastPain === 'number' || !isNaN(parseInt(lastPain)))
        ? ` You told us your pain was ${lastPain}/10 last time — hopefully it's coming down.`
        : '';
      return `Hey ${name}, day ${pod} check-in.${painRef} How are you doing today?`;
    }
    
    case 'infectious': {
      const parts = [`Good morning ${name} — day ${pod}.`];
      parts.push(`This is the stretch where we keep a close eye on your incision and watch for any signs of infection, so a few questions about that today.`);
      if (prior.latest.moving === 'yes') {
        parts.push(`Glad you've been getting up and moving — keep that up.`);
      }
      return parts.join(' ');
    }
    
    case 'late': {
      const parts = [`Hey ${name}, 2 weeks since your surgery — nice milestone!`];
      
      // Reference their pain trajectory
      const painHistory = prior.history.filter(h => h.key === 'pain' || h.key === 'pain_trend');
      if (painHistory.length > 0) {
        const lastPainEntry = painHistory[painHistory.length - 1];
        if (lastPainEntry.key === 'pain_trend' && lastPainEntry.value?.includes('better')) {
          parts.push(`Great to hear your pain was trending better last time.`);
        }
      }
      
      // Reference opioid status
      if (prior.latest.opioids) {
        const pillCount = parseInt(prior.latest.opioids);
        if (!isNaN(pillCount) && pillCount > 0) {
          parts.push(`We'll check on how the pain meds are going too.`);
        }
      }
      
      parts.push(`Quick check on how things are healing.`);
      return parts.join(' ');
    }
    
    case 'recovery': {
      const parts = [`Hey ${name}, 3 weeks since your surgery with Dr. ${surgeon}. Almost there.`];
      
      // Celebrate opioid cessation if applicable
      if (prior.latest.still_opioids === 'no') {
        parts.push(`Good to see you were off pain meds at your last check-in.`);
      }
      
      // Reference wound healing
      if (prior.latest.wound_closed === 'yes') {
        parts.push(`Glad your incision was looking closed last time.`);
      }
      
      parts.push(`A few questions today including a quick mood check — surgery recovery can be tougher than people expect.`);
      return parts.join(' ');
    }
    
    case 'closure': {
      const parts = [`Hey ${name}, it's been a month since your ${procedure} with Dr. ${surgeon}. This is our last check-in — we'd really love to hear how you're doing.`];
      
      if (goal) {
        parts.push(`You told us at the start that your goal was to "${goal}" — we'll ask about that too.`);
      }
      
      return parts.join(' ');
    }
    
    default:
      return `Hey ${name}, checking in. How are you doing?`;
  }
}

/**
 * Build personalized question text that references prior answers where relevant.
 * Returns modified question text, or the original if no personalization applies.
 */
function personalizeQuestion(questionKey, originalText, phase, prior) {
  switch (questionKey) {
    case 'pain': {
      // Reference prior pain score
      const lastPain = prior.latest.pain;
      if (phase === 'acute' && (typeof lastPain === 'number' || !isNaN(parseInt(lastPain)))) {
        return `How's the pain today? 0-10 for me. (You said ${lastPain} last time.)`;
      }
      return originalText;
    }
    
    case 'pain_trend': {
      if (phase === 'infectious') {
        return `Compared to a couple days ago, is your pain getting better, staying the same, or getting worse?`;
      }
      if (phase === 'recovery') {
        return `Compared to last week, how's the pain? Better, same, or worse?`;
      }
      return originalText;
    }
    
    case 'opioids': {
      const prevOpioids = prior.latest.opioids;
      if (prevOpioids && !isNaN(parseInt(prevOpioids))) {
        return `How many pain pills today? (You were at ${prevOpioids} last check-in.)`;
      }
      return originalText;
    }
    
    case 'still_opioids': {
      if (phase === 'late') {
        return `Still taking any prescription pain meds? (Yes/No) — a lot of people are off them by now, but everyone's different.`;
      }
      if (phase === 'recovery') {
        if (prior.latest.still_opioids === 'yes') {
          return `Still on prescription pain meds? (Yes/No) — it's been 3 weeks, so we want to keep an eye on this.`;
        }
        return originalText;
      }
      if (phase === 'closure') {
        if (prior.latest.still_opioids === 'no') {
          return `Just confirming — still off the prescription pain meds? (Yes/No)`;
        }
        return `Still taking any prescription pain medication? (Yes/No)`;
      }
      return originalText;
    }
    
    case 'moving': {
      return `Have you been getting up and moving around? Even short walks help. (Yes/No)`;
    }
    
    case 'activity': {
      if (prior.latest.moving === 'yes') {
        return `You were getting up and around earlier — how active are you now? Walking around the house, the neighborhood, or more than that?`;
      }
      return originalText;
    }
    
    case 'phq_interest': {
      return `Almost done — two quick questions about how you've been feeling emotionally. Over the past 2 weeks, how often have you had little interest or pleasure in doing things? 0 = Not at all, 1 = Several days, 2 = More than half the days, 3 = Nearly every day`;
    }
    
    case 'phq_mood': {
      return `And how often have you been feeling down, depressed, or hopeless? Same 0-3 scale. No wrong answer here.`;
    }
    
    case 'goals_met': {
      // This one already uses {goal} template — just make it warmer
      const goal = originalText; // will have {goal} replaced already
      return goal;
    }
    
    case 'checkin_frequency': {
      return `Last one — were these text check-ins too many, about right, or too few? Honest feedback helps us improve this for future patients.`;
    }
    
    default:
      return originalText;
  }
}

/**
 * Build personalized closing message.
 */
function buildClosing(phase, patient, prior) {
  const name = patient.first_name;
  const facility = process.env.FACILITY_NAME || 'TidalHealth Peninsula Regional';
  const surgeon = (patient.surgeon_name || '').replace(/^Dr\.?\s*/i, '');

  switch (phase) {
    case 'pod0':
      return `Sounds good — rest up tonight, ${name}. If anything worries you later, just text us back anytime or reply HELP. We'll check in again tomorrow.`;
    
    case 'acute':
      return `Thanks ${name}! Keep sipping fluids and walking when you can — even short trips around the house help. Text us anytime if something comes up.`;
    
    case 'infectious':
      return `Thanks for checking in, ${name}. You're doing the right thing staying on top of this. If you notice a fever, new redness, or your pain gets suddenly worse, text us right away — don't wait for the next check-in.`;
    
    case 'late':
      return `Great — most of the hard part is behind you, ${name}! We'll check in at 3 weeks and then one final time at 30 days. Text anytime if something comes up before then.`;
    
    case 'recovery':
      return `Thanks for doing that, ${name}. Recovery from surgery can be tough on your mood too, so those last questions are important. One final check-in at 30 days and then we're done. You're doing great.`;
    
    case 'closure':
      return `Thank you so much, ${name}. It's been a pleasure keeping an eye on your recovery. Your feedback helps us take better care of the next patient. Wishing you all the best from your team at ${facility}!`;
    
    default:
      return `Thanks for checking in, ${name}! Text us anytime.`;
  }
}

module.exports = {
  getPriorResponses,
  buildGreeting,
  personalizeQuestion,
  buildClosing,
};
