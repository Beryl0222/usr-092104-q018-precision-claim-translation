# 主张成熟度、用途边界与版本治理

本文件定义精准医学主张服务的领域语义：对象血缘、成熟度阶梯、用途边界、签署规则、
版本冻结与影响传播，以及四类角色的可见范围。事件字段与校验规则以
`contracts/domain.schema.json` 和 `src/validator.js` 为可执行版本；本文件解释其含义。

## 1. 要解决的问题

同一句“药物 X 可能提高疗效”会被三处引用：

- **研究**：单细胞分析发现某细胞亚群中靶点表达与疗效信号关联；
- **教学**：案例库把该结论用于授课；
- **临床会议**：被当作某患者可能获益的依据。

三者的证据等级完全不同。分析流程或注释更新后，原始依据还可能找不到。
因此每个主张必须同时携带：**成熟度、用途许可、来源血缘、冻结版本、签署人与未知项**。

## 2. 对象链与聚合

从样本到对外表述的对象链，每个对象都是可寻址聚合（`aggregate_type`）：

| 聚合 | 含义 | 版本化要点 |
| --- | --- | --- |
| `consent_grant` | 样本捐献者的同意与用途授权 | 撤回 (`CONSENT_WITHDRAWN`) 后下游用途立即受限 |
| `omics_release` | 一次组学数据发布（按同意范围） | 数据撤回 (`DATA_WITHDRAWN`) 只影响后续使用 |
| `analysis_run` | 一次冻结的分析流程运行（代码/参数/模型版本） | 冻结后不可变；更新产生新 run 与新版本号 |
| `cell_subset` | 分析输出的细胞亚群及其注释 | 注释修订产生新版本，不覆盖旧版本 |
| `target_candidate` | 候选靶点（来自亚群证据） | 可关联机制实验与临床研究 |
| `mechanism_experiment` | 实验室机制实验 | 支持或反驳靶点机制 |
| `clinical_study` | 临床研究结果 | 带来人群定义与结论强度 |
| `stratification_rule` | 分层/入组规则 | 版本化；临床引用必须指具体版本 |
| `evidence_claim` | 主张（把上述对象组装成一句话及其证据链） | 成熟度承载于本聚合 |
| `use_decision` | 主张的用途签署决定 | 限定用途与适用人群 |
| `external_statement` | 对外表述/课程材料 | 必须锚定签署决定与主张版本 |

血缘通过事件 `payload` 中的 `links`（`{type, id, version?}`）表达。
任意主张都可以沿 links 回溯到同意记录；缺少回溯路径的主张不得进入教学或临床用途。

## 3. 成熟度阶梯

主张 (`evidence_claim`) 的成熟度只能沿以下顺序晋升，每次晋升必须携带对应支撑：

| 级别 | 常量 | 含义 | 进入条件（links 必须包含） |
| --- | --- | --- | --- |
| 0 假设 | `HYPOTHESIS` | 人工提出的待验证假设 | 无强制证据 |
| 1 关联 | `SINGLE_CELL_ASSOCIATION` | 单细胞分析发现的统计关联 | 一个已冻结 `analysis_run` + 一个 `cell_subset` |
| 2 机制 | `MECHANISTIC_SUPPORT` | 实验室支持的机制 | 上一级全部 links + 一个支持性 `mechanism_experiment`（支持性结论） |
| 3 临床 | `CLINICAL_EVIDENCE` | 有临床研究结果 | 上一级全部 links + 一个 `clinical_study` |
| 4 可决策 | `ACTIONABLE` | 可限定人群用于个人决策 | 上一级全部 links + 一个 `stratification_rule` + 一条 `clinical` 签署 |

规则：

- **统计相关不得被系统写成因果。** 成熟度 1 的系统生成措辞只允许
  “在该分析中与……关联 / associated with”；出现“导致、提高、机制为、causes、improves”
  等因果或疗效措辞即校验失败。因果措辞最早从成熟度 2 起，疗效断言最早从成熟度 3 起。
- 晋升不得跳级；降级由治理撤回事件处理，不由编辑事件静默完成。
- 晋升事件需记录 `promoted_from` / `promoted_to` 与评审人。

## 4. 用途边界

用途许可（`intended_use`）的宽严顺序：

```
research（研究复现） < education（教学案例） < clinical（临床个人决策）
```

- 签署决定 (`USE_APPROVED`) 把**主张版本**与用途绑定；`external_statement` 的用途
  不得超过其签署决定许可的范围（教学材料不得引用仅有 research 许可的主张）。
- **科研主张不直接生成治疗方案。** 主张 payload 不允许出现处方字段
  （`treatment_plan` 等）；治疗安排只存在于临床系统中，由持照人员依据
  `clinical` 签署与分层规则另行作出。
- **进入临床的判断必须由合格人员签署并限定适用人群。**
  `clinical` 签署要求签署人角色为 `licensed_physician`（或 `clinical_governance_board`），
  且 payload 必须含非空 `applicable_population`。
- 教学与研究用途不得出现可识别患者信息；教师只能取得获准的去标识案例。

### 角色视图

| 角色 | 可见范围 |
| --- | --- |
| `researcher` | 完整血缘与冻结流程，可复现结论（含 run 参数版本、原始 release 引用） |
| `educator` | 仅取得含 `education`（或更宽）签署、且已去标识的案例；撤回/受限内容被过滤 |
| `clinician` | 当前患者相关的证据：成熟度、适用人群、未知项 (`open_questions`)、
  引用的分层规则版本；只展示 `clinical` 签署有效的主张 |
| `governance` | 全部事件；重点看到越界表述、无签署使用、签署人资质不符、陈旧血缘、
  撤回未传播等告警 |

## 5. 版本冻结与影响传播

- **冻结即不可变**：`ANALYSIS_FROZEN` 之后，同一 `analysis_run` 再出现冻结/变更事件即冲突；
  更新模型或参数必须新建 run，并以 `MODEL_VERSIONED` 登记模型的新版本。
- **修订而非覆盖**：`CELL_SUBSET_REANNOTATED` 产生亚群新版本；旧版本保留，
  已发表/已签署材料锚定的版本仍可取阅。
- **发表版本永久保留**：`external_statement` 通过 `claim_version` 与
  `signed_claim_version` 锚定当时版本；撤回或修订不删除这些版本号。
- **撤回必须指出影响面**：`DATA_WITHDRAWN`、`CONSENT_WITHDRAWN`、`CLAIM_WITHDRAWN`、
  `STATEMENT_RETRACTED` 的 payload 必须含 `affected_claim_ids` 与 `affected_course_ids`，
  说明受影响主张与课程；事件本身不删除历史数据。
- **影响沿血缘下推**：投影时，上游撤回/修订会把下游仍引用旧版本的主张标记为
  `stale`（陈旧）或 `blocked`（撤回阻断），角色视图据此过滤或告警。

## 6. 事件目录

见 `contracts/domain.schema.json` 中 `event_type` 枚举；事件与聚合的合法归属、
payload 必需字段见 `src/constants.js` 的 `EVENT_RULES`，由 `src/validator.js` 强制执行。
核心时序：

```
CONSENT_GRANTED → DATA_AUTHORIZED → ANALYSIS_FROZEN → CELL_SUBSET_DEFINED
  → TARGET_PROPOSED → MECHANISM_TESTED → CLINICAL_STUDY_RECORDED
  → STRATIFICATION_RULE_SET → CLAIM_PROPOSED → CLAIM_PROMOTED(*n)
  → EVIDENCE_PROMOTED → USE_APPROVED → STATEMENT_PUBLISHED
横切：MODEL_VERSIONED / CELL_SUBSET_REANNOTED / DATA_WITHDRAWN /
      CONSENT_WITHDRAWN / CLAIM_WITHDRAWN / STATEMENT_RETRACTED
```
