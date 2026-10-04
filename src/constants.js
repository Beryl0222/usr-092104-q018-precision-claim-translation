/**
 * 精准医学主张转化——领域常量（单一事实源）。
 *
 * 事件与聚合的合法归属、payload 必需字段、成熟度晋升要求均在此定义，
 * 由 src/validator.js 执行，contracts/domain.schema.json 与之保持一致。
 */

/** 主张成熟度阶梯（序号即等级）。 */
export const MATURITY_LEVELS = {
  HYPOTHESIS: 0, // 假设：待验证
  SINGLE_CELL_ASSOCIATION: 1, // 单细胞统计关联（相关，非因果）
  MECHANISTIC_SUPPORT: 2, // 实验室机制支持
  CLINICAL_EVIDENCE: 3, // 临床研究结果
  ACTIONABLE: 4, // 可在限定人群用于个人决策
};

export const MATURITY_ORDER = [
  "HYPOTHESIS",
  "SINGLE_CELL_ASSOCIATION",
  "MECHANISTIC_SUPPORT",
  "CLINICAL_EVIDENCE",
  "ACTIONABLE",
];

/** 用途许可，数值越大用途越宽；不得跨级使用。 */
export const USES = {
  RESEARCH: "research",
  EDUCATION: "education",
  CLINICAL: "clinical",
};

export const USE_RANK = { research: 0, education: 1, clinical: 2 };

/** 各用途签署人必须具备的角色。 */
export const SIGNER_ROLES = {
  research: ["researcher", "data_governance_officer"],
  education: ["educator", "data_governance_officer"],
  clinical: ["licensed_physician", "clinical_governance_board"],
};

/** 聚合类型。 */
export const AGGREGATES = {
  CONSENT_GRANT: "consent_grant",
  OMICS_RELEASE: "omics_release",
  ANALYSIS_RUN: "analysis_run",
  CELL_SUBSET: "cell_subset",
  TARGET_CANDIDATE: "target_candidate",
  MECHANISM_EXPERIMENT: "mechanism_experiment",
  CLINICAL_STUDY: "clinical_study",
  STRATIFICATION_RULE: "stratification_rule",
  EVIDENCE_CLAIM: "evidence_claim",
  USE_DECISION: "use_decision",
  EXTERNAL_STATEMENT: "external_statement",
};

/**
 * 事件规则。
 * - aggregate：必须归属的聚合类型
 * - require：payload 顶层必需字段
 * - links：payload.links 中必须出现的目标聚合类型（各至少一条）
 */
export const EVENT_RULES = {
  CONSENT_GRANTED: {
    aggregate: "consent_grant",
    require: ["donor_ref", "allowed_uses"],
    links: [],
  },
  CONSENT_WITHDRAWN: {
    aggregate: "consent_grant",
    require: ["reason", "affected_claim_ids", "affected_course_ids"],
    links: [],
  },
  DATA_AUTHORIZED: {
    aggregate: "omics_release",
    require: ["data_type", "release_version"],
    links: ["consent_grant"],
  },
  DATA_WITHDRAWN: {
    aggregate: "omics_release",
    require: ["reason", "affected_claim_ids", "affected_course_ids"],
    links: [],
  },
  ANALYSIS_FROZEN: {
    aggregate: "analysis_run",
    require: ["pipeline", "model_version"],
    links: ["omics_release"],
  },
  MODEL_VERSIONED: {
    aggregate: "analysis_run",
    require: [
      "new_model_version",
      "previous_model_version",
      "affected_claim_ids",
      "affected_course_ids",
    ],
    links: ["analysis_run"],
  },
  CELL_SUBSET_DEFINED: {
    aggregate: "cell_subset",
    require: ["annotation"],
    links: ["analysis_run"],
  },
  CELL_SUBSET_REANNOTATED: {
    aggregate: "cell_subset",
    require: [
      "annotation",
      "previous_version",
      "affected_claim_ids",
      "affected_course_ids",
    ],
    links: ["analysis_run"],
  },
  TARGET_PROPOSED: {
    aggregate: "target_candidate",
    require: ["symbol"],
    links: ["cell_subset"],
  },
  MECHANISM_TESTED: {
    aggregate: "mechanism_experiment",
    require: ["assay", "finding"],
    links: ["target_candidate"],
  },
  CLINICAL_STUDY_RECORDED: {
    aggregate: "clinical_study",
    require: ["study_ref", "population", "result_summary"],
    links: ["target_candidate"],
  },
  STRATIFICATION_RULE_SET: {
    aggregate: "stratification_rule",
    require: ["rule_version", "definition"],
    links: ["clinical_study"],
  },
  CLAIM_PROPOSED: {
    aggregate: "evidence_claim",
    require: ["statement", "maturity"],
    links: [],
  },
  CLAIM_PROMOTED: {
    aggregate: "evidence_claim",
    require: ["promoted_from", "promoted_to", "reviewer"],
    links: [],
  },
  /** 旧版事件名，语义同 CLAIM_PROMOTED，保留以兼容既有交换。 */
  EVIDENCE_PROMOTED: {
    aggregate: "evidence_claim",
    require: ["promoted_from", "promoted_to", "reviewer"],
    links: [],
  },
  CLAIM_WITHDRAWN: {
    aggregate: "evidence_claim",
    require: ["reason", "affected_claim_ids", "affected_course_ids"],
    links: [],
  },
  USE_APPROVED: {
    aggregate: "use_decision",
    require: ["intended_use", "signer", "claim_ref"],
    links: [],
  },
  STATEMENT_PUBLISHED: {
    aggregate: "external_statement",
    require: [
      "course_id",
      "title",
      "statement_use",
      "claim_id",
      "claim_version",
      "signed_claim_version",
      "de_identified",
    ],
    links: ["use_decision"],
  },
  STATEMENT_RETRACTED: {
    aggregate: "external_statement",
    require: ["reason", "affected_claim_ids", "affected_course_ids"],
    links: [],
  },
};

/** 晋升到某成熟度时，主张血缘中必须齐备的聚合类型（含更低级要求）。 */
export const MATURITY_LINK_REQUIREMENTS = {
  1: ["analysis_run", "cell_subset"],
  2: ["analysis_run", "cell_subset", "mechanism_experiment"],
  3: ["analysis_run", "cell_subset", "mechanism_experiment", "clinical_study"],
  4: [
    "analysis_run",
    "cell_subset",
    "mechanism_experiment",
    "clinical_study",
    "stratification_rule",
  ],
};

/** 机制实验结论取值；晋升到 2 级要求至少一条 supports。 */
export const MECHANISM_FINDINGS = ["supports", "refutes", "inconclusive"];

/**
 * 措辞红线（大小写不敏感，按子串匹配）。
 * - 成熟度 < 2：不得出现因果措辞（统计相关不能被写成因果）。
 * - 成熟度 < 3：不得出现疗效断言。
 */
export const CAUSAL_TERMS = [
  "导致",
  "引起",
  "机制为",
  "驱动",
  "causes",
  "causal",
  "induces",
  "drives",
];

export const EFFICACY_TERMS = [
  "提高疗效",
  "疗效提高",
  "改善疗效",
  "疗效改善",
  "提升疗效",
  "延长生存",
  "提升应答",
  "提高应答",
  "应答提高",
  "临床获益",
  "improves efficacy",
  "improves survival",
  "increases response",
  "clinical benefit",
];

/** 主张 payload 禁止携带治疗安排字段——科研主张不直接生成治疗方案。 */
export const FORBIDDEN_CLAIM_FIELDS = [
  "treatment_plan",
  "prescription",
  "dosage",
  "regimen",
];

/** 需要声明受影响主张与课程的事件（撤回与修订/更新）。 */
export const AFFECTED_LIST_FIELDS = ["affected_claim_ids", "affected_course_ids"];
