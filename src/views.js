import { validateEventStream } from "./validator.js";

/**
 * 角色视图投影：把事件流折叠为当前状态，并按角色裁剪可见范围。
 * 所有视图都假设事件流已通过 validateEventStream；投影本身不重新拒绝事件，
 * 但会暴露 stale / blocked 标记，供治理视图告警。
 */

function lineageOf(claimId, edges, aggregates) {
  const seen = new Set();
  const queue = [claimId];
  while (queue.length > 0) {
    const id = queue.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const target of edges.get(id) ?? []) {
      if (!seen.has(target)) queue.push(target);
    }
  }
  return [...seen].map((id) => aggregates.get(id)).filter(Boolean);
}

/** 折叠事件流为当前状态与影响传播记录。 */
export function buildProjection(events) {
  const aggregates = new Map();
  const edges = new Map();
  const addEdge = (from, to) => {
    if (!edges.has(from)) edges.set(from, new Set());
    edges.get(from).add(to);
  };

  const claims = new Map();
  const runs = new Map();
  const decisions = new Map();
  const statements = new Map();
  /** claimId -> [{kind, index, detail, courseIds}] */
  const notices = new Map();
  const addNotice = (claimId, notice) => {
    if (!notices.has(claimId)) notices.set(claimId, []);
    notices.get(claimId).push(notice);
  };

  events.forEach((event, index) => {
    const payload = event.payload ?? {};
    if (!aggregates.has(event.aggregate_id)) {
      aggregates.set(event.aggregate_id, { id: event.aggregate_id, type: event.aggregate_type, version: event.version });
    }
    aggregates.get(event.aggregate_id).version = event.version;

    for (const link of payload.links ?? []) {
      if (link?.id) addEdge(event.aggregate_id, link.id);
    }

    switch (event.event_type) {
      case "ANALYSIS_FROZEN":
        runs.set(event.aggregate_id, {
          id: event.aggregate_id,
          pipeline: payload.pipeline,
          model_version: payload.model_version,
          frozen_at: event.occurred_at,
        });
        break;
      case "MODEL_VERSIONED": {
        // 新 run 在模型更新事件中诞生，并链接被取代的旧 run。
        const predecessor = (payload.links ?? []).find((l) => l.type === "analysis_run");
        runs.set(event.aggregate_id, {
          id: event.aggregate_id,
          model_version: payload.new_model_version,
          supersedes: predecessor?.id,
          frozen_at: event.occurred_at,
        });
        for (const claimId of payload.affected_claim_ids ?? []) {
          addNotice(claimId, {
            kind: "model_update",
            index,
            detail: `模型 ${payload.previous_model_version} → ${payload.new_model_version}`,
            courseIds: payload.affected_course_ids ?? [],
          });
        }
        break;
      }
      case "CELL_SUBSET_REANNOTATED": {
        for (const claimId of payload.affected_claim_ids ?? []) {
          addNotice(claimId, {
            kind: "reannotation",
            index,
            detail: `亚群 ${event.aggregate_id} 注释修订至 v${event.version}`,
            courseIds: payload.affected_course_ids ?? [],
          });
        }
        break;
      }
      case "DATA_WITHDRAWN":
      case "CONSENT_WITHDRAWN": {
        for (const claimId of payload.affected_claim_ids ?? []) {
          addNotice(claimId, {
            kind: "data_withdrawn",
            index,
            detail: payload.reason,
            courseIds: payload.affected_course_ids ?? [],
          });
        }
        break;
      }
      case "CLAIM_PROPOSED":
        claims.set(event.aggregate_id, {
          id: event.aggregate_id,
          version: event.version,
          maturity: payload.maturity,
          statement: payload.statement,
          open_questions: payload.open_questions ?? [],
          proposed_at: event.occurred_at,
          last_review_index: index,
          withdrawn: false,
        });
        break;
      case "CLAIM_PROMOTED":
      case "EVIDENCE_PROMOTED": {
        const claim = claims.get(event.aggregate_id);
        if (claim) {
          claim.maturity = payload.promoted_to;
          claim.version = event.version;
          claim.last_review_index = index;
          if (typeof payload.statement === "string") claim.statement = payload.statement;
          if (Array.isArray(payload.open_questions)) claim.open_questions = payload.open_questions;
        }
        break;
      }
      case "CLAIM_WITHDRAWN": {
        const claim = claims.get(event.aggregate_id);
        if (claim) {
          claim.withdrawn = true;
          claim.withdrawn_reason = payload.reason;
        }
        for (const claimId of payload.affected_claim_ids ?? []) {
          addNotice(claimId, {
            kind: "claim_withdrawn",
            index,
            detail: payload.reason,
            courseIds: payload.affected_course_ids ?? [],
          });
        }
        break;
      }
      case "USE_APPROVED":
        decisions.set(event.aggregate_id, {
          id: event.aggregate_id,
          use: payload.intended_use,
          signer: payload.signer,
          applicable_population: payload.applicable_population,
          claim_id: payload.claim_ref?.id,
          claim_version: payload.claim_ref?.version,
          index,
        });
        break;
      case "STATEMENT_PUBLISHED":
        statements.set(event.aggregate_id, {
          id: event.aggregate_id,
          course_id: payload.course_id,
          title: payload.title,
          use: payload.statement_use,
          claim_id: payload.claim_id,
          claim_version: payload.claim_version,
          signed_claim_version: payload.signed_claim_version,
          de_identified: payload.de_identified,
          published_at: event.occurred_at,
          index,
          retracted: false,
        });
        break;
      case "STATEMENT_RETRACTED": {
        const statement = statements.get(event.aggregate_id);
        if (statement) {
          statement.retracted = true;
          statement.retracted_reason = payload.reason;
        }
        break;
      }
      default:
        break;
    }
  });

  return { events, aggregates, edges, claims, runs, decisions, statements, notices };
}

/** 影响标记：撤回类阻断使用；更新/修订类在主张重新评审后转为陈旧提示。 */
function impactState(claim, projection) {
  const list = projection.notices.get(claim.id) ?? [];
  const blocking = list.filter(
    (n) => (n.kind === "data_withdrawn" || n.kind === "claim_withdrawn") && n.index > (claim.last_review_index ?? -1),
  );
  const stale = list.filter((n) => n.index > (claim.last_review_index ?? -1) && n.kind !== "claim_withdrawn");
  return {
    blocked: claim.withdrawn || blocking.length > 0,
    blocking_reasons: claim.withdrawn ? [claim.withdrawn_reason ?? "主张已撤回"] : blocking.map((n) => n.detail),
    stale: stale.map((n) => n.detail),
  };
}

/**
 * 研究者视图：主张的完整复现包——冻结流程、模型版本、血缘各对象及其锚定版本。
 * 数据/同意撤回的条目标记为 blocked（不得继续使用），但历史版本仍可见。
 */
export function researcherView(events) {
  const projection = buildProjection(events);
  const packages = [];
  for (const claim of projection.claims.values()) {
    const lineage = lineageOf(claim.id, projection.edges, projection.aggregates);
    const impact = impactState(claim, projection);
    packages.push({
      claim_id: claim.id,
      version: claim.version,
      maturity: claim.maturity,
      statement: claim.statement,
      reproducible: !impact.blocked,
      blocked_reasons: impact.blocking_reasons,
      stale_notices: impact.stale,
      lineage: lineage
        .filter((node) => node.id !== claim.id)
        .map((node) => ({ type: node.type, id: node.id, version: node.version })),
      analysis_runs: lineage
        .filter((node) => node.type === "analysis_run")
        .map((node) => projection.runs.get(node.id))
        .filter(Boolean),
    });
  }
  return { role: "researcher", claims: packages };
}

/**
 * 教师视图：仅含有效教育/临床签署、已去标识、未撤回且未阻断的案例。
 * 撤回与阻断条目直接过滤；锚定版本与当前版本不一致时给出陈旧提示，不替换内容。
 */
export function educatorView(events) {
  const projection = buildProjection(events);
  const cases = [];
  for (const statement of projection.statements.values()) {
    if (statement.retracted) continue;
    if (statement.use !== "education" && statement.use !== "clinical") continue;
    if (!statement.de_identified) continue;
    const claim = projection.claims.get(statement.claim_id);
    if (!claim || claim.withdrawn) continue;
    const impact = impactState(claim, projection);
    if (impact.blocked) continue;
    cases.push({
      course_id: statement.course_id,
      title: statement.title,
      claim_id: claim.id,
      pinned_version: statement.claim_version,
      current_version: claim.version,
      version_preserved: true, // 发表时所用版本永久保留
      maturity_at_publication: claim.maturity,
      stale_notices: impact.stale,
    });
  }
  return { role: "educator", cases };
}

/**
 * 临床人员视图：当前患者可参考的证据范围与未知项。
 * 仅展示持照人员/治理委员会临床签署、成熟度 ACTIONABLE、未撤回且血缘未阻断的主张。
 * 传入 patient.population 时标记是否与适用人群相关；不做自动入组判断。
 */
export function clinicianView(events, patient = {}) {
  const projection = buildProjection(events);
  const evidence = [];
  for (const decision of projection.decisions.values()) {
    if (decision.use !== "clinical") continue;
    const claim = projection.claims.get(decision.claim_id);
    if (!claim || claim.withdrawn) continue;
    const impact = impactState(claim, projection);
    if (impact.blocked) continue;
    const lineage = lineageOf(claim.id, projection.edges, projection.aggregates);
    const rules = lineage.filter((node) => node.type === "stratification_rule");
    const studies = lineage.filter((node) => node.type === "clinical_study");

    const unknowns = [...claim.open_questions];
    unknowns.push(...impact.stale.map((detail) => `签署后上游已更新（${detail}），需重新评估`));

    const population = decision.applicable_population ?? "";
    const relevance = patient.population
      ? population.includes(patient.population) || patient.population.includes(population)
      : undefined;

    evidence.push({
      claim_id: claim.id,
      statement: claim.statement,
      maturity: claim.maturity,
      signed_version: decision.claim_version,
      current_version: claim.version,
      is_current: decision.claim_version === claim.version,
      applicable_population: population,
      relevant_to_patient: relevance,
      signer: decision.signer,
      stratification_rules: rules.map((node) => ({ id: node.id, version: node.version })),
      supporting_studies: studies.map((node) => node.id),
      unknowns,
      stale_notices: impact.stale,
      note: "本视图为证据范围，不构成治疗方案；治疗决定由持照人员作出。",
    });
  }
  return { role: "clinician", patient: patient.population ?? null, evidence };
}

/**
 * 治理视图：校验错误 + 影响传播告警（越界、陈旧、撤回未传播等）。
 */
export function governanceView(events) {
  const validation_errors = validateEventStream(events);
  const projection = buildProjection(events);
  const alerts = [];

  for (const claim of projection.claims.values()) {
    const impact = impactState(claim, projection);
    for (const reason of impact.blocking_reasons) {
      alerts.push({ severity: "critical", code: "WITHDRAWN_IN_USE", claim_id: claim.id, message: `主张已阻断（${reason}），须核查下游使用` });
    }
    for (const detail of impact.stale) {
      alerts.push({ severity: "warning", code: "STALE_LINEAGE", claim_id: claim.id, message: `主张血缘已更新（${detail}），尚未重新评审` });
    }
  }

  for (const statement of projection.statements.values()) {
    if (statement.retracted) continue;
    const claim = projection.claims.get(statement.claim_id);
    if (claim?.withdrawn) {
      alerts.push({
        severity: "critical",
        code: "PUBLISHED_AFTER_WITHDRAWAL",
        course_id: statement.course_id,
        claim_id: claim.id,
        message: `课程 ${statement.course_id} 仍在使用已撤回主张`,
      });
    }
    const notices = (projection.notices.get(statement.claim_id) ?? []).filter((n) =>
      (n.courseIds ?? []).includes(statement.course_id),
    );
    for (const notice of notices) {
      alerts.push({
        severity: notice.kind === "data_withdrawn" ? "critical" : "warning",
        code: "AFFECTED_PUBLICATION",
        course_id: statement.course_id,
        claim_id: statement.claim_id,
        message: `课程 ${statement.course_id} 受上游事件影响：${notice.detail}`,
      });
    }
  }

  for (const decision of projection.decisions.values()) {
    const claim = projection.claims.get(decision.claim_id);
    if (claim && decision.claim_version !== claim.version) {
      alerts.push({
        severity: "warning",
        code: "SIGNED_VERSION_STALE",
        use_decision_id: decision.id,
        claim_id: claim.id,
        message: `${decision.use} 签署锚定 v${decision.claim_version}，主张当前 v${claim.version}`,
      });
    }
  }

  return {
    role: "governance",
    valid: validation_errors.length === 0,
    validation_errors,
    alerts,
  };
}

export const views = { researcherView, educatorView, clinicianView, governanceView };
