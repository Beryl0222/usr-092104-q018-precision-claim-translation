/** 精准医学主张转化领域类型。运行时单一事实源见 src/constants.js。 */

/** 主张成熟度阶梯。 */
export type Maturity =
  | "HYPOTHESIS"
  | "SINGLE_CELL_ASSOCIATION"
  | "MECHANISTIC_SUPPORT"
  | "CLINICAL_EVIDENCE"
  | "ACTIONABLE";

/** 用途许可，宽严顺序 research < education < clinical。 */
export type IntendedUse = "research" | "education" | "clinical";

export type AggregateType =
  | "consent_grant"
  | "omics_release"
  | "analysis_run"
  | "cell_subset"
  | "target_candidate"
  | "mechanism_experiment"
  | "clinical_study"
  | "stratification_rule"
  | "evidence_claim"
  | "use_decision"
  | "external_statement";

export type EventType =
  | "CONSENT_GRANTED"
  | "CONSENT_WITHDRAWN"
  | "DATA_AUTHORIZED"
  | "DATA_WITHDRAWN"
  | "ANALYSIS_FROZEN"
  | "MODEL_VERSIONED"
  | "CELL_SUBSET_DEFINED"
  | "CELL_SUBSET_REANNOTATED"
  | "TARGET_PROPOSED"
  | "MECHANISM_TESTED"
  | "CLINICAL_STUDY_RECORDED"
  | "STRATIFICATION_RULE_SET"
  | "CLAIM_PROPOSED"
  | "CLAIM_PROMOTED"
  | "EVIDENCE_PROMOTED"
  | "CLAIM_WITHDRAWN"
  | "USE_APPROVED"
  | "STATEMENT_PUBLISHED"
  | "STATEMENT_RETRACTED";

/** 血缘引用；version 锚定冻结版本，缺省表示引用当前版本。 */
export interface DomainLink {
  type: AggregateType;
  id: string;
  version?: number;
}

export type SignerRole =
  | "researcher"
  | "educator"
  | "licensed_physician"
  | "clinical_governance_board"
  | "data_governance_officer";

export interface Signer {
  staff_id: string;
  role: SignerRole;
}

/** 领域事件信封。 */
export interface DomainEvent {
  event_id: string;
  event_type: EventType;
  aggregate_type: AggregateType;
  aggregate_id: string;
  occurred_at: string;
  version: number;
  summary: string;
  payload?: Record<string, unknown> & {
    links?: DomainLink[];
    statement?: string;
    maturity?: Maturity;
    promoted_from?: Maturity;
    promoted_to?: Maturity;
    intended_use?: IntendedUse;
    statement_use?: IntendedUse;
    signer?: Signer;
    applicable_population?: string;
    claim_ref?: DomainLink;
    claim_id?: string;
    claim_version?: number;
    signed_claim_version?: number;
    de_identified?: boolean;
    open_questions?: string[];
    affected_claim_ids?: string[];
    affected_course_ids?: string[];
  };
}

/** 单条事件的校验错误。 */
export interface ValidationError {
  event_id?: string;
  code: string;
  message: string;
}
