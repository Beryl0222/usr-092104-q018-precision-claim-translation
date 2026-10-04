import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildProjection,
  clinicianView,
  educatorView,
  governanceView,
  researcherView,
} from "../src/views.js";

const samplePath = new URL("../data/lineage-sample.json", import.meta.url);

async function loadSample() {
  return JSON.parse(await readFile(samplePath, "utf8"));
}

test("研究者视图给出完整复现包，含新旧两个冻结 run", async () => {
  const view = researcherView(await loadSample());
  const pkg = view.claims.find((c) => c.claim_id === "claim-e018");
  assert.equal(pkg.maturity, "ACTIONABLE");
  assert.equal(pkg.reproducible, true);
  const types = pkg.lineage.map((l) => l.type);
  for (const type of [
    "target_candidate",
    "cell_subset",
    "analysis_run",
    "mechanism_experiment",
    "clinical_study",
    "stratification_rule",
    "omics_release",
    "consent_grant",
  ]) {
    assert.ok(types.includes(type), `血缘缺少 ${type}`);
  }
  const versions = pkg.analysis_runs.map((r) => r.model_version).sort();
  assert.deepEqual(versions, ["celltypist:hv2024.1", "celltypist:hv2026.2"]);
  // 模型更新与注释修订在重新评审前提示为陈旧。
  assert.equal(pkg.stale_notices.length, 2);
});

test("教师视图只给获准的去标识案例，并永久保留发表版本", async () => {
  const view = educatorView(await loadSample());
  assert.equal(view.cases.length, 1);
  const c = view.cases[0];
  assert.equal(c.course_id, "COURSE-ONC-101");
  assert.equal(c.pinned_version, 5);
  assert.equal(c.current_version, 5);
  assert.equal(c.version_preserved, true);
  assert.equal(c.stale_notices.length, 2);
});

test("临床视图展示与当前患者相关的证据范围、分层规则与未知项", async () => {
  const matching = clinicianView(await loadSample(), { population: "晚期实体瘤" });
  assert.equal(matching.evidence.length, 1);
  const e = matching.evidence[0];
  assert.equal(e.maturity, "ACTIONABLE");
  assert.equal(e.relevant_to_patient, true);
  assert.ok(e.applicable_population.includes("LAG3"));
  assert.equal(e.signer.role, "licensed_physician");
  assert.deepEqual(e.stratification_rules, [{ id: "rule-r018", version: 1 }]);
  assert.ok(e.unknowns.some((u) => u.includes("总体生存")));
  assert.ok(e.unknowns.some((u) => u.includes("重新评估")));
  assert.match(e.note, /不构成治疗方案/);

  const unrelated = clinicianView(await loadSample(), { population: "HER2 低表达乳腺癌" });
  assert.equal(unrelated.evidence[0].relevant_to_patient, false);
});

test("撤回数据后：研究标记阻断、教学过滤、临床过滤、治理出严重告警", async () => {
  const events = await loadSample();
  events.push({
    event_id: "evt-late-withdraw",
    event_type: "DATA_WITHDRAWN",
    aggregate_type: "omics_release",
    aggregate_id: "omics-o018",
    occurred_at: "2026-10-04T15:00:00+08:00",
    version: 2,
    summary: "捐献者撤回数据",
    payload: {
      reason: "捐献者撤回授权",
      affected_claim_ids: ["claim-e018"],
      affected_course_ids: ["COURSE-ONC-101"],
    },
  });

  const research = researcherView(events);
  assert.equal(research.claims[0].reproducible, false);
  assert.match(research.claims[0].blocked_reasons.join(";"), /撤回/);

  assert.equal(educatorView(events).cases.length, 0);
  assert.equal(clinicianView(events, { population: "晚期实体瘤" }).evidence.length, 0);

  const gov = governanceView(events);
  assert.ok(gov.alerts.some((a) => a.code === "WITHDRAWN_IN_USE" && a.severity === "critical"));
  assert.ok(gov.alerts.some((a) => a.code === "AFFECTED_PUBLICATION" && a.course_id === "COURSE-ONC-101"));
});

test("治理视图在事件流违规时报告校验错误与越界用途", async () => {
  const events = await loadSample();
  const bad = JSON.parse(JSON.stringify(events));
  bad[14].payload.signer = { staff_id: "x", role: "researcher" };
  bad[14].payload.applicable_population = "某人群";
  const gov = governanceView(bad);
  assert.equal(gov.valid, false);
  assert.ok(gov.validation_errors.some((e) => /无权签署 clinical/.test(e.message)));
});

test("模型更新与注释修订的影响面进入投影，供课程核查", async () => {
  const projection = buildProjection(await loadSample());
  const notices = projection.notices.get("claim-e018");
  assert.deepEqual(notices.map((n) => n.kind), ["model_update", "reannotation"]);
  assert.ok(notices.every((n) => n.courseIds.includes("COURSE-ONC-101")));
});
