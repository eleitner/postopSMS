import { createHash } from 'node:crypto';
import type { DynamicVariables, PatientStateRow } from '../types';

/**
 * Regex for key names that would indicate PHI. Defensive; assertNoPhi()
 * throws on any match.
 */
const PHI_KEY_PATTERN =
  /(^|_)(name|firstname|lastname|phone|dob|birth|email|address|city|zip|ssn|mrn)($|_)/i;

const ALLOWED_KEYS: ReadonlySet<string> = new Set<keyof DynamicVariables>([
  'study_id',
  'age',
  'sex',
  'diabetes_type',
  'diabetes_duration_years',
  'lifecycle_stage',
  'call_reason',
  'ma_firstname',
]);

function toStr(v: unknown): string {
  return v === null || v === undefined ? '' : String(v);
}

export function buildDynamicVariables(
  patient: PatientStateRow,
  callReason: string,
  maFirstname: string,
): DynamicVariables {
  return {
    study_id: patient.study_id,
    age: toStr(patient.age),
    sex: toStr(patient.sex),
    diabetes_type: toStr(patient.diabetes_type),
    diabetes_duration_years: toStr(patient.diabetes_duration_years),
    lifecycle_stage: patient.lifecycle_stage,
    call_reason: callReason,
    ma_firstname: maFirstname,
  };
}

/**
 * HIPAA defense-in-depth: throws if the payload contains any unknown key or
 * any key whose name suggests PHI. `ma_firstname` is allow-listed because it
 * is the MA's first name, not the patient's — still do not add patient-side
 * name/phone/DOB keys here.
 */
export function assertNoPhi(vars: Record<string, unknown>): void {
  for (const key of Object.keys(vars)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new Error(`Disallowed key in dynamic variables: ${key}`);
    }
    if (key !== 'ma_firstname' && PHI_KEY_PATTERN.test(key)) {
      throw new Error(`Key name suggests PHI: ${key}`);
    }
  }
}

export function hashPayload(vars: DynamicVariables): string {
  const sortedKeys = Object.keys(vars).sort();
  const canonical = JSON.stringify(vars, sortedKeys);
  return createHash('sha256').update(canonical).digest('hex');
}
