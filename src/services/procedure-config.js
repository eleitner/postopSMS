/**
 * Procedure Configuration — Clinical Benchmarks
 * 
 * Default opioid cessation windows, activity milestones, and PT/OT expectations
 * per procedure type. All values are surgeon-overridable via the surgeons table.
 * 
 * Evidence base:
 *   - Michigan OPEN (Opioid Prescribing Engagement Network) — discharge tab recommendations
 *     Source: michigan-open.org/adult-opioid-prescribing-recommendations/
 *   - Hopkins Expert Panel (Overton et al., JACS 2018) — Delphi consensus ranges
 *   - Bree Collaborative / WA AMDG — duration-based guidance
 *   - ACS post-op guidelines — activity milestones
 *   - Clinical consensus — PT/OT expectations
 * 
 * MME conversion: 1 oxycodone 5mg tablet = 7.5 MME
 *   - OPEN recommends in oxycodone 5mg tabs (the standard unit)
 *   - Our config stores openMaxTabs for prescribing reference
 *   - openMaxMME is auto-derived: openMaxTabs × 7.5
 *   - expectedDurationDays = when most patients stop (based on patient-reported data)
 *   - warningDays = soft check-in threshold (still normal for some patients)
 *   - alertDays = flag for nurse review (approaching prolonged use territory)
 * 
 * CDC 2022 thresholds for context (chronic pain, not surgical):
 *   - Reassess at ≥50 MME/day
 *   - Careful justification at ≥90 MME/day
 *   - Acute pain: 3 days often sufficient, rarely >7 days
 * 
 * Design:
 *   - Defaults cover ~90% of cases
 *   - Surgeons can override per-procedure at registration
 *   - System matches patient's procedure_name to the best-fit config via fuzzy matching
 *   - Falls back to 'general' if no match found
 */
const { pool } = require('../utils/db');
const logger = require('../utils/logger');

// ═══════════════════════════════════════════════════
// DEFAULT PROCEDURE CONFIGURATIONS
// ═══════════════════════════════════════════════════

const PROCEDURE_DEFAULTS = {
  // ── General Surgery ──
  'lap_chole': {
    displayName: 'Laparoscopic Cholecystectomy',
    matchTerms: ['lap chole', 'cholecystectomy', 'gallbladder'],
    category: 'general',
    opioid: {
      expectedDurationDays: 3,    // Most stop within 3 days
      warningDays: 5,              // Gentle check-in at day 5
      alertDays: 10,               // Flag for nurse at day 10
      openMaxTabs: 10,             // OPEN guideline: 0-10 oxy 5mg tabs
    },
    activity: {
      tier1_mobilizing: { byPOD: 0, description: 'Out of bed, bathroom' },
      tier2_household: { byPOD: 3, description: 'Moving around house, self-care' },
      tier3_neighborhood: { byPOD: 7, description: 'Short walks, light errands' },
      tier4_baseline: { byPOD: 14, description: 'Driving, normal activity, light exercise' },
    },
    ptOtExpected: false,
    ptStartWindow: null,
  },

  'lap_appy': {
    displayName: 'Laparoscopic Appendectomy',
    matchTerms: ['lap appy', 'appendectomy', 'appendix'],
    category: 'general',
    opioid: {
      expectedDurationDays: 3,
      warningDays: 5,
      alertDays: 10,
      openMaxTabs: 10,
    },
    activity: {
      tier1_mobilizing: { byPOD: 0, description: 'Out of bed, bathroom' },
      tier2_household: { byPOD: 2, description: 'Moving around house' },
      tier3_neighborhood: { byPOD: 5, description: 'Short walks, errands' },
      tier4_baseline: { byPOD: 14, description: 'Normal activity' },
    },
    ptOtExpected: false,
    ptStartWindow: null,
  },

  'hernia_repair': {
    displayName: 'Hernia Repair',
    matchTerms: ['hernia', 'inguinal', 'ventral', 'umbilical', 'incisional hernia'],
    category: 'general',
    opioid: {
      expectedDurationDays: 4,
      warningDays: 7,
      alertDays: 14,
      openMaxTabs: 10,
    },
    activity: {
      tier1_mobilizing: { byPOD: 0, description: 'Out of bed, bathroom' },
      tier2_household: { byPOD: 3, description: 'Household movement, no lifting >10 lbs' },
      tier3_neighborhood: { byPOD: 7, description: 'Walks, light errands' },
      tier4_baseline: { byPOD: 28, description: 'Full activity, lifting restrictions lifted' },
    },
    ptOtExpected: false,
    ptStartWindow: null,
  },

  'colectomy': {
    displayName: 'Colectomy',
    matchTerms: ['colectomy', 'bowel resection', 'colon resection', 'hemicolectomy', 'sigmoid'],
    category: 'general',
    opioid: {
      expectedDurationDays: 5,
      warningDays: 10,
      alertDays: 14,
      openMaxTabs: 10,
    },
    activity: {
      tier1_mobilizing: { byPOD: 0, description: 'Out of bed with assistance' },
      tier2_household: { byPOD: 5, description: 'Moving around house' },
      tier3_neighborhood: { byPOD: 10, description: 'Short walks' },
      tier4_baseline: { byPOD: 30, description: 'Driving, normal activity' },
    },
    ptOtExpected: false,
    ptStartWindow: null,
  },

  'thyroidectomy': {
    displayName: 'Thyroidectomy',
    matchTerms: ['thyroidectomy', 'thyroid'],
    category: 'general',
    opioid: {
      expectedDurationDays: 2,
      warningDays: 4,
      alertDays: 7,
      openMaxTabs: 5,
    },
    activity: {
      tier1_mobilizing: { byPOD: 0, description: 'Out of bed, bathroom' },
      tier2_household: { byPOD: 1, description: 'Normal household activity' },
      tier3_neighborhood: { byPOD: 3, description: 'Walks, errands' },
      tier4_baseline: { byPOD: 10, description: 'Normal activity' },
    },
    ptOtExpected: false,
    ptStartWindow: null,
  },

  // ── Orthopedic ──
  'total_knee': {
    displayName: 'Total Knee Replacement',
    matchTerms: ['total knee', 'tka', 'knee replacement', 'knee arthroplasty'],
    category: 'orthopedic',
    opioid: {
      expectedDurationDays: 14,
      warningDays: 21,
      alertDays: 30,
      openMaxTabs: 40,
    },
    activity: {
      tier1_mobilizing: { byPOD: 0, description: 'Weight bearing with walker' },
      tier2_household: { byPOD: 3, description: 'Moving around house with assistive device' },
      tier3_neighborhood: { byPOD: 14, description: 'Short walks, cane as needed' },
      tier4_baseline: { byPOD: 42, description: 'Driving (if off opioids), normal walking' },
    },
    ptOtExpected: true,
    ptStartWindow: { startByPOD: 3, description: 'PT typically starts within 3 days post-op' },
  },

  'total_hip': {
    displayName: 'Total Hip Replacement',
    matchTerms: ['total hip', 'tha', 'hip replacement', 'hip arthroplasty'],
    category: 'orthopedic',
    opioid: {
      expectedDurationDays: 10,
      warningDays: 18,
      alertDays: 28,
      openMaxTabs: 30,
    },
    activity: {
      tier1_mobilizing: { byPOD: 0, description: 'Weight bearing with walker, hip precautions' },
      tier2_household: { byPOD: 3, description: 'Moving around house with assistive device' },
      tier3_neighborhood: { byPOD: 14, description: 'Short walks outside' },
      tier4_baseline: { byPOD: 42, description: 'Driving (if off opioids), normal walking' },
    },
    ptOtExpected: true,
    ptStartWindow: { startByPOD: 3, description: 'PT typically starts within 3 days post-op' },
  },

  'rotator_cuff': {
    displayName: 'Rotator Cuff Repair',
    matchTerms: ['rotator cuff', 'shoulder repair', 'shoulder arthroscopy'],
    category: 'orthopedic',
    opioid: {
      expectedDurationDays: 7,
      warningDays: 14,
      alertDays: 21,
      openMaxTabs: 20,
    },
    activity: {
      tier1_mobilizing: { byPOD: 0, description: 'Sling wear, walking' },
      tier2_household: { byPOD: 3, description: 'Light activity, sling as directed' },
      tier3_neighborhood: { byPOD: 7, description: 'Walking, light errands' },
      tier4_baseline: { byPOD: 42, description: 'Gradual return per PT guidance' },
    },
    ptOtExpected: true,
    ptStartWindow: { startByPOD: 14, description: 'PT typically starts 2 weeks post-op' },
  },

  'acl_reconstruction': {
    displayName: 'ACL Reconstruction',
    matchTerms: ['acl', 'anterior cruciate', 'knee reconstruction'],
    category: 'orthopedic',
    opioid: {
      expectedDurationDays: 7,
      warningDays: 14,
      alertDays: 21,
      openMaxTabs: 20,
    },
    activity: {
      tier1_mobilizing: { byPOD: 0, description: 'Weight bearing as tolerated with crutches' },
      tier2_household: { byPOD: 3, description: 'Light activity, brace per protocol' },
      tier3_neighborhood: { byPOD: 14, description: 'Walks outside, crutches as needed' },
      tier4_baseline: { byPOD: 42, description: 'Driving (if left knee or off opioids)' },
    },
    ptOtExpected: true,
    ptStartWindow: { startByPOD: 7, description: 'PT typically starts within 1 week' },
  },

  'spinal_fusion': {
    displayName: 'Spinal Fusion',
    matchTerms: ['spinal fusion', 'spine fusion', 'lumbar fusion', 'cervical fusion', 'alif', 'plif', 'tlif'],
    category: 'orthopedic',
    opioid: {
      expectedDurationDays: 14,
      warningDays: 21,
      alertDays: 30,
      openMaxTabs: 40,
    },
    activity: {
      tier1_mobilizing: { byPOD: 1, description: 'Out of bed with assistance' },
      tier2_household: { byPOD: 5, description: 'Moving around house, no BLT (bend/lift/twist)' },
      tier3_neighborhood: { byPOD: 14, description: 'Short walks' },
      tier4_baseline: { byPOD: 56, description: 'Per surgeon clearance' },
    },
    ptOtExpected: true,
    ptStartWindow: { startByPOD: 21, description: 'PT typically starts 3 weeks post-op (varies)' },
  },

  // ── OB/GYN ──
  'hysterectomy': {
    displayName: 'Hysterectomy',
    matchTerms: ['hysterectomy', 'total hysterectomy', 'lap hysterectomy'],
    category: 'gynecologic',
    opioid: {
      expectedDurationDays: 4,
      warningDays: 7,
      alertDays: 14,
      openMaxTabs: 10,
    },
    activity: {
      tier1_mobilizing: { byPOD: 0, description: 'Out of bed, bathroom' },
      tier2_household: { byPOD: 3, description: 'Light household activity' },
      tier3_neighborhood: { byPOD: 7, description: 'Walks, errands' },
      tier4_baseline: { byPOD: 28, description: 'Normal activity, no heavy lifting for 6 weeks' },
    },
    ptOtExpected: false,
    ptStartWindow: null,
  },

  'c_section': {
    displayName: 'Cesarean Section',
    matchTerms: ['c-section', 'cesarean', 'c section', 'caesarean'],
    category: 'obstetric',
    opioid: {
      expectedDurationDays: 4,
      warningDays: 7,
      alertDays: 14,
      openMaxTabs: 20,             // OPEN: 0-20 oxy 5mg (0-150 MME)
    },
    activity: {
      tier1_mobilizing: { byPOD: 0, description: 'Out of bed, bathroom' },
      tier2_household: { byPOD: 3, description: 'Light activity, avoid stairs initially' },
      tier3_neighborhood: { byPOD: 7, description: 'Short walks, light errands' },
      tier4_baseline: { byPOD: 28, description: 'Driving, normal activity' },
    },
    ptOtExpected: false,
    ptStartWindow: null,
  },

  // ── Fallback ──
  'general': {
    displayName: 'General Surgery (Default)',
    matchTerms: [],
    category: 'general',
    opioid: {
      expectedDurationDays: 5,
      warningDays: 10,
      alertDays: 14,
      openMaxTabs: 15,
    },
    activity: {
      tier1_mobilizing: { byPOD: 0, description: 'Out of bed' },
      tier2_household: { byPOD: 3, description: 'Household activity' },
      tier3_neighborhood: { byPOD: 7, description: 'Short walks' },
      tier4_baseline: { byPOD: 28, description: 'Normal activity' },
    },
    ptOtExpected: false,
    ptStartWindow: null,
  },
};

// ═══════════════════════════════════════════════════
// PROCEDURE MATCHING
// ═══════════════════════════════════════════════════

/**
 * Match a procedure name string to the best-fit config.
 * Checks surgeon overrides first, then falls back to defaults.
 */
async function getConfigForPatient(patient) {
  // 1. Check for surgeon-level procedure override
  if (patient.surgeon_id) {
    try {
      const result = await pool.query(
        `SELECT procedure_configs FROM surgeons WHERE id = $1`,
        [patient.surgeon_id]
      );
      const surgeonConfigs = result.rows[0]?.procedure_configs;
      if (surgeonConfigs) {
        const override = matchSurgeonOverride(patient.procedure_name, surgeonConfigs);
        if (override) {
          logger.info('Using surgeon procedure override', { procedure: patient.procedure_name });
          return { ...getDefaultConfig(patient.procedure_name), ...override, source: 'surgeon_override' };
        }
      }
    } catch (err) {
      logger.warn('Failed to check surgeon procedure config', { error: err.message });
    }
  }

  // 2. Fall back to defaults
  const config = getDefaultConfig(patient.procedure_name);
  return { ...config, source: 'default' };
}

/**
 * Match procedure name to default config via fuzzy term matching.
 */
function getDefaultConfig(procedureName) {
  const lower = (procedureName || '').toLowerCase();

  for (const [key, config] of Object.entries(PROCEDURE_DEFAULTS)) {
    if (key === 'general') continue; // Skip fallback
    for (const term of config.matchTerms) {
      if (lower.includes(term)) {
        return { ...config, configKey: key };
      }
    }
  }

  // Fallback
  return { ...PROCEDURE_DEFAULTS.general, configKey: 'general' };
}

/**
 * Match against surgeon-specific overrides (stored as JSONB on surgeons table).
 * Surgeon overrides are partial — only override what they set, defaults fill the rest.
 */
function matchSurgeonOverride(procedureName, surgeonConfigs) {
  if (!surgeonConfigs || typeof surgeonConfigs !== 'object') return null;

  const lower = (procedureName || '').toLowerCase();
  for (const [key, override] of Object.entries(surgeonConfigs)) {
    const configDefault = PROCEDURE_DEFAULTS[key];
    if (configDefault) {
      for (const term of configDefault.matchTerms) {
        if (lower.includes(term)) return override;
      }
    }
    // Also match by the override's own key
    if (lower.includes(key.replace(/_/g, ' '))) return override;
  }

  return null;
}

// ═══════════════════════════════════════════════════
// BENCHMARK CHECKS
// ═══════════════════════════════════════════════════

/**
 * Check if patient's opioid use is within, approaching, or past the expected window.
 * Returns: 'within' | 'warning' | 'alert' | 'unknown'
 */
function checkOpioidStatus(config, pod, stillTaking) {
  if (!stillTaking || stillTaking === 'no') return 'within'; // Not on opioids = fine
  if (!config.opioid) return 'unknown';

  if (pod <= config.opioid.expectedDurationDays) return 'within';
  if (pod <= config.opioid.warningDays) return 'warning';
  return 'alert';
}

/**
 * Check if patient is meeting activity milestones.
 * Returns: { onTrack: boolean, currentTier: string, expectedTier: string, behindBy: number }
 */
function checkActivityStatus(config, pod, activityLevel) {
  if (!config.activity) return { onTrack: true, currentTier: 'unknown', expectedTier: 'unknown', behindBy: 0 };

  // Determine expected tier for current POD
  const tiers = [
    { key: 'tier4_baseline', ...config.activity.tier4_baseline },
    { key: 'tier3_neighborhood', ...config.activity.tier3_neighborhood },
    { key: 'tier2_household', ...config.activity.tier2_household },
    { key: 'tier1_mobilizing', ...config.activity.tier1_mobilizing },
  ];

  let expectedTier = 'tier1_mobilizing';
  for (const tier of tiers) {
    if (pod >= tier.byPOD) {
      expectedTier = tier.key;
      break;
    }
  }

  // Parse patient's self-reported activity level
  const reportedTier = inferActivityTier(activityLevel);

  const tierOrder = { tier1_mobilizing: 1, tier2_household: 2, tier3_neighborhood: 3, tier4_baseline: 4 };
  const expected = tierOrder[expectedTier] || 1;
  const actual = tierOrder[reportedTier] || 1;

  return {
    onTrack: actual >= expected,
    currentTier: reportedTier,
    expectedTier,
    behindBy: Math.max(0, expected - actual),
  };
}

/**
 * Infer activity tier from patient's free-text response.
 */
function inferActivityTier(text) {
  const lower = (text || '').toLowerCase();

  if (lower.includes('normal') || lower.includes('exercis') || lower.includes('driv') || lower.includes('work')) {
    return 'tier4_baseline';
  }
  if (lower.includes('neighborhood') || lower.includes('outside') || lower.includes('errand') || lower.includes('walk')) {
    return 'tier3_neighborhood';
  }
  if (lower.includes('house') || lower.includes('around') || lower.includes('some') || lower.includes('stairs') || lower === 'yes') {
    return 'tier2_household';
  }
  if (lower.includes('not') || lower.includes('bed') || lower.includes('barely') || lower.includes('no')) {
    return 'tier1_mobilizing';
  }

  return 'tier2_household'; // Default guess if ambiguous
}

/**
 * Check PT/OT compliance status.
 * Returns: 'not_applicable' | 'on_track' | 'due_to_start' | 'overdue' | 'unknown'
 */
function checkPtOtStatus(config, pod, ptStarted) {
  if (!config.ptOtExpected) return 'not_applicable';
  if (!config.ptStartWindow) return 'unknown';

  if (ptStarted === 'yes' || ptStarted === true) return 'on_track';

  if (pod < config.ptStartWindow.startByPOD) return 'on_track'; // Not yet expected
  if (pod >= config.ptStartWindow.startByPOD && pod < config.ptStartWindow.startByPOD + 7) return 'due_to_start';
  return 'overdue';
}

module.exports = {
  PROCEDURE_DEFAULTS,
  getConfigForPatient,
  getDefaultConfig,
  checkOpioidStatus,
  checkActivityStatus,
  checkPtOtStatus,
};
