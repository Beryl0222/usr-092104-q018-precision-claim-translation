# 精准医学主张转化

本仓库保存“精准医学主张服务”的领域词汇、事件契约、成熟度与用途边界规则、角色投影和基础校验代码。目标是让同一句“可能提高疗效”在**研究、教学、临床会议**中各有明确的成熟度、来源与用途，分析版本变化后仍能找回原始依据；领域事件继续承担各系统之间的版本交换。

## 解决的问题

- 单细胞分析的统计关联、实验室机制、临床研究、个人决策级证据共用一句话、无法区分。
- 统计相关被系统自动写成因果；科研主张被直接用于生成治疗方案。
- 进入临床的判断缺少合格人员签署与适用人群限定。
- 撤回数据、修订注释、更新模型后，没人知道哪些主张、课程、表述受影响，旧版本也找不回。

## 成熟度阶梯（只能逐级、人工晋升）

| 级别 | 含义 | 晋升条件 |
|---|---|---|
| **M1** | 单细胞统计关联 | 提出阶段只允许 M1/M2 |
| **M2** | 实验室机制支持 | 引用结果为 `supports` 的机制实验 |
| **M3** | 临床研究证据 | 引用至少一项已登记临床研究 |
| **M4** | 个人决策就绪 | 阳性 II 期 / III 期 RCT / 荟萃分析；非空纳入人群；之后方可发布分层规则并临床签署 |

成熟度与**推断强度**正交：`statistical_association → mechanistically_supported → causal`。系统角色不得自动升级为因果；人工升级因果仍需机制支持与阳性临床研究同时在场。

## 用途边界

`research` / `teaching` / `clinical` 三种用途独立授权：

- **研究**：复现需要完整来源链与流程版本。
- **教学**：只能取得获准的**去标识**案例，来源样本同意须含 `teaching_deidentified`。
- **临床**：仅 M4 主张，须由 `qualified_clinician` 对**具体主张版本**签署，绑定版本一致的分层规则，并限定 `scope_population`；系统不自动生成治疗方案。

## 撤回 / 修订 / 换模型

三类触发事件（`CONSENT_WITHDRAWN`、`ANNOTATION_REVISED`、`MODEL_UPDATED`）之后**必须**出具 `IMPACT_ASSESSED`：

- 沿来源链闭包指出全部受影响的主张、对外表述、课程与用途决定及处置动作；
- 为一切**已发表时所用版本**保留不可变快照（主张版本、被替换的分析运行）；
- 影响评估在“出具时刻”的状态上校验，不追溯之后才发表的内容。

## 事件目录

| 阶段 | 聚合 | 事件 |
|---|---|---|
| 同意 | `consent` | CONSENT_GRANTED / CONSENT_WITHDRAWN |
| 数据 | `omics_release` | DATA_AUTHORIZED |
| 分析 | `analysis_run` / `analysis_pipeline` | ANALYSIS_FROZEN / MODEL_UPDATED |
| 发现 | `cell_subset` / `candidate_target` | CELL_SUBSET_REGISTERED / TARGET_NOMINATED |
| 机制 | `mechanism_experiment` | MECHANISM_ASSAYED |
| 临床研究 | `clinical_study` | CLINICAL_STUDY_RECORDED |
| 主张 | `evidence_claim` | CLAIM_PROPOSED / EVIDENCE_PROMOTED / ANNOTATION_REVISED / CLAIM_WITHDRAWN |
| 分层 | `stratification_rule` | STRATIFICATION_RULE_PUBLISHED |
| 用途决定 | `use_decision` | USE_APPROVED |
| 对外表述 | `external_statement` | STATEMENT_PUBLISHED |
| 教学 | `teaching_course` | COURSE_PUBLISHED / COURSE_SUPERSEDED |
| 影响与治理 | `impact_assessment` / `governance_alert` | IMPACT_ASSESSED / GOVERNANCE_ALERT_RAISED |

事件信封与各 payload 形状见 `contracts/domain.schema.json`；TypeScript 类型见 `src/domain.ts`。

## 代码结构

- `contracts/domain.schema.json`：可执行契约（if/then 按事件类型约束 payload）。
- `src/schema-check.js`：零依赖的 JSON Schema 子集校验器。
- `src/state.js`：事件溯源归约、时间点归约 `replayUntil`、来源链闭包。
- `src/validator.js`：`validateEvent`（单事件）与 `validateStream`（跨事件守卫），违规返回 `{code, event_id, message}`。
- `src/views.js`：角色投影 `researcherView / teacherView / clinicianView / governanceView`。
- `data/lifecycle.json`：一条完整中文联调事件流（同意→发现→机制→逐级晋升→签署→表述→课程→换模型→撤回），零违规。

### 角色可见范围

| 角色 | 看到 | 看不到 |
|---|---|---|
| 研究者 | 完整来源链、全部版本与时间线、流程版本与“已被新模型取代”复现告警 | — |
| 教师 | 获准的去标识案例、钉版主张、未知项；投影经可识别字段扫描 | 受试者标识、同意与数据集引用 |
| 临床人员 | 与当前患者特征匹配的证据范围、纳入/排除、签署人、有效期、未知项；时间点视图 | 未签署、低于 M4、已撤回或越出适用人群的内容 |
| 治理 | 全部违规、告警、用途台账、影响评估与快照清单 | — |

## 本地检查

```bash
npm test          # 33 项：契约形状 + 全部跨事件守卫 + 四个角色视图
```

## 兼容性

已登记事件与枚举只增不改；`validateEvent(record)` 的旧调用方式（返回错误字符串数组）保持兼容。新增事件类型时同步更新 schema、归约器、README 事件目录与测试。
