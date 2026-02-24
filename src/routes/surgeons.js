/**
 * Surgeon Management Routes
 * 
 * CRUD for surgeons + AI-powered instruction parsing.
 * 
 * POST   /api/surgeons                — Create surgeon
 * GET    /api/surgeons                — List surgeons
 * GET    /api/surgeons/:id            — Get surgeon + instructions
 * PATCH  /api/surgeons/:id            — Update surgeon
 * POST   /api/surgeons/:id/instructions — Upload raw text → AI parse → draft
 * POST   /api/surgeons/:id/instructions/approve — Approve draft instructions
 * POST   /api/surgeons/:id/instructions/json    — Direct JSON upload (skip AI)
 * POST   /api/webhook/email           — SendGrid inbound parse stub
 */
const express = require('express');
const router = express.Router();
const Anthropic = require('@anthropic-ai/sdk');
const { pool, audit } = require('../utils/db');
const { authenticate, requireRole } = require('../middleware/auth');
const logger = require('../utils/logger');

// ═══════════════════ CRUD ═══════════════════

router.post('/surgeons', authenticate, requireRole('admin'), async (req, res) => {
  const { name, npi, specialty, facility, triageNursePhone, triageNurseEmail, officePhone, officeHours, notes } = req.body;
  if (!name) return res.status(400).json({ error: 'Surgeon name required' });
  try {
    const result = await pool.query(
      `INSERT INTO surgeons (name, npi, specialty, facility, triage_nurse_phone, triage_nurse_email, office_phone, office_hours, surgeon_notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [name, npi || null, specialty || null, facility || 'TidalHealth Peninsula Regional',
       triageNursePhone || null, triageNurseEmail || null, officePhone || null, officeHours || null, notes || null]
    );
    await audit(req.user.email, 'surgeon_created', 'surgeon', result.rows[0].id, { name, npi }, req.ip);
    res.status(201).json({ surgeon: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Surgeon with this NPI already exists' });
    logger.error('Create surgeon failed', { error: err.message });
    res.status(500).json({ error: 'Failed to create surgeon' });
  }
});

router.get('/surgeons', authenticate, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT s.*,
        (SELECT COUNT(*) FROM patients p WHERE p.surgeon_id = s.id) as patient_count,
        (SELECT COUNT(*) FROM patients p WHERE p.surgeon_id = s.id AND p.status IN ('enrolled','active')) as active_patients
      FROM surgeons s WHERE s.active = TRUE ORDER BY s.name
    `);
    res.json({ surgeons: result.rows });
  } catch (err) {
    logger.error('List surgeons failed', { error: err.message });
    res.status(500).json({ error: 'Failed to list surgeons' });
  }
});

router.get('/surgeons/:id', authenticate, async (req, res) => {
  try {
    const surgeon = (await pool.query('SELECT * FROM surgeons WHERE id = $1', [req.params.id])).rows[0];
    if (!surgeon) return res.status(404).json({ error: 'Surgeon not found' });
    res.json({ surgeon });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get surgeon' });
  }
});

router.patch('/surgeons/:id', authenticate, requireRole('admin'), async (req, res) => {
  const fields = ['name', 'npi', 'specialty', 'facility', 'triage_nurse_phone', 'triage_nurse_email', 'office_phone', 'office_hours', 'surgeon_notes', 'active'];
  const camelToSnake = { triageNursePhone: 'triage_nurse_phone', triageNurseEmail: 'triage_nurse_email', officePhone: 'office_phone', officeHours: 'office_hours', surgeonNotes: 'surgeon_notes' };
  
  const updates = [];
  const values = [];
  let idx = 1;
  for (const [key, val] of Object.entries(req.body)) {
    const col = camelToSnake[key] || key;
    if (fields.includes(col)) {
      updates.push(`${col} = $${idx}`);
      values.push(val);
      idx++;
    }
  }
  if (updates.length === 0) return res.status(400).json({ error: 'No valid fields to update' });
  values.push(req.params.id);

  try {
    const result = await pool.query(
      `UPDATE surgeons SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Surgeon not found' });
    await audit(req.user.email, 'surgeon_updated', 'surgeon', req.params.id, { fields: Object.keys(req.body) }, req.ip);
    res.json({ surgeon: result.rows[0] });
  } catch (err) {
    logger.error('Update surgeon failed', { error: err.message });
    res.status(500).json({ error: 'Failed to update surgeon' });
  }
});

// ═══════════════════ INSTRUCTION PARSING ═══════════════════

const INSTRUCTION_PARSE_PROMPT = `You are a clinical document parser for a post-surgical patient engagement system. Parse the following surgeon's post-operative instructions into structured JSON.

OUTPUT FORMAT — return ONLY valid JSON, no markdown fences, no explanation:
{
  "metadata": {
    "procedure_type": "snake_case_procedure_name",
    "procedure_display": "Human Readable Procedure Name",
    "version": "1.0",
    "created_date": "YYYY-MM-DD",
    "confidence_overall": 0.0-1.0
  },
  "wound_care": {
    "instructions": "Free text wound care instructions",
    "dressing_change": "Dressing change protocol",
    "warning_signs": ["sign1", "sign2"],
    "confidence": 0.0-1.0
  },
  "activity_restrictions": {
    "timeline": [
      {"period": "POD 0-3", "instructions": "..."},
      {"period": "POD 4-7", "instructions": "..."}
    ],
    "driving": "Driving restriction details",
    "return_to_work": "RTW timeline",
    "sexual_activity": "When comfortable",
    "confidence": 0.0-1.0
  },
  "diet": {
    "instructions": "General diet instructions",
    "restrictions": ["restriction1", "restriction2"],
    "confidence": 0.0-1.0
  },
  "medications": {
    "pain_management": {
      "primary": "First-line non-opioid",
      "secondary": "Second-line option",
      "rescue": "Opioid rescue if prescribed",
      "weaning_plan": "Weaning timeline"
    },
    "home_medications": "Instructions for resuming home meds",
    "avoid": ["medications to avoid"],
    "confidence": 0.0-1.0
  },
  "bowel_management": {
    "instructions": "Bowel management protocol",
    "confidence": 0.0-1.0
  },
  "warning_signs_call_office": ["sign1", "sign2"],
  "warning_signs_er": ["sign1", "sign2"],
  "follow_up": {
    "timeline": "X weeks postop",
    "scheduling": "How to schedule",
    "office_phone": "phone number",
    "office_hours": "hours"
  },
  "surgeon_specific_notes": "Any additional notes/preferences"
}

RULES:
- Extract everything you can from the document. For fields with no information, use reasonable clinical defaults for the procedure type and set confidence below 0.7.
- Confidence scores: 0.95+ if directly stated, 0.8-0.94 if strongly implied, 0.7-0.79 if inferred from standard practice, below 0.7 if guessing.
- Keep the original clinical language where possible.
- If a medication dosage is mentioned, include it exactly as written.
- For timeline entries, map to POD ranges matching our protocol: POD 0-3, POD 4-7, POD 7-14, POD 14+.`;

router.post('/surgeons/:id/instructions', authenticate, requireRole('admin'), async (req, res) => {
  const { rawText, procedureType, source } = req.body;
  if (!rawText) return res.status(400).json({ error: 'rawText is required — paste the surgeon instructions here' });

  try {
    // Verify surgeon exists
    const surgeon = (await pool.query('SELECT * FROM surgeons WHERE id = $1', [req.params.id])).rows[0];
    if (!surgeon) return res.status(404).json({ error: 'Surgeon not found' });

    // Call Claude to parse
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4000,
      system: INSTRUCTION_PARSE_PROMPT,
      messages: [{
        role: 'user',
        content: `Surgeon: ${surgeon.name}${surgeon.npi ? ' (NPI: ' + surgeon.npi + ')' : ''}\nFacility: ${surgeon.facility}\nProcedure type hint: ${procedureType || 'not specified'}\n\n--- BEGIN INSTRUCTIONS ---\n${rawText}\n--- END INSTRUCTIONS ---`
      }],
    });

    const responseText = message.content[0]?.text || '';

    // Parse JSON response
    let parsed;
    try {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
    } catch (parseErr) {
      logger.error('Failed to parse AI instruction response', { error: parseErr.message, response: responseText.substring(0, 500) });
      return res.status(422).json({ error: 'AI returned unparseable response. Try again or use direct JSON upload.', raw: responseText.substring(0, 1000) });
    }

    if (!parsed) {
      return res.status(422).json({ error: 'AI returned empty response' });
    }

    // Add metadata
    parsed.metadata = {
      ...parsed.metadata,
      surgeon_name: surgeon.name,
      surgeon_npi: surgeon.npi,
      facility: surgeon.facility,
      facility_id: 'THPR-001',
      source_document: source || 'manual_paste',
      validation_status: 'draft',
      created_date: new Date().toISOString().split('T')[0],
      parsed_by: 'claude-sonnet-4-20250514',
    };

    // Store as draft
    await pool.query(
      `UPDATE surgeons SET instructions = $1, instructions_status = 'draft', instructions_source = $2, instructions_parsed_at = NOW() WHERE id = $3`,
      [JSON.stringify(parsed), source || 'manual_paste', req.params.id]
    );

    await audit(req.user.email, 'instructions_parsed', 'surgeon', req.params.id, {
      procedureType: parsed.metadata?.procedure_type,
      confidenceOverall: parsed.metadata?.confidence_overall,
    }, req.ip);

    res.json({
      status: 'draft',
      message: 'Instructions parsed and saved as draft. Review and approve to activate.',
      instructions: parsed,
    });
  } catch (err) {
    logger.error('Instruction parsing failed', { error: err.message });
    res.status(500).json({ error: 'Instruction parsing failed: ' + err.message });
  }
});

// Direct JSON upload (skip AI parsing)
router.post('/surgeons/:id/instructions/json', authenticate, requireRole('admin'), async (req, res) => {
  const { instructions, source } = req.body;
  if (!instructions || typeof instructions !== 'object') return res.status(400).json({ error: 'instructions object required' });

  try {
    const surgeon = (await pool.query('SELECT * FROM surgeons WHERE id = $1', [req.params.id])).rows[0];
    if (!surgeon) return res.status(404).json({ error: 'Surgeon not found' });

    // Add metadata
    instructions.metadata = {
      ...instructions.metadata,
      surgeon_name: surgeon.name,
      surgeon_npi: surgeon.npi,
      facility: surgeon.facility,
      validation_status: 'draft',
    };

    await pool.query(
      `UPDATE surgeons SET instructions = $1, instructions_status = 'draft', instructions_source = $2, instructions_parsed_at = NOW() WHERE id = $3`,
      [JSON.stringify(instructions), source || 'direct_json', req.params.id]
    );
    await audit(req.user.email, 'instructions_uploaded', 'surgeon', req.params.id, { source: 'direct_json' }, req.ip);
    res.json({ status: 'draft', message: 'Instructions saved as draft.', instructions });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save instructions' });
  }
});

// Approve draft instructions
router.post('/surgeons/:id/instructions/approve', authenticate, requireRole('admin'), async (req, res) => {
  try {
    const surgeon = (await pool.query('SELECT * FROM surgeons WHERE id = $1', [req.params.id])).rows[0];
    if (!surgeon) return res.status(404).json({ error: 'Surgeon not found' });
    if (surgeon.instructions_status !== 'draft') return res.status(400).json({ error: `Instructions are "${surgeon.instructions_status}", not "draft"` });

    // Update validation_status inside the JSONB
    const instructions = surgeon.instructions;
    if (instructions.metadata) {
      instructions.metadata.validation_status = 'approved';
      instructions.metadata.confirmed_by = req.user.email;
      instructions.metadata.confirmation_date = new Date().toISOString().split('T')[0];
    }

    await pool.query(
      `UPDATE surgeons SET instructions = $1, instructions_status = 'approved', instructions_approved_by = $2, instructions_approved_at = NOW() WHERE id = $3`,
      [JSON.stringify(instructions), req.user.email, req.params.id]
    );
    await audit(req.user.email, 'instructions_approved', 'surgeon', req.params.id, {}, req.ip);
    res.json({ status: 'approved', message: 'Instructions approved and active.', instructions });
  } catch (err) {
    res.status(500).json({ error: 'Failed to approve instructions' });
  }
});

// ═══════════════════ EMAIL WEBHOOK STUB ═══════════════════

/**
 * POST /api/webhook/email
 * 
 * SendGrid Inbound Parse webhook. When you point clinical@surghome.com MX records
 * at SendGrid and configure inbound parse to POST to this URL, incoming emails
 * with PDF/DOCX attachments will be automatically parsed.
 * 
 * Setup required:
 * 1. MX record: surghome.com → mx.sendgrid.net
 * 2. SendGrid Inbound Parse: clinical@surghome.com → POST https://postopsms.onrender.com/api/webhook/email
 * 3. Set env: SENDGRID_WEBHOOK_SECRET for signature verification
 */
router.post('/webhook/email', express.urlencoded({ extended: true, limit: '25mb' }), async (req, res) => {
  // SendGrid sends: from, to, subject, text, html, attachments (JSON string), attachment-info
  const { from, subject, text } = req.body;
  
  logger.info('Email webhook received', {
    from: from ? from.substring(0, 50) : 'unknown',
    subject: subject ? subject.substring(0, 100) : 'no subject',
    hasText: !!text,
    hasAttachments: !!req.body.attachments,
  });

  // TODO: When wired up:
  // 1. Verify SendGrid signature
  // 2. Extract attachments (PDF → pdf-parse, DOCX → mammoth)  
  // 3. Match surgeon by email or subject line
  // 4. Call instruction parse endpoint internally
  // 5. Notify admin that draft instructions are ready for review

  // For now, just log and acknowledge
  try {
    await pool.query(
      `INSERT INTO audit_log (actor, action, resource_type, detail) VALUES ($1, $2, $3, $4)`,
      ['email_webhook', 'email_received', 'surgeon', JSON.stringify({ from, subject, textLength: text?.length })]
    );
  } catch (err) {
    logger.error('Email webhook audit failed', { error: err.message });
  }

  res.sendStatus(200);
});

// ═══════════════════ SURGEON LOOKUP (for patient enrollment) ═══════════════════

router.get('/surgeons/lookup/:name', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, npi, specialty, office_phone FROM surgeons WHERE active = TRUE AND LOWER(name) LIKE $1 ORDER BY name LIMIT 10`,
      ['%' + req.params.name.toLowerCase() + '%']
    );
    res.json({ matches: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Lookup failed' });
  }
});

module.exports = router;
