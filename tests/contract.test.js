import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validateEvent, validateStream } from "../src/validator.js";
import {
  researcherView,
  teacherView,
  clinicianView,
  governanceView,
  assertNoIdentifiableData
} from "../src/views.js";

const read = async (name) => JSON.parse(await readFile(new URL(`../data/${name}`, import.meta.url), "utf8"));
const lifecycle = await read("lifecycle.json");
const byId = Object.fromEntries(lifecycle.map((e) => [e.event_id, e]));
const clone = (events) => structuredClone(events);
/** 取严格早于/晚于某时间点的前缀/后缀，方便构造违规场景。 */
const prefixThrough = (events, lastEventId) => {
  const i = events.findIndex((e) => e.event_id === lastEventId);
  return clone(events.slice(0, i + 1));
};
const codes = (violations) => violations.map((v) => v.code);

/* ============================== 单事件形状 ============================== */

test("单条样例符合领域约定", async () => {
  const sample = await read("sample.json");
  assert.deepEqual(validateEvent(sample), []);
});

test("信封缺字段与版本非法", () => {
  const errs = validateEvent({ event_type: "CLAIM_PROPOSED" });
  assert.ok(errs.some((m) => m.includes("缺少字段：event_id")));
  assert.ok(errs.some((m) => m.includes("缺少字段：payload")));
  const bad = validateEvent({ ...byId["evt-009"], version: 0 });
  assert.ok(bad.some((m) => m.includes("version")));
});

test("payload 多余字段与非法枚举被 schema 拒绝", () => {
  const e = structuredClone(byId["evt-009"]);
  e.payload.maturity_level = "M5";
  assert.ok(validateEvent(e).some((m) => m.includes("payload.maturity_level")));
  const e2 = structuredClone(byId["evt-016"]);
  e2.payload.signer.role = "intern";
  assert.ok(validateEvent(e2).some((m) => m.includes("payload.signer.role")));
});

/* ============================== 完整生命周期 ============================== */

test("完整生命周期事件流零违规", () => {
  assert.deepEqual(validateStream(lifecycle), []);
});

test("event_id 重复与聚合版本不连续被拒绝", () => {
  const dup = clone(lifecycle);
  dup[1] = { ...dup[1], event_id: dup[0].event_id };
  assert.ok(codes(validateStream(dup)).includes("duplicate_event_id"));

  const gap = clone(lifecycle);
  gap[13].version = 9; // claim-CL001 的某次晋升跳号
  assert.ok(codes(validateStream(gap)).includes("version_gap"));
});

/* ====================== G0 同意与来源链边界 ====================== */

test("无有效同意或超出同意范围的组学发布被拒绝", () => {
  const noConsent = [structuredClone(byId["evt-002"])];
  assert.ok(codes(validateStream(noConsent)).includes("consent_missing"));

  const granted = structuredClone(byId["evt-001"]);
  granted.payload.scopes = ["teaching_deidentified"];
  const outOfScope = [granted, structuredClone(byId["evt-002"])];
  assert.ok(codes(validateStream(outOfScope)).includes("consent_scope_exceeded"));
});

test("来源链引用不存在对象被拒绝", () => {
  const run = structuredClone(byId["evt-003"]);
  run.payload.input_release_ids = ["rel-ghost"];
  assert.ok(codes(validateStream([run])).includes("unknown_release"));
});

/* ============== G1 统计相关不得被系统写成因果 / 疗效 ============== */

test("统计相关使用因果或疗效措辞被拒绝", () => {
  const base = prefixThrough(lifecycle, "evt-008");
  const claim = structuredClone(byId["evt-009"]);
  claim.payload.statement = "LAG3 高表达提高疗效并延长生存。";
  const v = validateStream([...base, claim]);
  assert.ok(v.some((x) => x.code === "association_worded_as_causal"));
});

test("统计相关表述缺少限定语被拒绝", () => {
  const base = prefixThrough(lifecycle, "evt-008");
  const claim = structuredClone(byId["evt-009"]);
  claim.payload.statement = "LAG3 表达与缓解之间存在某种数量关系。";
  const v = validateStream([...base, claim]);
  assert.ok(v.some((x) => x.code === "association_worded_as_causal"));
});

test("系统角色把推断强度写为 causal 被拒绝，人工且证据充分才允许", () => {
  const base = prefixThrough(lifecycle, "evt-013");
  const promote = structuredClone(byId["evt-014"]);
  promote.payload.new_inference_strength = "causal";
  promote.actor = { id: "bot", role: "system" };
  assert.ok(codes(validateStream([...base, promote])).includes("association_worded_as_causal"));

  // 人工、机制 supports + 阳性 II 期 → 允许
  promote.actor = { id: "dr-gao", role: "qualified_clinician" };
  assert.deepEqual(validateStream([...base, promote]), []);
});

test("预测疗效主张不能在 M3 以下提出", () => {
  const base = prefixThrough(lifecycle, "evt-008");
  const claim = structuredClone(byId["evt-009"]);
  claim.payload.claim_category = "predictive_efficacy";
  const v = validateStream([...base, claim]);
  assert.ok(v.some((x) => x.code === "efficacy_without_clinical"));
});

/* ====================== G2 成熟度逐级人工晋升 ====================== */

test("跳级晋升被拒绝", () => {
  const base = prefixThrough(lifecycle, "evt-011"); // claim 在 M1
  const jump = structuredClone(byId["evt-013"]);
  jump.payload.from_level = "M1";
  jump.payload.to_level = "M3";
  jump.occurred_at = "2026-09-17T12:00:00+08:00";
  const v = validateStream([...base, jump]);
  assert.ok(codes(v).includes("maturity_skip"));
});

test("晋升 M3 必须引用临床研究，晋升 M4 必须阳性 II 期以上且限定人群", () => {
  const toM3 = prefixThrough(lifecycle, "evt-012");
  const bad3 = structuredClone(byId["evt-013"]);
  bad3.payload.supporting_refs = [{ kind: "mechanism_experiment", id: "mech-M001", version: 1 }];
  assert.ok(codes(validateStream([...toM3, bad3])).includes("promotion_evidence_missing"));

  const toM4 = prefixThrough(lifecycle, "evt-013");
  const bad4 = structuredClone(byId["evt-014"]);
  bad4.payload.supporting_refs = [
    { kind: "clinical_study", id: "study-ST001", version: 1 }, // 观察性，不够
    { kind: "mechanism_experiment", id: "mech-M001", version: 1 }
  ];
  assert.ok(codes(validateStream([...toM4, bad4])).includes("promotion_evidence_missing"));
});

test("新主张不得直接以 M3/M4 提出", () => {
  const base = prefixThrough(lifecycle, "evt-008");
  const claim = structuredClone(byId["evt-009"]);
  claim.payload.maturity_level = "M4";
  claim.payload.intended_uses = ["research"];
  assert.ok(codes(validateStream([...base, claim])).includes("maturity_skip"));
});

/* ============== G3 科研主张不得直接生成治疗；临床必须签署+人群 ============== */

test("非 M4 主张的临床用途批准被拒绝", () => {
  const base = prefixThrough(lifecycle, "evt-013"); // 仅到 M3
  const rule = structuredClone(byId["evt-015"]);
  const decision = structuredClone(byId["evt-016"]);
  const v = validateStream([...base, rule, decision]);
  assert.ok(codes(v).includes("clinical_use_below_m4"));
});

test("临床批准缺少合格临床医师签署被拒绝", () => {
  const base = prefixThrough(lifecycle, "evt-015");
  const decision = structuredClone(byId["evt-016"]);
  decision.payload.signer = { person_id: "researcher-07", role: "researcher" };
  const v = validateStream([...base, decision]);
  assert.ok(codes(v).includes("clinical_use_unsigned"));
});

test("临床批准缺少分层规则或未限定人群被拒绝", () => {
  const base = prefixThrough(lifecycle, "evt-014");
  const noRule = structuredClone(byId["evt-016"]);
  noRule.payload.stratification_rule_id = null;
  assert.ok(codes(validateStream([...base, noRule])).includes("stratification_missing"));

  const withRule = prefixThrough(lifecycle, "evt-015");
  const noPop = structuredClone(byId["evt-016"]);
  delete noPop.payload.scope_population;
  assert.ok(codes(validateStream([...withRule, noPop])).includes("population_not_scoped"));
});

test("分层规则与签署版本不一致被拒绝", () => {
  const base = prefixThrough(lifecycle, "evt-015");
  const decision = structuredClone(byId["evt-016"]);
  decision.payload.claim_version = 1; // 规则绑定的是 v2
  const v = validateStream([...base, decision]);
  assert.ok(codes(v).includes("stratification_mismatch"));
});

test("未经临床签署，临床场景表述被拒绝", () => {
  const base = prefixThrough(lifecycle, "evt-015"); // 有规则无签署
  const stmt = structuredClone(byId["evt-017"]);
  const v = validateStream([...base, stmt]);
  assert.ok(codes(v).includes("research_claim_used_for_treatment"));
});

test("用途边界：M1 科研主张不得用于临床表述；科研/教学在授权范围内放行", () => {
  const base = prefixThrough(lifecycle, "evt-011"); // M1，v2，授权 research+teaching

  const research = structuredClone(byId["evt-017"]);
  research.event_id = "stmt-research";
  research.occurred_at = "2026-09-17T12:00:00+08:00";
  research.payload.use_context = "research";
  research.payload.wording = "内部组会：该亚群与缓解相关。";
  assert.deepEqual(validateStream([...base, research]), []);

  const teaching = structuredClone(research);
  teaching.event_id = "stmt-teaching";
  teaching.occurred_at = "2026-09-17T13:00:00+08:00";
  teaching.payload.use_context = "teaching";
  teaching.payload.channel = "教学讲义";
  assert.deepEqual(validateStream([...base, teaching]), []);

  const clinical = structuredClone(research);
  clinical.event_id = "stmt-clinical";
  clinical.occurred_at = "2026-09-17T14:00:00+08:00";
  clinical.payload.use_context = "clinical";
  const v3 = validateStream([...base, clinical]);
  assert.ok(codes(v3).includes("research_claim_used_for_treatment"));
});

/* ====================== G4 教学仅去标识且同意覆盖 ====================== */

test("课程必须为去标识访问级别", () => {
  const base = prefixThrough(lifecycle, "evt-017");
  const course = structuredClone(byId["evt-018"]);
  course.payload.access = "identified";
  // schema 的 const 也会报错；语义层同样拦截
  assert.ok(validateStream([...base, course]).length > 0);
});

test("课程引用未开放教学用途的主张被拒绝", () => {
  const base = prefixThrough(lifecycle, "evt-009");
  base[base.length - 1].payload.intended_uses = ["research"]; // 收窄为仅科研
  const course = structuredClone(byId["evt-018"]);
  course.occurred_at = "2026-09-16T18:00:00+08:00";
  course.payload.refs = [{ claim_id: "claim-CL001", claim_version: 1 }];
  const v = validateStream([...base, course]);
  assert.ok(codes(v).includes("use_outside_boundary"));
});

test("课程来源样本未授予去标识教学同意被拒绝", () => {
  const base = prefixThrough(lifecycle, "evt-017");
  base[0].payload.scopes = ["research", "clinical"]; // 撤销教学范围
  const course = structuredClone(byId["evt-018"]);
  const v = validateStream([...base, course]);
  assert.ok(codes(v).includes("teaching_identifiable_data"));
});

test("教师投影不含任何可识别字段", () => {
  const view = teacherView(lifecycle);
  assert.deepEqual(assertNoIdentifiableData(view), []);
  const text = JSON.stringify(view);
  assert.ok(!text.includes("P-7"));
  assert.ok(!text.includes("consent-C001"));
});

/* ============== G5 撤回 / 修订 / 换模型必须影响评估并保留版本 ============== */

test("撤回数据后没有影响评估被拒绝", () => {
  const v = validateStream(prefixThrough(lifecycle, "evt-021"));
  assert.ok(codes(v).includes("impact_assessment_missing"));
});

test("影响评估遗漏受影响课程/决定或未保留发表版本被拒绝", () => {
  const base = prefixThrough(lifecycle, "evt-019");
  const ia = structuredClone(byId["evt-020"]);
  ia.payload.affected = ia.payload.affected.filter((a) => a.kind !== "course");
  let v = validateStream([...base, ia]);
  assert.ok(codes(v).includes("impact_incomplete"));

  const ia2 = structuredClone(byId["evt-020"]);
  ia2.payload.preserved_snapshots = ia2.payload.preserved_snapshots.filter((k) => k.of !== "analysis_run");
  v = validateStream([...base, ia2]);
  assert.ok(codes(v).includes("snapshot_not_preserved"));
});

test("模型更新后须保留被替换分析版本，且影响评估不能先于触发事件", () => {
  const base = prefixThrough(lifecycle, "evt-018");
  const iaEarly = structuredClone(byId["evt-020"]);
  iaEarly.occurred_at = "2026-09-27T08:00:00+08:00";
  const v = validateStream([...base, byId["evt-019"], iaEarly]);
  assert.ok(codes(v).includes("impact_trigger_mismatch"));
});

test("已撤回主张不得再被签署、晋升或用于表述", () => {
  const withdrawn = prefixThrough(lifecycle, "evt-023");
  const stmt = structuredClone(byId["evt-017"]);
  stmt.event_id = "evt-extra-stmt";
  stmt.occurred_at = "2026-10-02T09:00:00+08:00";
  const v = validateStream([...withdrawn, stmt]);
  assert.ok(codes(v).includes("stale_or_withdrawn_claim_cited"));
});

test("注释修订必须递增版本并保留旧版本快照引用", () => {
  const base = prefixThrough(lifecycle, "evt-009");
  const rev = structuredClone(byId["evt-010"]);
  rev.payload.new_version = 1;
  const v = validateStream([...base, rev]);
  assert.ok(codes(v).includes("bad_new_version"));
});

/* ============================== 角色视图 ============================== */

test("研究者视图给出完整来源链、版本时间线与复现包", () => {
  const [view] = researcherView(lifecycle, { claimId: "claim-CL001" });
  assert.equal(view.current_version, 2);
  assert.equal(view.status, "withdrawn");
  const kinds = view.provenance.map((p) => p.kind);
  assert.ok(kinds.includes("cell_subset"));
  assert.ok(kinds.includes("mechanism_experiment"));
  assert.ok(kinds.includes("clinical_study"));
  assert.ok(view.timeline.some((t) => t.type === "EVIDENCE_PROMOTED" && t.to === "M4"));
  assert.equal(view.reproducibility.pipeline_versions[0].pipeline_version, "3.1.0");
  assert.equal(view.reproducibility.rerun_warnings[0].superseded_by_pipeline, "3.2.0");
});

test("临床视图按患者特征判定适用范围并显式给出未知项", () => {
  const matching = clinicianView(lifecycle, {
    id: "P-9", as_of: "2026-09-25T09:00:00+08:00",
    features: ["MSI-H 结直肠癌", "LAG3_high"]
  });
  assert.equal(matching.evidence_count, 1);
  assert.equal(matching.items[0].patient_match.applies, true);
  assert.ok(matching.items[0].unknowns.length >= 1);
  assert.equal(matching.items[0].decision_active, true);

  const excluded = clinicianView(lifecycle, {
    id: "P-10", as_of: "2026-09-25T09:00:00+08:00",
    features: ["MSI-H 结直肠癌", "LAG3_high", "既往抗 LAG3 治疗"]
  });
  assert.equal(excluded.items[0].patient_match.applies, false);
  assert.deepEqual(excluded.items[0].patient_match.hit_exclusion_features, ["既往抗 LAG3 治疗"]);

  const partial = clinicianView(lifecycle, {
    id: "P-12", as_of: "2026-09-25T09:00:00+08:00",
    features: ["MSI-H 结直肠癌"]
  });
  assert.deepEqual(partial.items[0].patient_match.missing_inclusion_features, ["LAG3_high"]);
});

test("临床视图是时间点视图：撤回后既有决定不再活跃", () => {
  const after = clinicianView(lifecycle, {
    id: "P-9", as_of: "2026-10-02T09:00:00+08:00",
    features: ["MSI-H 结直肠癌", "LAG3_high"]
  });
  assert.equal(after.items[0].decision_active, false);
  assert.ok(after.items[0].warnings.join(";").includes("撤回"));
});

test("治理视图汇总违规、告警、签署台账与影响评估", () => {
  const g = governanceView(lifecycle);
  assert.deepEqual(g.blockers, []);
  assert.equal(g.alerts[0].alert_code, "stale_or_withdrawn_claim_cited");
  const kinds = g.usage_ledger.map((x) => x.kind).sort();
  assert.deepEqual(kinds, ["statement", "use_decision"]);
  assert.equal(g.impact_assessments.length, 3);
  const modelIa = g.impact_assessments.find((i) => i.type === "model_update");
  assert.ok(modelIa.preserved_snapshots.some((s) => s.startsWith("analysis_run:run-A001")));
});
