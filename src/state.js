/**
 * 事件溯源归约：把领域事件流折叠为当前状态，并保留全部历史版本。
 * 校验器在 applyEvent 之前对单条事件做跨事件语义判断；角色视图基于归约后的状态投影。
 */

export function createState() {
  return {
    seq: 0,
    seenEventIds: new Set(),
    aggregateVersions: new Map(), // `${type}|${id}` -> 最新版本号
    consents: new Map(),
    releases: new Map(),
    runs: new Map(),
    pipelines: new Map(),
    subsets: new Map(),
    targets: new Map(),
    mechanisms: new Map(),
    studies: new Map(),
    claims: new Map(),
    rules: new Map(),
    decisions: [],
    statements: [],
    courses: new Map(),
    impacts: [],
    alerts: []
  };
}

const aggKey = (e) => `${e.aggregate_type}|${e.aggregate_id}`;

export function applyEvent(state, e) {
  state.seenEventIds.add(e.event_id);
  state.seq += 1;
  state.aggregateVersions.set(aggKey(e), e.version);
  const p = e.payload ?? {};

  switch (e.event_type) {
    case "CONSENT_GRANTED":
      state.consents.set(e.aggregate_id, { id: e.aggregate_id, status: "granted", ...p, event_id: e.event_id });
      break;
    case "CONSENT_WITHDRAWN": {
      const c = state.consents.get(e.aggregate_id);
      if (c) c.status = "withdrawn";
      state.consents.set(e.aggregate_id, { id: e.aggregate_id, status: "withdrawn", ...c, withdrawal_event_id: e.event_id, ...p });
      break;
    }
    case "DATA_AUTHORIZED":
      state.releases.set(e.aggregate_id, { id: e.aggregate_id, ...p });
      break;
    case "ANALYSIS_FROZEN":
      state.runs.set(e.aggregate_id, { id: e.aggregate_id, ...p });
      break;
    case "MODEL_UPDATED": {
      const list = state.pipelines.get(e.aggregate_id) ?? [];
      list.push({ pipeline_id: e.aggregate_id, ...p, event_id: e.event_id, at: e.occurred_at });
      state.pipelines.set(e.aggregate_id, list);
      break;
    }
    case "CELL_SUBSET_REGISTERED":
      state.subsets.set(e.aggregate_id, { id: e.aggregate_id, ...p });
      break;
    case "TARGET_NOMINATED":
      state.targets.set(e.aggregate_id, { id: e.aggregate_id, ...p });
      break;
    case "MECHANISM_ASSAYED":
      state.mechanisms.set(e.aggregate_id, { id: e.aggregate_id, ...p });
      break;
    case "CLINICAL_STUDY_RECORDED":
      state.studies.set(e.aggregate_id, { id: e.aggregate_id, ...p });
      break;
    case "CLAIM_PROPOSED": {
      state.claims.set(e.aggregate_id, {
        id: e.aggregate_id,
        status: "active",
        level: p.maturity_level,
        strength: p.inference_strength,
        currentVersion: 1,
        versions: new Map([[1, snapshotFromProposal(e)]]),
        supporting: [],
        timeline: [{ at: e.occurred_at, type: "CLAIM_PROPOSED", version: 1 }]
      });
      break;
    }
    case "EVIDENCE_PROMOTED": {
      const c = state.claims.get(e.aggregate_id);
      if (c) {
        c.level = p.to_level;
        // 晋升在当前版本快照上记录，不产生新版本号（不是注释修订）
        const snap = c.versions.get(c.currentVersion);
        snap.maturity_level = p.to_level;
        // 累计晋升所依据的证据（机制实验/临床研究），供视图展示完整证据基础
        c.supporting.push(...(p.supporting_refs ?? []));
        if (p.new_inference_strength) {
          c.strength = p.new_inference_strength;
          snap.inference_strength = p.new_inference_strength;
        }
        if (p.to_level === "M4" && !snap.intended_uses.includes("clinical")) {
          snap.intended_uses = [...snap.intended_uses, "clinical"];
        }
        c.timeline.push({ at: e.occurred_at, type: "EVIDENCE_PROMOTED", from: p.from_level, to: p.to_level });
      }
      break;
    }
    case "ANNOTATION_REVISED": {
      const c = state.claims.get(e.aggregate_id);
      if (c) {
        const base = c.versions.get(p.revision_of_version);
        c.versions.set(p.new_version, { ...base, annotation_note: p.changes, revised_by: p.editor, preserved_snapshot_ref: p.preserved_snapshot_ref });
        c.currentVersion = p.new_version;
        c.timeline.push({ at: e.occurred_at, type: "ANNOTATION_REVISED", version: p.new_version });
      }
      break;
    }
    case "CLAIM_WITHDRAWN": {
      const c = state.claims.get(e.aggregate_id);
      if (c) {
        c.status = "withdrawn";
        c.withdrawal_event_id = e.event_id;
        c.timeline.push({ at: e.occurred_at, type: "CLAIM_WITHDRAWN", reason: p.reason });
      }
      break;
    }
    case "STRATIFICATION_RULE_PUBLISHED":
      state.rules.set(e.aggregate_id, { id: e.aggregate_id, ...p });
      break;
    case "USE_APPROVED":
      state.decisions.push({ id: e.aggregate_id, at: e.occurred_at, ...p });
      break;
    case "STATEMENT_PUBLISHED":
      state.statements.push({ id: e.aggregate_id, at: e.occurred_at, ...p });
      break;
    case "COURSE_PUBLISHED":
      state.courses.set(e.aggregate_id, { id: e.aggregate_id, status: "active", ...p });
      break;
    case "COURSE_SUPERSEDED": {
      const c = state.courses.get(p.course_id ?? e.aggregate_id);
      if (c) c.status = "superseded";
      break;
    }
    case "IMPACT_ASSESSED":
      state.impacts.push({ id: e.aggregate_id, at: e.occurred_at, ...p });
      break;
    case "GOVERNANCE_ALERT_RAISED":
      state.alerts.push({ id: e.aggregate_id, at: e.occurred_at, ...p });
      break;
    default:
      break;
  }
  return state;
}

function snapshotFromProposal(e) {
  const p = e.payload;
  return {
    statement: p.statement,
    claim_category: p.claim_category,
    inference_strength: p.inference_strength,
    maturity_level: p.maturity_level,
    provenance: p.provenance,
    intended_uses: p.intended_uses,
    applicability: p.applicability ?? null,
    asserted_by: p.asserted_by ?? null,
    unknowns: p.unknowns,
    proposed_event_id: e.event_id
  };
}

export function replay(events) {
  const state = createState();
  for (const e of events) applyEvent(state, e);
  return state;
}

/** 按时间点归约：只应用 occurred_at <= asOf（ISO 时间）的事件，用于“当时所见”投影。 */
export function replayUntil(events, asOf) {
  const cutoff = Date.parse(asOf);
  const state = createState();
  for (const e of events) {
    if (Date.parse(e.occurred_at) <= cutoff) applyEvent(state, e);
  }
  return state;
}

/** 沿来源链闭包解析主张触及的组学发布（穿透 分析流程→细胞亚群→靶点→机制实验）。 */
export function provenanceClosure(state, claim) {
  const releaseIds = new Set();
  const runIds = new Set();
  const stack = claim.versions.get(claim.currentVersion).provenance.map((r) => ({ ...r }));
  const seen = new Set();
  while (stack.length) {
    const ref = stack.pop();
    const key = `${ref.kind}|${ref.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (ref.kind === "omics_release") releaseIds.add(ref.id);
    if (ref.kind === "analysis_run") {
      runIds.add(ref.id);
      const run = state.runs.get(ref.id);
      run?.input_release_ids.forEach((r) => releaseIds.add(r));
    }
    const subset = ref.kind === "cell_subset" ? state.subsets.get(ref.id) : null;
    if (subset) {
      runIds.add(subset.analysis_run_id);
      state.runs.get(subset.analysis_run_id)?.input_release_ids.forEach((r) => releaseIds.add(r));
    }
    const target = ref.kind === "candidate_target" ? state.targets.get(ref.id) : null;
    if (target) target.subset_ids.forEach((id) => stack.push({ kind: "cell_subset", id, version: null }));
    const mech = ref.kind === "mechanism_experiment" ? state.mechanisms.get(ref.id) : null;
    if (mech) stack.push({ kind: "candidate_target", id: mech.target_id, version: null });
  }
  return { releaseIds, runIds };
}
