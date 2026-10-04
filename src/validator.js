/**
 * 领域校验：
 *  - validateEvent：单条事件信封与 payload 形状（按 contracts/domain.schema.json）。
 *  - validateStream：跨事件语义守卫。按时间顺序逐条检查，再做流末完整性检查。
 *
 * 关键守卫（与 README 对应）：
 *  G1 统计相关不得表述为因果；预测疗效类主张须有临床研究成熟度。
 *  G2 成熟度只能逐级人工晋升；M3→M4 需阳性临床研究、适用人群与分层规则。
 *  G3 科研/教学主张不得直接生成临床治疗表述；临床用途须 M4 + 合格临床医师签署 + 限定人群。
 *  G4 教学仅可见去标识案例，且来源样本同意包含教学范围。
 *  G5 撤回数据 / 修订注释 / 更新模型必须出具影响评估，指出受影响主张、课程、表述与决策，
 *     并为已发表内容保留其当时所用版本快照。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createState, applyEvent, provenanceClosure } from "./state.js";
import { validateAgainstSchema } from "./schema-check.js";

const envelopeRequired = ["event_id", "event_type", "aggregate_type", "aggregate_id", "occurred_at", "version", "summary"];

let cachedSchema;
export function loadSchema() {
  if (!cachedSchema) {
    const url = new URL("../contracts/domain.schema.json", import.meta.url);
    cachedSchema = JSON.parse(readFileSync(url, "utf8"));
  }
  return cachedSchema;
}

/** 单条事件形状校验，返回错误信息字符串数组（保持与旧版调用方式兼容）。 */
export function validateEvent(record, schema = loadSchema()) {
  const errors = envelopeRequired.filter((name) => !(name in record)).map((name) => `缺少字段：${name}`);
  if ("version" in record && (!Number.isInteger(record.version) || record.version < 1)) {
    errors.push("version 必须是正整数");
  }
  errors.push(...validateAgainstSchema(schema, record));
  return [...new Set(errors)];
}

const LEVEL_ORDER = { M1: 1, M2: 2, M3: 3, M4: 4 };
const CAUSAL_PHRASES = ["导致", "治愈", "因果", "提高疗效", "改善疗效", "延长生存", "降低死亡"];
const HEDGE_MARKERS = ["相关", "关联", "提示", "可能"];

/** 扫描事件流，返回结构化违规列表 [{code, message, event_id}]。 */
export function validateStream(events, schema = loadSchema()) {
  const violations = [];
  const push = (event, code, message) => violations.push({ code, event_id: event?.event_id ?? null, message });

  // —— 形状与基本顺序 ——
  const state = createState();
  const seenEventIds = new Set();
  const aggVersion = new Map();
  const eventsById = new Map();

  for (const e of events) {
    for (const msg of validateEvent(e, schema)) push(e, "schema_violation", msg);
    if (seenEventIds.has(e.event_id)) push(e, "duplicate_event_id", `event_id 重复：${e.event_id}`);
    seenEventIds.add(e.event_id);
    eventsById.set(e.event_id, e);

    const key = `${e.aggregate_type}|${e.aggregate_id}`;
    const prev = aggVersion.get(key);
    if (prev !== undefined && e.version !== prev + 1) {
      push(e, "version_gap", `聚合 ${key} 版本必须连续递增：上一版本 ${prev}，收到 ${e.version}`);
    }
    aggVersion.set(key, e.version);

    for (const v of semanticChecks(e, state, eventsById)) push(e, v.code, v.message);
    applyEvent(state, e);
  }

  for (const v of streamEndChecks(events)) push(v.event, v.code, v.message);
  return violations;
}

/** 在应用第 e 条事件之前，依据“此前状态”做语义判断。 */
function semanticChecks(e, s, eventsById) {
  const out = [];
  const p = e.payload ?? {};

  const requireClaim = (id) => {
    const c = s.claims.get(id);
    if (!c) out.push({ code: "unknown_claim", message: `主张不存在：${id}` });
    return c;
  };

  switch (e.event_type) {
    case "DATA_AUTHORIZED": {
      const consent = s.consents.get(p.consent_id);
      if (!consent || consent.status !== "granted") {
        out.push({ code: "consent_missing", message: `组学发布 ${e.aggregate_id} 缺少有效同意：${p.consent_id}` });
      } else if (!consent.scopes.includes("research")) {
        out.push({ code: "consent_scope_exceeded", message: `同意 ${consent.id} 未授予 research 范围，不能用于组学研究` });
      }
      break;
    }
    case "ANALYSIS_FROZEN": {
      for (const id of p.input_release_ids ?? []) {
        if (!s.releases.has(id)) out.push({ code: "unknown_release", message: `分析引用了未授权的组学发布：${id}` });
      }
      break;
    }
    case "CELL_SUBSET_REGISTERED":
      if (!s.runs.has(p.analysis_run_id)) out.push({ code: "unknown_run", message: `细胞亚群引用了不存在的分析：${p.analysis_run_id}` });
      break;
    case "TARGET_NOMINATED":
      for (const id of p.subset_ids ?? []) {
        if (!s.subsets.has(id)) out.push({ code: "unknown_subset", message: `候选靶点引用了不存在的细胞亚群：${id}` });
      }
      break;
    case "MECHANISM_ASSAYED":
      if (!s.targets.has(p.target_id)) out.push({ code: "unknown_target", message: `机制实验引用了不存在的候选靶点：${p.target_id}` });
      break;
    case "CLAIM_PROPOSED": {
      if (LEVEL_ORDER[p.maturity_level] > LEVEL_ORDER.M2) {
        out.push({ code: "maturity_skip", message: "新主张只能在 M1/M2 提出，M3/M4 必须经 EVIDENCE_PROMOTED 逐级晋升" });
      }
      if (p.claim_category === "predictive_efficacy" && LEVEL_ORDER[p.maturity_level] < LEVEL_ORDER.M3) {
        out.push({ code: "efficacy_without_clinical", message: "预测疗效类主张至少需要 M3 临床研究证据，不能由单细胞关联直接提出" });
      }
      if (p.inference_strength === "causal") {
        if (e.actor?.role === "system") {
          out.push({ code: "association_worded_as_causal", message: "系统不得自动把统计相关写为因果" });
        }
        const supported = (p.provenance ?? []).some((r) => {
          const m = s.mechanisms.get(r.id);
          return r.kind === "mechanism_experiment" && m && m.result === "supports";
        });
        if (!supported) out.push({ code: "causal_without_mechanism", message: "因果断言必须引用结果为 supports 的机制实验" });
      }
      if (p.inference_strength === "statistical_association") checkWording(p.statement, out);
      if (p.intended_uses?.includes("clinical")) {
        out.push({ code: "clinical_use_below_m4", message: "主张提出阶段不得声明临床用途；M4 晋升后由 USE_APPROVED 单独签署" });
      }
      for (const ref of p.provenance ?? []) {
        if (ref.kind === "analysis_run" && !s.runs.has(ref.id)) {
          out.push({ code: "broken_provenance", message: `来源链引用了不存在的分析：${ref.id}` });
        }
        if (ref.kind === "cell_subset" && !s.subsets.has(ref.id)) {
          out.push({ code: "broken_provenance", message: `来源链引用了不存在的细胞亚群：${ref.id}` });
        }
        if (ref.kind === "clinical_study" && !s.studies.has(ref.id)) {
          out.push({ code: "broken_provenance", message: `来源链引用了不存在的临床研究：${ref.id}` });
        }
      }
      break;
    }
    case "EVIDENCE_PROMOTED": {
      const c = s.claims.get(e.aggregate_id);
      if (!c) {
        out.push({ code: "unknown_claim", message: `晋升目标主张不存在：${e.aggregate_id}` });
        break;
      }
      if (c.status === "withdrawn") out.push({ code: "claim_withdrawn", message: "已撤回主张不得继续晋升" });
      if (p.from_level !== c.level) {
        out.push({ code: "promotion_mismatch", message: `from_level=${p.from_level} 与主张当前级别 ${c.level} 不一致` });
      }
      if (LEVEL_ORDER[p.to_level] !== LEVEL_ORDER[c.level] + 1) {
        out.push({ code: "maturity_skip", message: `成熟度只能逐级晋升：${c.level} → ${p.to_level}` });
      }
      const refs = p.supporting_refs ?? [];
      if (p.to_level === "M3") {
        const hasStudy = refs.some((r) => r.kind === "clinical_study" && s.studies.has(r.id));
        if (!hasStudy) out.push({ code: "promotion_evidence_missing", message: "晋升 M3 必须引用至少一项已登记临床研究" });
      }
      if (p.to_level === "M4") {
        const strong = refs.some((r) => {
          const st = s.studies.get(r.id);
          return r.kind === "clinical_study" && st && ["phase2", "phase3_rct", "meta_analysis"].includes(st.design) && st.result === "positive";
        });
        if (!strong) out.push({ code: "promotion_evidence_missing", message: "晋升 M4 必须引用阳性的 II 期/III 期 RCT/荟萃分析证据" });
        const snap = c.versions.get(c.currentVersion);
        if (!snap.applicability?.inclusion?.length) {
          out.push({ code: "population_not_scoped", message: "晋升 M4 必须限定适用人群（inclusion 非空）" });
        }
      }
      if (p.new_inference_strength) {
        const strengthOrder = { statistical_association: 1, mechanistically_supported: 2, causal: 3 };
        if (strengthOrder[p.new_inference_strength] < strengthOrder[c.strength]) {
          out.push({ code: "association_worded_as_causal", message: "晋升事件不得下调推断强度；弱化结论应通过注释修订或撤回" });
        }
        if (p.new_inference_strength === "causal") {
          if (e.actor?.role === "system") out.push({ code: "association_worded_as_causal", message: "系统不得自动把统计相关升级为因果" });
          const mechOk = refs.some((r) => r.kind === "mechanism_experiment" && s.mechanisms.get(r.id)?.result === "supports");
          const studyOk = refs.some((r) => {
            const st = s.studies.get(r.id);
            return r.kind === "clinical_study" && st && ["phase2", "phase3_rct", "meta_analysis"].includes(st.design) && st.result === "positive";
          });
          if (!mechOk) out.push({ code: "causal_without_mechanism", message: "升级为因果必须引用结果为 supports 的机制实验" });
          if (!studyOk) out.push({ code: "causal_without_mechanism", message: "升级为因果必须同时引用阳性临床研究" });
        }
      }
      break;
    }
    case "ANNOTATION_REVISED": {
      const c = requireClaim(e.aggregate_id);
      if (c) {
        if (c.status === "withdrawn") out.push({ code: "claim_withdrawn", message: "已撤回主张不能修订注释" });
        if (!c.versions.has(p.revision_of_version)) out.push({ code: "unknown_version", message: `被修订版本不存在：v${p.revision_of_version}` });
        if (c.versions.has(p.new_version) || p.new_version <= p.revision_of_version) {
          out.push({ code: "bad_new_version", message: `新版本号必须递增且未使用：v${p.new_version}` });
        }
      }
      break;
    }
    case "CLAIM_WITHDRAWN": {
      const c = requireClaim(e.aggregate_id);
      if (c && c.status === "withdrawn") out.push({ code: "claim_withdrawn", message: "主张已处于撤回状态" });
      break;
    }
    case "STRATIFICATION_RULE_PUBLISHED": {
      const c = requireClaim(p.claim_id);
      if (c) {
        const snap = c.versions.get(p.claim_version);
        if (!snap) out.push({ code: "unknown_version", message: `分层规则引用的主张版本不存在：${p.claim_id}@v${p.claim_version}` });
        else if (snap.maturity_level !== "M4") out.push({ code: "clinical_use_below_m4", message: "只有 M4 主张可以发布临床分层规则" });
        if (!p.inclusion?.length) out.push({ code: "population_not_scoped", message: "分层规则必须给出纳入人群" });
      }
      break;
    }
    case "USE_APPROVED": {
      const c = requireClaim(p.claim_id);
      if (c) {
        const snap = c.versions.get(p.claim_version);
        if (!snap) {
          out.push({ code: "unknown_version", message: `签署引用的主张版本不存在：${p.claim_id}@v${p.claim_version}` });
        }
        if (c.status === "withdrawn") out.push({ code: "stale_or_withdrawn_claim_cited", message: "不得对已撤回主张进行用途签署" });
        if (p.decision === "approved" && p.use === "clinical") {
          if (snap?.maturity_level !== "M4") out.push({ code: "clinical_use_below_m4", message: "临床用途仅可批准 M4 主张" });
          if (p.signer?.role !== "qualified_clinician") {
            out.push({ code: "clinical_use_unsigned", message: "临床用途判断必须由 qualified_clinician 签署" });
          }
          const rule = s.rules.get(p.stratification_rule_id ?? "");
          if (!rule) out.push({ code: "stratification_missing", message: "临床批准必须绑定已发布的分层规则" });
          else if (rule.claim_id !== p.claim_id || rule.claim_version !== p.claim_version) {
            out.push({ code: "stratification_mismatch", message: "分层规则与签署的主张版本不一致" });
          }
          if (!p.scope_population) out.push({ code: "population_not_scoped", message: "临床批准必须限定适用人群（scope_population）" });
        }
        if (p.decision !== "denied" && !p.signer?.person_id) {
          out.push({ code: "clinical_use_unsigned", message: "用途决定必须有签署人" });
        }
      }
      break;
    }
    case "STATEMENT_PUBLISHED": {
      const c = requireClaim(p.claim_id);
      if (c) {
        const snap = c.versions.get(p.claim_version);
        if (!snap) out.push({ code: "unknown_version", message: `表述引用的主张版本不存在：${p.claim_id}@v${p.claim_version}` });
        if (c.status === "withdrawn") out.push({ code: "stale_or_withdrawn_claim_cited", message: "对外表述引用了已撤回主张" });
        if (snap) {
          if (!snap.intended_uses.includes(p.use_context)) {
            out.push({ code: "use_outside_boundary", message: `主张未授权 ${p.use_context} 用途，不能在该场景发表表述` });
          }
          if (snap.inference_strength === "statistical_association") checkWording(p.wording, out);
        }
        if (p.use_context === "clinical") {
          const approved = s.decisions.some(
            (d) => d.claim_id === p.claim_id && d.claim_version === p.claim_version && d.use === "clinical" && d.decision === "approved"
          );
          if (!approved) out.push({ code: "research_claim_used_for_treatment", message: "临床场景表述必须先有合格临床医师对该版本的临床用途批准" });
        }
      }
      break;
    }
    case "COURSE_PUBLISHED": {
      for (const ref of p.refs ?? []) {
        const c = s.claims.get(ref.claim_id);
        if (!c) {
          out.push({ code: "unknown_claim", message: `课程引用了不存在的主张：${ref.claim_id}` });
          continue;
        }
        const snap = c.versions.get(ref.claim_version);
        if (!snap) out.push({ code: "unknown_version", message: `课程引用的主张版本不存在：${ref.claim_id}@v${ref.claim_version}` });
        if (c.status === "withdrawn") out.push({ code: "stale_or_withdrawn_claim_cited", message: `课程引用了已撤回主张：${ref.claim_id}` });
        if (snap && !snap.intended_uses.includes("teaching")) {
          out.push({ code: "use_outside_boundary", message: `课程引用的主张未开放教学用途：${ref.claim_id}` });
        }
      }
      if (p.access !== "deidentified_only") {
        out.push({ code: "teaching_identifiable_data", message: "课程只允许 deidentified_only 访问级别" });
      }
      // 教学来源样本必须在有效同意中授予教学范围
      for (const ref of p.refs ?? []) {
        const c = s.claims.get(ref.claim_id);
        if (!c) continue;
        const { releaseIds } = provenanceClosure(s, c);
        for (const rid of releaseIds) {
          const rel = s.releases.get(rid);
          const consent = rel && s.consents.get(rel.consent_id);
          if (!consent || consent.status !== "granted" || !consent.scopes.includes("teaching_deidentified")) {
            out.push({ code: "teaching_identifiable_data", message: `案例来源样本 ${rid} 的同意未授予去标识教学范围` });
          }
        }
      }
      break;
    }
    case "IMPACT_ASSESSED": {
      const trigger = eventsById?.get(p.trigger_event_id);
      if (!trigger) {
        out.push({ code: "impact_assessment_missing", message: `影响评估引用的触发事件不存在：${p.trigger_event_id}` });
      } else if (trigger.occurred_at > e.occurred_at) {
        out.push({ code: "impact_trigger_mismatch", message: "影响评估不能早于其触发事件" });
      } else {
        const expectedType =
          trigger.event_type === "CONSENT_WITHDRAWN" ? "data_withdrawal"
          : trigger.event_type === "ANNOTATION_REVISED" ? "annotation_revision"
          : "model_update";
        if (!["CONSENT_WITHDRAWN", "ANNOTATION_REVISED", "MODEL_UPDATED"].includes(trigger.event_type)) {
          out.push({ code: "impact_trigger_mismatch", message: "影响评估只能由撤回数据、修订注释或更新模型触发" });
        } else if (p.trigger_type !== expectedType) {
          out.push({ code: "impact_trigger_mismatch", message: `影响评估类型应为 ${expectedType}` });
        }
        for (const v of verifyImpactCoverage(trigger, p, s)) out.push(v);
      }
      break;
    }
    default:
      break;
  }
  return out;
}

function checkWording(text, out) {
  // 先剔除“否定窗口”：非因果 / 不能推断因果 / 不构成治疗建议 等不算越界表述
  const negated = new RegExp(
    "(?:并非|尚不能|尚未|不能|不可|不得|无法|不是|未|非|无)[^，。；,;]{0,10}(?:"
    + CAUSAL_PHRASES.join("|") + ")",
    "g"
  );
  const residue = text.replace(negated, "");
  const hit = CAUSAL_PHRASES.find((w) => residue.includes(w));
  if (hit) {
    out.push({ code: "association_worded_as_causal", message: `统计相关不得使用因果/疗效措辞：“${hit}”；应表述为相关或关联` });
  } else if (!HEDGE_MARKERS.some((w) => text.includes(w))) {
    out.push({ code: "association_worded_as_causal", message: "统计相关表述须带限定语（相关/关联/提示/可能）" });
  }
}

/* ============== 流末：每个触发事件都必须有影响评估（时点正确性在事件发生时校验） ============== */

function streamEndChecks(events) {
  const out = [];
  const add = (event, code, message) => out.push({ event, code, message });

  const triggers = events.filter((e) =>
    ["CONSENT_WITHDRAWN", "ANNOTATION_REVISED", "MODEL_UPDATED"].includes(e.event_type)
  );
  const assessments = events.filter((e) => e.event_type === "IMPACT_ASSESSED");

  for (const t of triggers) {
    const expectedType =
      t.event_type === "CONSENT_WITHDRAWN" ? "data_withdrawal"
      : t.event_type === "ANNOTATION_REVISED" ? "annotation_revision"
      : "model_update";
    const ia = assessments.find((a) => a.payload.trigger_event_id === t.event_id);
    if (!ia) {
      add(t, "impact_assessment_missing", `${t.event_type} 之后必须出具 IMPACT_ASSESSED（${expectedType}）`);
    }
  }
  return out;
}

/**
 * 在影响评估“出具时刻”的状态上核对覆盖完整性。
 * stateAtTime 是评估事件应用之前的归约状态，因此只包含当时已经存在的主张、
 * 表述、课程与决定；之后才发表的内容不要求该评估覆盖。
 */
function verifyImpactCoverage(trigger, payload, s) {
  const out = [];
  const err = (code, message) => out.push({ code, message });
  const affectedClaimIds = affectedClaimsFor(trigger, s);
  const listedLoose = new Set((payload.affected ?? []).map((a) => `${a.kind}|${a.id}`));

  for (const cid of affectedClaimIds) {
    if (!listedLoose.has(`claim|${cid}`)) err("impact_incomplete", `影响评估遗漏受影响主张：${cid}`);

    for (const st of s.statements.filter((x) => x.claim_id === cid)) {
      if (!listedLoose.has(`statement|${st.id}`)) err("impact_incomplete", `影响评估遗漏受影响对外表述：${st.id}`);
      const kept = (payload.preserved_snapshots ?? []).some(
        (k) => k.of === "claim" && k.id === cid && k.version === st.claim_version
      );
      if (!kept) err("snapshot_not_preserved", `必须保留表述 ${st.id} 发表时所用版本：${cid}@v${st.claim_version}`);
    }
    for (const [courseId, course] of s.courses) {
      const hit = course.refs.find((r) => r.claim_id === cid);
      if (hit) {
        if (!listedLoose.has(`course|${courseId}`)) err("impact_incomplete", `影响评估遗漏受影响课程：${courseId}`);
        const kept = (payload.preserved_snapshots ?? []).some(
          (k) => k.of === "claim" && k.id === cid && k.version === hit.claim_version
        );
        if (!kept) err("snapshot_not_preserved", `课程 ${courseId} 引用的 ${cid}@v${hit.claim_version} 必须保留发表时版本快照`);
      }
    }
    for (const d of s.decisions.filter((x) => x.claim_id === cid)) {
      if (!listedLoose.has(`use_decision|${d.id}`)) err("impact_incomplete", `影响评估遗漏受影响用途决定：${d.id}`);
    }
  }

  if (trigger.event_type === "MODEL_UPDATED") {
    for (const runId of trigger.payload.replaces_run_ids ?? []) {
      const run = s.runs.get(runId);
      const kept = (payload.preserved_snapshots ?? []).some(
        (k) => k.of === "analysis_run" && k.id === runId && k.version === run?.analysis_version
      );
      if (!kept) err("snapshot_not_preserved", `模型更新后必须保留被替换分析的已发表版本快照：${runId}@v${run?.analysis_version ?? "?"}`);
    }
  }
  return out;
}

/** 在给定状态上计算某触发事件影响到的全部主张。 */
function affectedClaimsFor(trigger, s) {
  let seeds;
  if (trigger.event_type === "ANNOTATION_REVISED") {
    seeds = new Set([trigger.aggregate_id]);
  } else if (trigger.event_type === "CONSENT_WITHDRAWN") {
    const consentId = trigger.aggregate_id;
    const releaseIds = new Set();
    for (const [, rel] of s.releases) if (rel.consent_id === consentId) releaseIds.add(rel.id);
    seeds = new Set();
    for (const [, c] of s.claims) {
      const { releaseIds: used } = provenanceClosure(s, c);
      if ([...releaseIds].some((r) => used.has(r))) seeds.add(c.id);
    }
  } else {
    const replaced = new Set(trigger.payload.replaces_run_ids ?? []);
    seeds = new Set();
    for (const [, c] of s.claims) {
      const { runIds } = provenanceClosure(s, c);
      if ([...replaced].some((r) => runIds.has(r))) seeds.add(c.id);
    }
  }
  return [...seeds].filter((id) => s.claims.has(id));
}
