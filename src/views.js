/**
 * 角色视图：同一事件真相源，按用途边界向四类使用者投影不同内容。
 * 投影不新增或改写任何主张，只做可见性裁剪与上下文装配。
 *  - researcher：完整来源链与版本，可复现结论。
 *  - teacher：仅获准的去标识案例与教学用途主张，看不到可识别信息。
 *  - clinician：与当前患者特征匹配的 M4 证据范围、分层规则、未知项与有效期。
 *  - governance：全部告警、越界事件与签署台账。
 */

import { replay, replayUntil } from "./state.js";
import { validateStream } from "./validator.js";

const strengthLabel = {
  statistical_association: "统计相关（非因果）",
  mechanistically_supported: "机制支持",
  causal: "因果"
};

/* ------------------------------ 研究者 ------------------------------ */

export function researcherView(events, { claimId } = {}) {
  const s = replay(events);
  const ids = claimId ? [claimId] : [...s.claims.keys()];
  return ids.map((id) => {
    const c = s.claims.get(id);
    if (!c) return { id, found: false };
    const snap = c.versions.get(c.currentVersion);
    return {
      claim_id: c.id,
      status: c.status,
      current_version: c.currentVersion,
      maturity: c.level,
      inference: strengthLabel[snap.inference_strength],
      statement: snap.statement,
      timeline: c.timeline,
      versions: [...c.versions.entries()].map(([v, d]) => ({
        version: v,
        maturity_level: d.maturity_level,
        statement: d.statement,
        preserved_snapshot_ref: d.preserved_snapshot_ref ?? null
      })),
      provenance: [...snap.provenance, ...dedupRefs(c.supporting)].map((r) => resolveProvenance(s, r)),
      reproducibility: reproducibilityPacket(s, c),
      impacts: s.impacts.filter((ia) => ia.affected?.some((a) => a.kind === "claim" && a.id === id))
    };
  });
}

function dedupRefs(refs) {
  const seen = new Set();
  return refs.filter((r) => {
    const k = `${r.kind}|${r.id}|${r.version ?? "*"}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function resolveProvenance(s, ref) {
  const registries = {
    omics_release: s.releases,
    analysis_run: s.runs,
    cell_subset: s.subsets,
    candidate_target: s.targets,
    mechanism_experiment: s.mechanisms,
    clinical_study: s.studies
  };
  const record = registries[ref.kind]?.get(ref.id) ?? null;
  return { kind: ref.kind, id: ref.id, pinned_version: ref.version ?? null, record };
}

function reproducibilityPacket(s, claim) {
  const packet = { pipeline_versions: [], input_releases: [], rerun_warnings: [] };
  for (const ref of claim.versions.get(claim.currentVersion).provenance) {
    let runId = null;
    if (ref.kind === "analysis_run") runId = ref.id;
    if (ref.kind === "cell_subset") runId = s.subsets.get(ref.id)?.analysis_run_id;
    if (ref.kind === "candidate_target") {
      for (const sid of s.targets.get(ref.id)?.subset_ids ?? []) runId = s.subsets.get(sid)?.analysis_run_id;
    }
    if (!runId || !s.runs.has(runId)) continue;
    const run = s.runs.get(runId);
    packet.pipeline_versions.push({ run_id: runId, pipeline_id: run.pipeline_id, pipeline_version: run.pipeline_version, analysis_version: run.analysis_version });
    packet.input_releases.push(...run.input_release_ids);
    for (const [, updates] of s.pipelines) {
      for (const u of updates) {
        if (u.replaces_run_ids.includes(runId)) {
          packet.rerun_warnings.push({ run_id: runId, superseded_by_pipeline: u.to_version, update_event_id: u.event_id });
        }
      }
    }
  }
  packet.input_releases = [...new Set(packet.input_releases)];
  packet.pipeline_versions = dedupRefs(packet.pipeline_versions.map((v) => ({
    kind: "analysis_run",
    id: v.run_id,
    version: v.analysis_version,
    detail: v
  }))).map((v) => v.detail);
  packet.rerun_warnings = dedupRefs(packet.rerun_warnings.map((w) => ({
    kind: "analysis_run",
    id: w.run_id,
    version: null,
    detail: w
  }))).map((w) => w.detail);
  return packet;
}

/* ------------------------------- 教师 ------------------------------- */

const IDENTIFIABLE_KEYS = ["subject_ref", "consent_id", "dataset_ref"];

export function teacherView(events, { courseId } = {}) {
  const s = replay(events);
  const courses = [...s.courses.values()].filter((c) => !courseId || c.id === courseId);
  return courses.map((course) => ({
    course_id: course.id,
    title: course.title,
    status: course.status,
    access: course.access,
    notice: "仅教学用途：内容为去标识案例，不构成任何治疗建议",
    deidentified_cases: course.deidentified_case_ids,
    items: course.refs.map((ref) => {
      const c = s.claims.get(ref.claim_id);
      const snap = c?.versions.get(ref.claim_version) ?? null;
      return {
        claim_id: ref.claim_id,
        pinned_version: ref.claim_version,
        statement: snap?.statement ?? null,
        claim_category: snap?.claim_category ?? null,
        maturity_level: snap?.maturity_level ?? null,
        inference: snap ? strengthLabel[snap.inference_strength] : null,
        unknowns: snap?.unknowns ?? [],
        current_status: c?.status ?? "missing",
        superseded_version: c && c.currentVersion !== ref.claim_version ? c.currentVersion : null
      };
    })
  }));
}

/** 治理/审计用途：证明教师投影中不含可识别字段。 */
export function assertNoIdentifiableData(projection) {
  const text = JSON.stringify(projection);
  return IDENTIFIABLE_KEYS.filter((k) => text.includes(k));
}

/* ------------------------------- 临床 ------------------------------- */

export function clinicianView(events, patient = { features: [] }) {
  const s = patient.as_of ? replayUntil(events, patient.as_of) : replay(events);
  const features = new Set(patient.features ?? []);
  const now = patient.as_of ? Date.parse(patient.as_of) : Infinity;

  const visible = [];
  for (const d of s.decisions) {
    if (d.use !== "clinical" || d.decision !== "approved") continue;
    const c = s.claims.get(d.claim_id);
    const snap = c?.versions.get(d.claim_version);
    if (!snap) continue;
    const rule = s.rules.get(d.stratification_rule_id ?? "") ?? null;

    const inclusion = rule?.inclusion ?? snap.applicability?.inclusion ?? [];
    const exclusion = rule?.exclusion ?? snap.applicability?.exclusion ?? [];
    const matchesInclusion = inclusion.every((f) => features.has(f));
    const matchesExclusion = exclusion.filter((f) => features.has(f));

    visible.push({
      patient_ref: patient.id ?? "current-patient",
      claim_id: c.id,
      claim_version: d.claim_version,
      statement: snap.statement,
      maturity_level: snap.maturity_level,
      inference: strengthLabel[snap.inference_strength],
      applicability: { inclusion, exclusion },
      patient_match: {
        applies: matchesInclusion && matchesExclusion.length === 0,
        missing_inclusion_features: inclusion.filter((f) => !features.has(f)),
        hit_exclusion_features: matchesExclusion
      },
      stratification_rule: rule ? { rule_id: rule.id, logic: rule.rule_logic } : null,
      evidence_known: provenanceBrief(s, snap, c.supporting),
      unknowns: snap.unknowns,
      signer: d.signer,
      scope_population: d.scope_population ?? null,
      valid_until: d.valid_until ?? null,
      decision_active: (!d.valid_until || Date.parse(d.valid_until) >= now) && c.status === "active",
      warnings: buildClinicalWarnings(c, d, now)
    });
  }

  return {
    patient_ref: patient.id ?? "current-patient",
    evaluated_at: patient.as_of ?? null,
    evidence_count: visible.length,
    items: visible,
    notice: "以下为证据范围与未知项，不自动生成治疗方案；治疗判断须由合格临床医师在适用人群内签署"
  };
}

function provenanceBrief(s, snap, supporting = []) {
  const counts = { omics_release: 0, analysis_run: 0, cell_subset: 0, candidate_target: 0, mechanism_experiment: 0, clinical_study: 0 };
  const studies = [];
  for (const r of dedupRefs([...snap.provenance, ...supporting])) {
    counts[r.kind] += 1;
    if (r.kind === "clinical_study") {
      const st = s.studies.get(r.id);
      if (st) studies.push({ study_ref: st.study_ref, design: st.design, result: st.result });
    }
  }
  return { counts, studies };
}

function buildClinicalWarnings(claim, decision, now) {
  const w = [];
  if (claim.status === "withdrawn") w.push("主张已撤回，该决定不得继续使用");
  if (decision.valid_until && Date.parse(decision.valid_until) < now) w.push("签署已过有效期");
  return w;
}

/* ------------------------------- 治理 ------------------------------- */

export function governanceView(events) {
  const s = replay(events);
  const violations = validateStream(events);
  return {
    blockers: violations.filter((v) => v.code !== "schema_violation"),
    schema_errors: violations.filter((v) => v.code === "schema_violation"),
    alerts: s.alerts,
    usage_ledger: [
      ...s.statements.map((st) => ({
        kind: "statement", id: st.id, channel: st.channel, use_context: st.use_context,
        claim: `${st.claim_id}@v${st.claim_version}`,
        claim_status: s.claims.get(st.claim_id)?.status ?? "missing"
      })),
      ...s.decisions.map((d) => ({
        kind: "use_decision", id: d.id, use_context: d.use, decision: d.decision,
        claim: `${d.claim_id}@v${d.claim_version}`, signer_role: d.signer?.role ?? null,
        claim_status: s.claims.get(d.claim_id)?.status ?? "missing"
      }))
    ],
    impact_assessments: s.impacts.map((ia) => ({
      id: ia.id, trigger: ia.trigger_event_id, type: ia.trigger_type,
      affected_count: ia.affected.length, actions_required: ia.actions_required,
      preserved_snapshots: ia.preserved_snapshots.map((k) => `${k.of}:${k.id}@v${k.version}`)
    }))
  };
}

export function projectFor(role, events, context = {}) {
  switch (role) {
    case "researcher": return researcherView(events, context);
    case "teacher": return teacherView(events, context);
    case "clinician": return clinicianView(events, context.patient ?? { features: [] });
    case "governance": return governanceView(events);
    default:
      throw new Error(`未知角色：${role}`);
  }
}
