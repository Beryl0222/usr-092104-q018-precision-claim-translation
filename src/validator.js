import {
  AGGREGATES,
  CAUSAL_TERMS,
  EFFICACY_TERMS,
  EVENT_RULES,
  FORBIDDEN_CLAIM_FIELDS,
  MATURITY_LEVELS,
  MATURITY_LINK_REQUIREMENTS,
  MATURITY_ORDER,
  MECHANISM_FINDINGS,
  SIGNER_ROLES,
  USE_RANK,
  USES,
} from "./constants.js";

const EVENT_TYPES = Object.keys(EVENT_RULES);
const AGGREGATE_TYPES = new Set(Object.values(AGGREGATES));
const USE_VALUES = new Set(Object.values(USES));

function isNonEmpty(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number" || typeof value === "boolean") return true;
  return value !== null && typeof value === "object";
}

/** 按成熟度检查主张措辞：统计相关不得写成因果，疗效断言需临床证据。 */
export function checkWording(statement, maturity) {
  const errors = [];
  if (typeof statement !== "string" || statement.length === 0) return errors;
  const text = statement.toLowerCase();
  const level = MATURITY_LEVELS[maturity];
  if (level < MATURITY_LEVELS.MECHANISTIC_SUPPORT) {
    const hit = CAUSAL_TERMS.find((term) => text.includes(term.toLowerCase()));
    if (hit) errors.push(`成熟度 ${maturity} 仅为统计关联，措辞不得含因果表述：“${hit}”`);
  }
  if (level < MATURITY_LEVELS.CLINICAL_EVIDENCE) {
    const hit = EFFICACY_TERMS.find((term) => text.includes(term.toLowerCase()));
    if (hit) errors.push(`成熟度 ${maturity} 尚无临床证据，措辞不得作疗效断言：“${hit}”`);
  }
  return errors;
}

/**
 * 单条事件校验：信封、事件-聚合归属、payload 必需字段与枚举报错。
 * 不依赖流中其他事件；跨事件不变量用 validateEventStream。
 * @returns {string[]} 错误信息数组，空数组表示通过。
 */
export function validateEvent(record) {
  const errors = [];
  if (record === null || typeof record !== "object") return ["事件必须是对象"];

  for (const name of [
    "event_id",
    "event_type",
    "aggregate_type",
    "aggregate_id",
    "occurred_at",
    "version",
    "summary",
  ]) {
    if (!(name in record)) errors.push(`缺少字段：${name}`);
  }
  if ("version" in record && (!Number.isInteger(record.version) || record.version < 1)) {
    errors.push("version 必须是正整数");
  }

  const rule = EVENT_RULES[record.event_type];
  if (!rule) {
    errors.push(`未知事件类型：${record.event_type}`);
    return errors;
  }
  if (!AGGREGATE_TYPES.has(record.aggregate_type)) {
    errors.push(`未知聚合类型：${record.aggregate_type}`);
  } else if (record.aggregate_type !== rule.aggregate) {
    errors.push(`事件 ${record.event_type} 必须归属聚合 ${rule.aggregate}，实际为 ${record.aggregate_type}`);
  }

  const payload = record.payload ?? {};
  if (record.payload !== undefined && (typeof record.payload !== "object" || Array.isArray(record.payload))) {
    errors.push("payload 必须是对象");
    return errors;
  }

  for (const field of rule.require) {
    if (!isNonEmpty(payload[field])) errors.push(`payload 缺少必需字段：${field}`);
  }
  for (const field of rule.links) {
    const link = (payload.links ?? []).find((item) => item && item.type === field);
    if (!link) errors.push(`payload.links 缺少指向 ${field} 的血缘引用`);
  }

  if (Array.isArray(payload.links)) {
    for (const link of payload.links) {
      if (!link || typeof link !== "object" || !isNonEmpty(link.type) || !isNonEmpty(link.id)) {
        errors.push("血缘链接必须含非空 type 与 id");
        continue;
      }
      if (!AGGREGATE_TYPES.has(link.type)) errors.push(`血缘链接指向未知聚合类型：${link.type}`);
      if (link.version !== undefined && (!Number.isInteger(link.version) || link.version < 1)) {
        errors.push(`血缘链接 ${link.type}/${link.id} 的 version 必须是正整数`);
      }
    }
  }

  if (record.event_type === "CONSENT_GRANTED") {
    if (!Array.isArray(payload.allowed_uses) || payload.allowed_uses.some((use) => !USE_VALUES.has(use))) {
      errors.push("allowed_uses 必须是 research/education/clinical 的非空数组");
    }
  }

  if (record.event_type === "MECHANISM_TESTED" && !MECHANISM_FINDINGS.includes(payload.finding)) {
    errors.push(`机制实验 finding 必须是 ${MECHANISM_FINDINGS.join("/")}`);
  }

  const claimEvent =
    record.event_type === "CLAIM_PROPOSED" ||
    record.event_type === "CLAIM_PROMOTED" ||
    record.event_type === "EVIDENCE_PROMOTED";
  if (claimEvent) {
    for (const field of FORBIDDEN_CLAIM_FIELDS) {
      if (field in payload) errors.push(`科研主张不得携带治疗安排字段：${field}`);
    }
    const maturity =
      record.event_type === "CLAIM_PROPOSED" ? payload.maturity : payload.promoted_to;
    if (maturity !== undefined && !(maturity in MATURITY_LEVELS)) {
      errors.push(`未知成熟度：${maturity}`);
    }
    if (record.event_type === "CLAIM_PROMOTED" || record.event_type === "EVIDENCE_PROMOTED") {
      if (payload.promoted_from !== undefined && !(payload.promoted_from in MATURITY_LEVELS)) {
        errors.push(`未知成熟度：${payload.promoted_from}`);
      }
      const from = MATURITY_LEVELS[payload.promoted_from];
      const to = MATURITY_LEVELS[payload.promoted_to];
      if (from !== undefined && to !== undefined && to !== from + 1) {
        errors.push(`成熟度只能逐级晋升：${payload.promoted_from} → ${payload.promoted_to}`);
      }
    }
    if (typeof payload.statement === "string") {
      errors.push(...checkWording(payload.statement, maturity));
    }
  }

  if (record.event_type === "USE_APPROVED") {
    if (!USE_VALUES.has(payload.intended_use)) errors.push("intended_use 必须是 research/education/clinical");
    if (payload.signer && !SIGNER_ROLES[payload.intended_use]?.includes(payload.signer.role)) {
      errors.push(
        `签署人角色 ${payload.signer?.role} 无权签署 ${payload.intended_use} 用途 ` +
          `（允许：${(SIGNER_ROLES[payload.intended_use] ?? []).join("/")}）`,
      );
    }
    if (payload.intended_use === USES.CLINICAL && !isNonEmpty(payload.applicable_population)) {
      errors.push("临床用途签署必须限定 applicable_population");
    }
    if (payload.claim_ref && (!isNonEmpty(payload.claim_ref.type) || !isNonEmpty(payload.claim_ref.id))) {
      errors.push("claim_ref 必须含非空 type 与 id");
    }
    if (payload.claim_ref && payload.claim_ref.version === undefined) {
      errors.push("签署必须锚定主张版本：claim_ref.version 不能为空");
    }
  }

  if (record.event_type === "STATEMENT_PUBLISHED") {
    if (!USE_VALUES.has(payload.statement_use)) {
      errors.push("statement_use 必须是 research/education/clinical");
    }
    if (payload.statement_use !== USES.CLINICAL && payload.de_identified !== true) {
      errors.push("研究/教学对外表述必须使用去标识案例（de_identified=true）");
    }
  }

  return errors;
}

function fail(errors, event, code, message) {
  errors.push({ event_id: event.event_id ?? "(无 event_id)", code, message });
}

/** 血缘闭包：沿各聚合全部事件的 links 反向/正向遍历，返回到达的聚合类型与实例。 */
function closure(startId, edges, aggregates) {
  const seen = new Set();
  const queue = [startId];
  while (queue.length > 0) {
    const id = queue.pop();
    if (seen.has(id) || !aggregates.has(id)) continue;
    seen.add(id);
    for (const target of edges.get(id) ?? []) {
      if (!seen.has(target)) queue.push(target);
    }
  }
  const types = new Set();
  for (const id of seen) {
    const agg = aggregates.get(id);
    if (agg) types.add(agg.type);
  }
  return { ids: seen, types };
}

/** 研究/教学/临床签署所要求的最低成熟度。 */
const MIN_MATURITY_FOR_USE = {
  research: MATURITY_LEVELS.SINGLE_CELL_ASSOCIATION,
  education: MATURITY_LEVELS.MECHANISTIC_SUPPORT,
  clinical: MATURITY_LEVELS.ACTIONABLE,
};

/**
 * 事件流不变量（按数组顺序回放）：
 * 版本连续、冻结不可变、血缘存在、成熟度晋升与证据齐备、同意用途覆盖、
 * 签署资质与人群、主张不夹带治疗方案、对外表述不得越过签署用途、
 * 撤回事件必须声明受影响主张与课程。
 *
 * @returns {{event_id:string, code:string, message:string}[]} 错误数组，空数组表示流可接受。
 */
export function validateEventStream(events) {
  const errors = [];
  if (!Array.isArray(events)) return [{ event_id: "-", code: "NOT_A_STREAM", message: "事件流必须是数组" }];

  const aggregates = new Map(); // id -> {type, version, withdrawn}
  const edges = new Map(); // aggregate id -> Set(target id)
  const seenEventIds = new Set();
  const claims = new Map(); // claim id -> {maturity, statement, links, withdrawn, version}
  const consents = new Map(); // consent id -> {allowed_uses, withdrawn}
  const omics = new Map(); // omics id -> {consentIds, withdrawn}
  const decisions = new Map(); // use_decision id -> {use, claimId, claimVersion}
  const mechanismFindings = new Map(); // experiment id -> finding

  const addEdge = (from, to) => {
    if (!edges.has(from)) edges.set(from, new Set());
    edges.get(from).add(to);
  };

  events.forEach((event, index) => {
    for (const message of validateEvent(event)) {
      fail(errors, event, "SINGLE_EVENT", message);
    }

    if (event.event_id !== undefined) {
      if (seenEventIds.has(event.event_id)) {
        fail(errors, event, "DUPLICATE_EVENT", `event_id 重复：${event.event_id}`);
      }
      seenEventIds.add(event.event_id);
    }

    const rule = EVENT_RULES[event.event_type];
    if (!rule) return;
    const payload = event.payload ?? {};
    const aggId = event.aggregate_id;
    const known = aggregates.get(aggId);

    if (known && known.type !== event.aggregate_type) {
      fail(errors, event, "AGGREGATE_TYPE_CONFLICT", `聚合 ${aggId} 类型前后不一致`);
    }
    if (!known) {
      aggregates.set(aggId, { type: event.aggregate_type, version: event.version, withdrawn: false });
    } else {
      if (event.version !== known.version + 1) {
        fail(
          errors,
          event,
          "VERSION_GAP",
          `聚合 ${aggId} 版本必须连续：期望 ${known.version + 1}，实际 ${event.version}`,
        );
      }
      known.version = Math.max(known.version, event.version);
    }
    if (index === 0 && event.version !== 1) {
      fail(errors, event, "VERSION_START", `聚合 ${aggId} 首个事件 version 必须为 1`);
    }

    // 血缘链接：目标必须存在、类型必须匹配、锚定版本不得超过当时版本。
    for (const link of payload.links ?? []) {
      if (!link || !link.id) continue;
      const target = aggregates.get(link.id);
      if (!target) {
        fail(errors, event, "BROKEN_LINK", `血缘引用不存在：${link.type}/${link.id}`);
      } else {
        if (target.type !== link.type) {
          fail(
            errors,
            event,
            "LINK_TYPE_MISMATCH",
            `血缘引用 ${link.id} 实际类型为 ${target.type}，声明为 ${link.type}`,
          );
        }
        if (link.version !== undefined && link.version > target.version) {
          fail(
            errors,
            event,
            "LINK_VERSION_AHEAD",
            `血缘引用 ${link.id}@${link.version} 超出当时已存在版本 ${target.version}`,
          );
        }
        addEdge(aggId, link.id);
      }
    }

    switch (event.event_type) {
      case "CONSENT_GRANTED": {
        consents.set(aggId, { allowed_uses: new Set(payload.allowed_uses ?? []), withdrawn: false });
        break;
      }
      case "CONSENT_WITHDRAWN": {
        const consent = consents.get(aggId);
        if (!consent) fail(errors, event, "LIFECYCLE", "撤回的同意记录不存在");
        else if (consent.withdrawn) fail(errors, event, "ALREADY_WITHDRAWN", `同意 ${aggId} 已撤回`);
        if (consent) consent.withdrawn = true;
        break;
      }
      case "DATA_AUTHORIZED": {
        const consentIds = (payload.links ?? []).filter((l) => l.type === "consent_grant").map((l) => l.id);
        omics.set(aggId, { consentIds, withdrawn: false });
        break;
      }
      case "DATA_WITHDRAWN": {
        const release = omics.get(aggId);
        if (!release) fail(errors, event, "LIFECYCLE", "撤回的组学发布不存在");
        else if (release.withdrawn) fail(errors, event, "ALREADY_WITHDRAWN", `组学发布 ${aggId} 已撤回`);
        if (release) release.withdrawn = true;
        break;
      }
      case "ANALYSIS_FROZEN": {
        if (known) {
          fail(errors, event, "FROZEN_IMMUTABLE", `分析流程 ${aggId} 已冻结，冻结版本不可变；更新请新建 run`);
        }
        break;
      }
      case "MODEL_VERSIONED": {
        // 模型更新以新 run 首事件登记（v1），链接被取代的旧 run；旧 run 保持冻结不可变。
        if (known) {
          fail(errors, event, "FROZEN_IMMUTABLE", `MODEL_VERSIONED 必须产生新 analysis_run，不得追加到 ${aggId}`);
        }
        const predecessor = (payload.links ?? []).find((l) => l.type === "analysis_run");
        if (predecessor && !aggregates.has(predecessor.id)) {
          fail(errors, event, "BROKEN_LINK", `被取代的旧 run 不存在：${predecessor.id}`);
        }
        break;
      }
      case "CELL_SUBSET_REANNOTATED": {
        if (!known) fail(errors, event, "LIFECYCLE", "修订注释的细胞亚群不存在");
        if (known && payload.previous_version !== event.version - 1) {
          fail(
            errors,
            event,
            "VERSION_PIN",
            `previous_version 必须是紧前版本 ${event.version - 1}，实际为 ${payload.previous_version}`,
          );
        }
        break;
      }
      case "MECHANISM_TESTED": {
        mechanismFindings.set(aggId, payload.finding);
        break;
      }
      case "CLAIM_PROPOSED":
      case "CLAIM_PROMOTED":
      case "EVIDENCE_PROMOTED": {
        const existing = claims.get(aggId);
        if (event.event_type === "CLAIM_PROPOSED") {
          if (existing) fail(errors, event, "LIFECYCLE", `主张 ${aggId} 已存在，不能重复提出`);
          if (
            MATURITY_LEVELS[payload.maturity] >= MATURITY_LEVELS.SINGLE_CELL_ASSOCIATION &&
            !(payload.links ?? []).length
          ) {
            fail(errors, event, "NO_LINEAGE", "关联级及以上主张必须携带血缘链接（links 不能为空）");
          }
          claims.set(aggId, {
            maturity: payload.maturity,
            statement: payload.statement,
            withdrawn: false,
          });
        } else {
          if (!existing) fail(errors, event, "LIFECYCLE", `晋升的主张 ${aggId} 尚未提出`);
          if (existing && existing.withdrawn) fail(errors, event, "ALREADY_WITHDRAWN", "不能晋升已撤回主张");
          if (existing && payload.promoted_from !== existing.maturity) {
            fail(
              errors,
              event,
              "STALE_PROMOTION",
              `promoted_from 与当前成熟度不符：声明 ${payload.promoted_from}，当前 ${existing.maturity}`,
            );
          }
          if (existing) {
            existing.maturity = payload.promoted_to;
            if (typeof payload.statement === "string") existing.statement = payload.statement;
          }
        }

        const claim = claims.get(aggId);
        const targetMaturity =
          event.event_type === "CLAIM_PROPOSED" ? payload.maturity : payload.promoted_to;
        const statement =
          typeof payload.statement === "string"
            ? payload.statement
            : claim?.statement;
        if (statement) {
          for (const message of checkWording(statement, targetMaturity)) {
            fail(errors, event, "WORDING", message);
          }
        }

        // 成熟度证据齐备性：血缘闭包必须覆盖阶梯要求的对象类型。
        const required = MATURITY_LINK_REQUIREMENTS[MATURITY_LEVELS[targetMaturity]];
        if (required) {
          const reach = closure(aggId, edges, aggregates);
          for (const type of required) {
            if (!reach.types.has(type)) {
              fail(
                errors,
                event,
                "INSUFFICIENT_EVIDENCE",
                `晋升到 ${targetMaturity} 的血缘必须包含 ${type}`,
              );
            }
          }
          if (MATURITY_LEVELS[targetMaturity] >= MATURITY_LEVELS.MECHANISTIC_SUPPORT) {
            const supported = [...reach.ids].some(
              (id) => aggregates.get(id)?.type === "mechanism_experiment" && mechanismFindings.get(id) === "supports",
            );
            if (!supported) {
              fail(errors, event, "INSUFFICIENT_EVIDENCE", `${targetMaturity} 要求至少一项 supports 的机制实验`);
            }
          }
        }
        break;
      }
      case "CLAIM_WITHDRAWN": {
        const claim = claims.get(aggId);
        if (!claim) fail(errors, event, "LIFECYCLE", "撤回的主张不存在");
        else if (claim.withdrawn) fail(errors, event, "ALREADY_WITHDRAWN", `主张 ${aggId} 已撤回`);
        if (claim) claim.withdrawn = true;
        const agg = aggregates.get(aggId);
        if (agg) agg.withdrawn = true;
        break;
      }
      case "USE_APPROVED": {
        const ref = payload.claim_ref;
        const claim = ref ? claims.get(ref.id) : undefined;
        if (!ref || ref.type !== "evidence_claim") {
          fail(errors, event, "BAD_CLAIM_REF", "签署必须指向 evidence_claim");
        } else if (!claim) {
          fail(errors, event, "BROKEN_LINK", `签署的主张不存在：${ref.id}`);
        } else {
          if (claim.withdrawn) fail(errors, event, "CLAIM_WITHDRAWN", "不能签署已撤回主张");
          if (ref.version !== aggregates.get(ref.id)?.version) {
            fail(
              errors,
              event,
              "VERSION_PIN",
              `签署必须锚定主张当前版本：${ref.version}，当前 ${aggregates.get(ref.id)?.version}`,
            );
          }
          const minLevel = MIN_MATURITY_FOR_USE[payload.intended_use];
          if (MATURITY_LEVELS[claim.maturity] < minLevel) {
            fail(
              errors,
              event,
              "MATURITY_TOO_LOW",
              `${payload.intended_use} 用途要求主张成熟度不低于 ${MATURITY_ORDER[minLevel]}，当前 ${claim.maturity}`,
            );
          }
          const reach = closure(ref.id, edges, aggregates);
          const consentBlocking = [...reach.ids]
            .filter((id) => omics.get(id)?.withdrawn || [...(omics.get(id)?.consentIds ?? [])].some((c) => consents.get(c)?.withdrawn))
            .map((id) => `omics:${id}`);
          if (consentBlocking.length) {
            fail(errors, event, "CONSENT_BLOCKING", `血缘中数据/同意已撤回：${consentBlocking.join(", ")}`);
          }
          const lacksConsent = [...reach.ids]
            .filter((id) => aggregates.get(id)?.type === "omics_release")
            .flatMap((id) => omics.get(id)?.consentIds ?? [])
            .some((cid) => ![...(consents.get(cid)?.allowed_uses ?? [])].includes(payload.intended_use));
          if (lacksConsent) {
            fail(errors, event, "CONSENT_SCOPE", `捐献者同意范围未覆盖 ${payload.intended_use} 用途`);
          }
        }
        decisions.set(aggId, {
          use: payload.intended_use,
          claimId: ref?.id,
          claimVersion: ref?.version,
        });
        break;
      }
      case "STATEMENT_PUBLISHED": {
        const decisionLinks = (payload.links ?? []).filter((l) => l.type === "use_decision");
        if (decisionLinks.length === 0) {
          fail(errors, event, "NO_SIGN_OFF", "对外表述必须锚定签署决定（use_decision）");
        }
        for (const link of decisionLinks) {
          const decision = decisions.get(link.id);
          if (!decision) {
            fail(errors, event, "BROKEN_LINK", `签署决定不存在：${link.id}`);
            continue;
          }
          if (USE_RANK[payload.statement_use] > USE_RANK[decision.use]) {
            fail(
              errors,
              event,
              "USE_BOUNDARY",
              `表述用途 ${payload.statement_use} 超出签署许可 ${decision.use}`,
            );
          }
          if (decision.claimId !== payload.claim_id || decision.claimVersion !== payload.signed_claim_version) {
            fail(errors, event, "VERSION_PIN", "表述锚定的主张/版本与签署决定不一致");
          }
        }
        const claim = claims.get(payload.claim_id);
        if (!claim) {
          fail(errors, event, "BROKEN_LINK", `表述引用的主张不存在：${payload.claim_id}`);
        } else {
          if (claim.withdrawn) fail(errors, event, "CLAIM_WITHDRAWN", "不得发布已撤回主张");
          if (payload.claim_version !== payload.signed_claim_version) {
            fail(errors, event, "VERSION_PIN", "发布版本必须等于签署时锚定的主张版本");
          }
          if (payload.claim_version !== aggregates.get(payload.claim_id)?.version) {
            fail(
              errors,
              event,
              "VERSION_PIN",
              `发布必须使用主张当前版本：${payload.claim_version}，当前 ${aggregates.get(payload.claim_id)?.version}`,
            );
          }
          if (payload.statement_use !== USES.CLINICAL && payload.de_identified !== true) {
            fail(errors, event, "DE_IDENTIFICATION", "研究/教学表述必须去标识");
          }
        }
        break;
      }
      default:
        break;
    }
  });

  return errors;
}
