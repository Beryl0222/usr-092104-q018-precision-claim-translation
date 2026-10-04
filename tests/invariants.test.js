import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validateEvent, validateEventStream } from "../src/validator.js";

const samplePath = new URL("../data/lineage-sample.json", import.meta.url);

async function loadSample() {
  return JSON.parse(await readFile(samplePath, "utf8"));
}

/** 从样例前缀构造流；overrides 按 event_id 替换字段。 */
async function stream(upToEventId, overrides = {}) {
  const all = await loadSample();
  const index = all.findIndex((e) => e.event_id === upToEventId);
  const out = all.slice(0, index + 1).map((e) =>
    overrides[e.event_id] ? JSON.parse(JSON.stringify({ ...e, ...overrides[e.event_id], payload: { ...e.payload, ...(overrides[e.event_id].payload ?? {}) } })) : e,
  );
  return out;
}

test("全链样例事件流通过所有不变量", async () => {
  const errors = validateEventStream(await loadSample());
  assert.deepEqual(errors, []);
});

test("单条校验拒绝缺少信封字段", () => {
  assert.match(validateEvent({ event_type: "CLAIM_PROPOSED" }).join(";"), /缺少字段：event_id/);
});

test("事件必须归属正确聚合", async () => {
  const events = await stream("evt-018-003", {
    "evt-018-003": { aggregate_type: "evidence_claim" },
  });
  assert.match(validateEventStream(events)[0].message, /必须归属聚合 analysis_run/);
});

test("版本必须连续且从 1 开始", async () => {
  const events = await stream("evt-018-010", {
    "evt-018-010": { version: 9 },
  });
  assert.ok(validateEventStream(events).some((e) => e.code === "VERSION_GAP"));
});

test("冻结后的 analysis_run 不可变；模型更新必须新建 run", async () => {
  const events = await loadSample();
  const frozenAgain = JSON.parse(JSON.stringify(events[2]));
  frozenAgain.event_id = "evt-dup-freeze";
  frozenAgain.version = 2;
  assert.ok(validateEventStream([...events.slice(0, 3), frozenAgain]).some((e) => e.code === "FROZEN_IMMUTABLE"));

  const onSameRun = await stream("evt-018-017", {
    "evt-018-017": { aggregate_id: "run-r018", version: 2 },
  });
  assert.ok(validateEventStream(onSameRun).some((e) => e.code === "FROZEN_IMMUTABLE"));
});

test("血缘断裂被拒绝", async () => {
  const events = await stream("evt-018-005", {
    "evt-018-005": {
      payload: { links: [{ type: "cell_subset", id: "subset-不存在" }] },
    },
  });
  assert.ok(validateEventStream(events).some((e) => e.code === "BROKEN_LINK"));
});

test("锚定不存在的未来版本被拒绝", async () => {
  const events = await stream("evt-018-003", {
    "evt-018-003": {
      payload: { links: [{ type: "omics_release", id: "omics-o018", version: 7 }] },
    },
  });
  assert.ok(validateEventStream(events).some((e) => e.code === "LINK_VERSION_AHEAD"));
});

test("关联级措辞不得作因果或疗效断言", async () => {
  const events = await stream("evt-018-010", {
    "evt-018-010": {
      payload: { statement: "LAG3 阻断导致疗效提高，可直接改善生存" },
    },
  });
  const messages = validateEventStream(events).map((e) => e.message).join(";");
  assert.match(messages, /不得含因果/);
  assert.match(messages, /不得作疗效断言/);
});

test("机制级起允许因果措辞，临床级起允许疗效断言", async () => {
  const throughMech = await stream("evt-018-011", {
    "evt-018-011": { payload: { statement: "实验表明 LAG3 阻断驱动该亚群效应功能恢复" } },
  });
  assert.ok(!validateEventStream(throughMech).some((e) => e.code === "WORDING"));

  const tooEarlyEfficacy = await stream("evt-018-011", {
    "evt-018-011": { payload: { statement: "LAG3 阻断提高疗效" } },
  });
  assert.ok(validateEventStream(tooEarlyEfficacy).some((e) => /疗效断言/.test(e.message)));
});

test("成熟度不得跳级", async () => {
  const events = await stream("evt-018-010", {
    "evt-018-010": {
      payload: { promoted_from: "HYPOTHESIS", promoted_to: "ACTIONABLE" },
    },
  });
  assert.ok(validateEventStream(events).some((e) => /逐级晋升/.test(e.message)));
});

test("晋升证据不足被拒绝：缺机制实验不能到机制级", async () => {
  const all = await loadSample();
  const cut = all.filter((e) => e.event_id !== "evt-018-006");
  const errors = validateEventStream(cut.slice(0, cut.findIndex((e) => e.event_id === "evt-018-011") + 1));
  assert.ok(errors.some((e) => e.code === "INSUFFICIENT_EVIDENCE"));
});

test("机制实验必须为 supports 才能支撑机制级", async () => {
  const events = await stream("evt-018-011", {
    "evt-018-006": { payload: { finding: "refutes" } },
  });
  assert.ok(validateEventStream(events).some((e) => /supports 的机制实验/.test(e.message)));
});

test("主张不得携带治疗安排字段", async () => {
  const events = await stream("evt-018-009", {
    "evt-018-009": { payload: { treatment_plan: "LAG3 抗体 400mg q4w" } },
  });
  assert.ok(validateEventStream(events).some((e) => /治疗安排字段/.test(e.message)));
});

test("临床签署必须由持照人员作出并限定适用人群", async () => {
  const badRole = await stream("evt-018-015", {
    "evt-018-015": {
      payload: { signer: { staff_id: "x", role: "researcher" }, applicable_population: "某人群" },
    },
  });
  assert.ok(validateEventStream(badRole).some((e) => /无权签署 clinical/.test(e.message)));

  const noPopulation = await stream("evt-018-015", {
    "evt-018-015": { payload: { applicable_population: "" } },
  });
  assert.ok(validateEventStream(noPopulation).some((e) => /applicable_population/.test(e.message)));
});

test("低成熟度主张不得被临床签署", async () => {
  const all = await loadSample();
  // 仅取到关联级（evt-018-010），再追加一条针对 v2 的临床签署
  const prefix = all.slice(0, 10);
  const earlyClinical = JSON.parse(JSON.stringify(all[14]));
  earlyClinical.event_id = "early-clinical";
  earlyClinical.aggregate_id = "decision-early";
  earlyClinical.payload.claim_ref = { type: "evidence_claim", id: "claim-e018", version: 2 };
  const errors = validateEventStream([...prefix, earlyClinical]);
  assert.ok(errors.some((e) => e.code === "MATURITY_TOO_LOW"));
});

test("签署必须锚定主张当前版本", async () => {
  const events = await stream("evt-018-015", {
    "evt-018-015": {
      payload: { claim_ref: { type: "evidence_claim", id: "claim-e018", version: 4 } },
    },
  });
  assert.ok(validateEventStream(events).some((e) => e.code === "VERSION_PIN"));
});

test("同意用途不覆盖时不得签署", async () => {
  const events = await stream("evt-018-015", {
    "evt-018-001": { payload: { allowed_uses: ["research"] } },
  });
  assert.ok(validateEventStream(events).some((e) => e.code === "CONSENT_SCOPE"));
});

test("数据撤回阻断下游签署，且撤回事件必须声明影响面", async () => {
  const all = await loadSample();
  const withdrawal = {
    event_id: "evt-withdraw",
    event_type: "DATA_WITHDRAWN",
    aggregate_type: "omics_release",
    aggregate_id: "omics-o018",
    occurred_at: "2026-09-30T12:00:00+08:00",
    version: 2,
    summary: "捐献者撤回数据使用",
    payload: { reason: "捐献者撤回", affected_claim_ids: ["claim-e018"], affected_course_ids: ["COURSE-ONC-101"] },
  };
  const idx = all.findIndex((e) => e.event_id === "evt-018-015");
  const events = [...all.slice(0, idx), withdrawal, all[idx]];
  assert.ok(validateEventStream(events).some((e) => e.code === "CONSENT_BLOCKING"));

  const noImpact = validateEventStream([
    withdrawal,
    { ...withdrawal, event_id: "evt-bad", payload: { reason: "x" }, version: 3 },
  ]);
  assert.ok(noImpact.some((e) => /affected_claim_ids/.test(e.message)));
});

test("对外表述不得越过签署用途边界", async () => {
  const events = await stream("evt-018-016", {
    "evt-018-016": {
      payload: {
        statement_use: "clinical",
        links: [{ type: "use_decision", id: "decision-u018-edu", version: 1 }],
      },
    },
  });
  assert.ok(validateEventStream(events).some((e) => e.code === "USE_BOUNDARY"));
});

test("教学表述必须去标识", async () => {
  const events = await stream("evt-018-016", {
    "evt-018-016": { payload: { de_identified: false } },
  });
  assert.ok(validateEventStream(events).some((e) => e.code === "DE_IDENTIFICATION"));
});

test("无签署决定的对外表述被拒绝", async () => {
  const events = await stream("evt-018-016", {
    "evt-018-016": { payload: { links: [] } },
  });
  assert.ok(validateEventStream(events).some((e) => e.code === "NO_SIGN_OFF"));
});

test("撤回已发表主张后发布被拒绝；历史版本不被删除", async () => {
  const all = await loadSample();
  const withdrawClaim = {
    event_id: "evt-claim-withdraw",
    event_type: "CLAIM_WITHDRAWN",
    aggregate_type: "evidence_claim",
    aggregate_id: "claim-e018",
    occurred_at: "2026-10-01T20:00:00+08:00",
    version: 6,
    summary: "因原始数据问题撤回主张",
    payload: {
      reason: "原始批次效应未校正",
      affected_claim_ids: ["claim-e018"],
      affected_course_ids: ["COURSE-ONC-101"],
    },
  };
  const idx = all.findIndex((e) => e.event_id === "evt-018-016");
  const events = [...all.slice(0, idx), withdrawClaim, all[idx]];
  assert.ok(validateEventStream(events).some((e) => e.code === "CLAIM_WITHDRAWN"));
  // 撤回事件本身保留，且发表事件仍锚定 v5（版本号不消失）。
  assert.equal(withdrawClaim.payload.affected_course_ids[0], "COURSE-ONC-101");
  assert.equal(all[idx].payload.claim_version, 5);
});
