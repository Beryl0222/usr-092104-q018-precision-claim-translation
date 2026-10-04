# 精准医学主张转化

本仓库保存精准医学主张服务的领域词汇、成熟度阶梯、用途边界、事件约定与可执行校验代码，
供研究、教学、临床会议等各系统在交换"主张"时统一**对象身份、证据等级、用途许可与版本语义**。

> 同一句"可能提高疗效"在研究、教学、临床会议中被各自引用，分析版本变化后谁也找不到原始依据。
> 本服务让每个主张都携带成熟度、来源血缘、冻结版本、签署人与未知项，
> 并强制：统计相关不能被写成因果；科研主张不生成治疗方案；进入临床必须由合格人员签署并限定人群。

## 目录

- `docs/claim-maturity.md`：领域语义——对象链、成熟度阶梯、用途边界、角色视图、版本冻结与影响传播。
- `contracts/domain.schema.json`：领域事件信封、19 类事件、11 类聚合及按事件类型的 payload 契约。
- `src/constants.js`：事件规则、成熟度/用途枚举与措辞红线（单一事实源）。
- `src/validator.js`：单事件校验 `validateEvent` 与事件流不变量 `validateEventStream`。
- `src/views.js`：四类角色视图投影（研究者 / 教师 / 临床 / 治理）。
- `src/domain.ts`：TypeScript 类型声明。
- `data/sample.json`：单事件信封联调样例；`data/lineage-sample.json`：全链样例（含模型更新与注释修订的影响传播）。
- `tests/`：不变量、角色视图与契约一致性检查。

## 对象链

```
consent_grant → omics_release → analysis_run → cell_subset → target_candidate
  → mechanism_experiment → clinical_study → stratification_rule
  → evidence_claim → use_decision → external_statement
```

## 成熟度阶梯（evidence_claim）

| 级别 | 含义 | 关键约束 |
| --- | --- | --- |
| `HYPOTHESIS` | 假设 | — |
| `SINGLE_CELL_ASSOCIATION` | 单细胞统计关联 | **只准"关联"措辞**，禁止因果/疗效词 |
| `MECHANISTIC_SUPPORT` | 实验室机制支持 | 需 `supports` 的机制实验；方可使用因果措辞 |
| `CLINICAL_EVIDENCE` | 临床研究结果 | 方可作疗效断言 |
| `ACTIONABLE` | 可限定人群用于个人决策 | 需分层规则 + **持照人员临床签署 + 适用人群** |

晋升只能逐级进行，且血缘闭包必须包含对应层级要求的全部对象。

## 用途边界与签署

- `research < education < clinical`，对外表述 (`external_statement`) 的用途不得越过其签署决定 (`USE_APPROVED`)。
- 临床签署的 `signer.role` 必须是 `licensed_physician` 或 `clinical_governance_board`，
  且必须给出非空 `applicable_population`；同意范围 (`allowed_uses`) 必须覆盖该用途。
- 主张 payload 禁止 `treatment_plan`/`prescription`/`dosage`/`regimen`——治疗决定在临床系统另行作出。
- 研究/教学表述必须 `de_identified=true`；教师只能取得获准的去标识案例。

## 版本与撤回

- 流程冻结 (`ANALYSIS_FROZEN`) 后不可变；更新模型以 `MODEL_VERSIONED` **新建 run**，旧 run 保留。
- 亚群注释以 `CELL_SUBSET_REANNOTATED` 出新版本，旧版本不覆盖。
- 签署与发表必须锚定主张**当前版本**；发表后该版本永久保留可查。
- 撤回/修订事件（同意、数据、主张、表述及模型/注释更新）必须声明
  `affected_claim_ids` 与 `affected_course_ids`；影响沿血缘下推为 `blocked`/`stale`。

## 角色视图（`src/views.js`）

| 函数 | 输出 |
| --- | --- |
| `researcherView` | 完整血缘与冻结流程的复现包；阻断与陈旧提示 |
| `educatorView` | 获准且去标识的教学案例；撤回阻断的被过滤，发表版本保留 |
| `clinicianView` | 与当前患者相关的证据范围、适用人群、分层规则版本与未知项；不含治疗方案 |
| `governanceView` | 校验错误与越界/陈旧/撤回未传播告警 |

## 本地检查

```bash
npm test
```

领域事件继续承担各系统之间的版本交换：新增系统应只通过追加事件与本契约集成，
保持事件类型与 payload 的向后兼容。
