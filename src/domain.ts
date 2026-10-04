/**
 * 精准医学主张转化领域类型。
 * 与 contracts/domain.schema.json 对应；跨事件守卫规则见 src/validator.js。
 */

// ---------- 受控词汇 ----------

/** 证据成熟度阶梯：只可逐级、人工晋升。 */
export type MaturityLevel = "M1" | "M2" | "M3" | "M4";

/** 推断强度与成熟度正交；statistical_association 永远不得被系统改写为 causal。 */
export type InferenceStrength = "statistical_association" | "mechanistically_supported" | "causal";

export type UseKind = "research" | "teaching" | "clinical";

export type ConsentScope = "research" | "teaching_deidentified" | "clinical";

export type ClaimCategory =
  | "biomarker_association"
  | "mechanism"
  | "predictive_efficacy"
  | "diagnostic"
  | "prognostic";

export type ActorRole =
  | "researcher"
  | "data_engineer"
  | "curator"
  | "qualified_clinician"
  | "governance_officer"
  | "teacher"
  | "system";

// ---------- 信封 ----------

export interface Actor {
  id: string;
  role: ActorRole;
}

export interface DomainEvent<TPayload = Record<string, unknown>> {
  event_id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  occurred_at: string;
  version: number;
  summary: string;
  actor?: Actor;
  payload: TPayload;
}

// ---------- 来源与适用人群 ----------

export type ProvenanceKind =
  | "omics_release"
  | "analysis_run"
  | "cell_subset"
  | "candidate_target"
  | "mechanism_experiment"
  | "clinical_study";

export interface ProvenanceRef {
  kind: ProvenanceKind;
  id: string;
  /** 钉住的版本号；仅存在单一不可变版本时为 null。 */
  version: number | null;
}

export interface Applicability {
  inclusion: string[];
  exclusion: string[];
}

// ---------- 主张相关 payload ----------

export interface ClaimProposedPayload {
  statement: string;
  claim_category: ClaimCategory;
  inference_strength: InferenceStrength;
  maturity_level: MaturityLevel;
  provenance: ProvenanceRef[];
  intended_uses: UseKind[];
  applicability?: Applicability;
  asserted_by?: { person_id: string; role: "researcher" | "curator" | "qualified_clinician" };
  unknowns: string[];
}

export interface EvidencePromotedPayload {
  from_level: MaturityLevel;
  to_level: MaturityLevel;
  promoted_by: string;
  rationale: string;
  supporting_refs: ProvenanceRef[];
}

export interface WithdrawalPayload {
  reason: string;
}

export interface AnnotationRevisedPayload {
  revision_of_version: number;
  new_version: number;
  changes: string;
  editor: string;
  /** 旧版本不可变快照位置；发表时所用版本永远可回溯。 */
  preserved_snapshot_ref: string;
}

// ---------- 用途签署与对外表述 ----------

export interface UseApprovedPayload {
  claim_id: string;
  claim_version: number;
  use: UseKind;
  decision: "approved" | "restricted" | "denied";
  signer: {
    person_id: string;
    role: "qualified_clinician" | "governance_officer" | "researcher";
    license_id?: string;
  };
  /** 临床批准必须绑定与主张版本一致的分层规则。 */
  stratification_rule_id: string | null;
  scope_population?: string;
  valid_until?: string | null;
}

export interface StatementPublishedPayload {
  channel: string;
  use_context: UseKind;
  claim_id: string;
  claim_version: number;
  wording: string;
  snapshot_ref: string;
}

// ---------- 影响评估 ----------

export type ImpactTriggerType = "data_withdrawal" | "annotation_revision" | "model_update";

export interface ImpactAssessedPayload {
  trigger_event_id: string;
  trigger_type: ImpactTriggerType;
  affected: Array<{
    kind: "claim" | "course" | "statement" | "use_decision";
    id: string;
    version: number | null;
    action: "revalidate" | "retract_reference" | "restrict_use" | "none";
  }>;
  preserved_snapshots: Array<{
    of: "claim" | "statement" | "course" | "analysis_run";
    id: string;
    version: number;
    ref: string;
  }>;
  actions_required: string[];
}

/** 校验违规：validateStream 的返回元素。 */
export interface ValidationViolation {
  code:
    | "schema_violation"
    | "duplicate_event_id"
    | "version_gap"
    | "consent_missing"
    | "consent_scope_exceeded"
    | "unknown_release"
    | "unknown_run"
    | "unknown_subset"
    | "unknown_target"
    | "unknown_claim"
    | "unknown_version"
    | "broken_provenance"
    | "maturity_skip"
    | "efficacy_without_clinical"
    | "association_worded_as_causal"
    | "causal_without_mechanism"
    | "clinical_use_below_m4"
    | "clinical_use_unsigned"
    | "promotion_mismatch"
    | "promotion_evidence_missing"
    | "population_not_scoped"
    | "stratification_missing"
    | "stratification_mismatch"
    | "research_claim_used_for_treatment"
    | "use_outside_boundary"
    | "stale_or_withdrawn_claim_cited"
    | "teaching_identifiable_data"
    | "impact_assessment_missing"
    | "impact_trigger_mismatch"
    | "impact_incomplete"
    | "snapshot_not_preserved"
    | "claim_withdrawn"
    | "bad_new_version";
  event_id: string | null;
  message: string;
}
