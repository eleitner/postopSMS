export interface RequestBody {
  patient_id: string;
  ma_id: string;
  call_reason: string;
}

export interface PatientStateRow {
  patient_id: string;
  study_id: string;
  age: number | null;
  sex: string | null;
  diabetes_type: string | null;
  diabetes_duration_years: number | null;
  lifecycle_stage: string;
}

/**
 * De-identified payload sent to Retell as retell_llm_dynamic_variables.
 * NEVER add a key here that could contain PHI. assertNoPhi() enforces this.
 */
export interface DynamicVariables {
  study_id: string;
  age: string;
  sex: string;
  diabetes_type: string;
  diabetes_duration_years: string;
  lifecycle_stage: string;
  call_reason: string;
  ma_firstname: string;
}

export interface HandoffRow {
  id: string;
}

export interface RetellRegisterResponse {
  call_id: string;
  [extra: string]: unknown;
}

export interface SuccessResponse {
  call_id: string;
  sip_uri: string;
  handoff_id: string;
  expires_in_seconds: number;
}
