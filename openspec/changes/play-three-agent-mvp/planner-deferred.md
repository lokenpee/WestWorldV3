# 暂缓的编剧方案

REQ-039 首版只调导演、写手及历史摘要任务。编剧设计在此留存，等待单独确认是否恢复。下文中的工具、字段、调用时机、表写入及示例均属于暂停前的草案。当前流程和任务清单见[提案](proposal.md)及[现行任务契约](agent-contracts.md)。

## 原拟职责和接口

原拟在选定开局后拟一份近期计划。行动改变计划的必要条件或持续目标时，导演标记影响，程序再请编剧修订。原拟编剧可查资料、提交候选计划，正式保存由结算程序负责。原著后续节点作为参考，其内容须与本局已发生的事实区分。

| 任务 | 启动条件和交付 | 工具 |
|---|---|---|
| `play-plan` 编剧维护近期计划 | `initial` 围绕已选开局建立近期计划；`replan` 仅在本轮结果使关键前提失效或显著改变持续目标时重审。返回完整的新候选计划，带上沿用、替换和取消的事项。 | `browse_play_sources`、`read_play_source`、`submit_result`（仅计划） |

| 角色 | 输入 | 交付 |
|---|---|---|
| 编剧 | `mode: initial / replan`（初拟或修改计划）、本局当前事实 `currentFacts[]`、原计划 `previousPlan`（开局为空）、`directorResult?` 本轮已确定后果及重大影响、`originalDirections[]` 标签明确的原著参考、`evidenceRefs[]` | `items:[{id,goal,premises,status}], changeReason, evidenceRefs[]`。每个事项有编号 `id`、目标 `goal`、成立条件 `premises` 和状态 `status`（仍在进行 `active`、已取消 `cancelled`、已达成 `fulfilled`）。`changeReason` 说明整份计划改动的原因。`evidenceRefs` 指明依据。`premises` 是 `{text,evidenceRefs:Ref[]}` 列表。`goal` 陈述所要推动的矛盾或意向；当条件不足，仍允许有条件的发展。编剧提交拟定的计划，程序在整轮结算时把它保存到新版本。 |

原拟导演接收 `currentPlan`，返回 `impact:{major,itemIds,reason}`。`major` 表示是否需重新拟计划，`itemIds` 指受影响的原事项，`reason` 解释已发生的变化。运行器原拟向编剧提供可查的原著后续方向、本局已确定的事实与单独分配的引用，写手则只取可以展示的动作。开场原拟等待初始计划；需重拟时原拟等本轮正文和修订计划共同提交。角色结果均只存候选，提交游戏版本时才生效。

## 原拟提示词全文

<a id="prompt-plan"></a>

### `play-plan.md`　编剧维护未来计划

> 你维护这个存档接下来的剧情方向。初始模式从眼前矛盾中找一个玩家可以介入的近期方向。每项计划给出稳定编号、目标、成立条件和条件的依据。后续节点、事件与故事线资产说明“故事原本可能怎样走”，可用来理解动机；把它写进计划时明确要满足哪些条件。给玩家保留离开或另想办法的余地。
>
> 重规划模式逐项比对导演已经确定的后果和旧前提。仍成立的事项沿用原编号，已经兑现的标记完成，基础已经消失的标记取消；新矛盾另给编号。修订理由要让下一轮的导演读出哪件事变了。不要反改刚发生的行动，不把未发生的未来写成本局事实，不代玩家预选下一步。通过 `submit_result` 交完整的近期计划和依据。

### 初始编剧拟定事项

系统提示词见 [play-plan.md 全文](#prompt-plan)。本次工具为 browse_play_sources、read_play_source、submit_result。

```json
{
  "mode": "initial",
  "currentFacts": [{"ref": "p-hall", "text": "贾珩和云光仍在官厅。"}],
  "previousPlan": null,
  "originalDirections": [{"nodeId": "C16-N002", "label": "原著后续参考", "text": "贾珩逼问黄泰供出云光通贼", "ref": "p-future"}],
  "evidenceRefs": ["p-hall", "p-future"]
}
```

玩家已确认官厅卡。编剧收到选定的场景，以及标为“原著后续参考”的节点，本例只以当前事实立项。计划候选留待第 0 版提交。

`submit_result` 的参数如下。

```json
{
  "items": [
    {
      "id": "p1",
      "goal": "给贾珩当面追问云光留出机会",
      "premises": [{"text": "贾珩和云光仍在官厅。", "evidenceRefs": ["p-hall"]}],
      "status": "active"
    }
  ],
  "changeReason": "两人仍在现场。",
  "evidenceRefs": ["p-hall"]
}
```

## 原拟改写示例

**把最后一轮改成离厅。** 玩家要求“我不再追问，告辞离开官厅”。原行动仍可回看。导演读追问之前的版本，以“厅外”为局内地点（若尚无此对象则先创建），更新主角及场景所在处。贾珩与云光不再同处厅内，`p1` 必要条件消失。写手收到的剧情步骤是“贾珩告辞 → 走出官厅 → 在厅外停下，由玩家决定去向”。编剧同时收到下面的请求。

<a id="replan-example"></a>

**程序交给编剧的改计划请求（预期示例）。** 程序从 V0 读出原计划，附上导演刚裁定的离厅结果。旧计划的条件和新的地点事实各有出处。本例无需随请求发送原著后续节点，编剧仍可按需查询。

```json
{
  "mode": "replan",
  "currentFacts": [
    {"ref":"plan-hall","text":"本轮开始前，贾珩与云光同在官厅。"},
    {"ref":"departure","text":"本轮导演已裁定贾珩离厅，云光仍在厅内。"}
  ],
  "previousPlan": {
    "id":"plan-A0",
    "items":[{"id":"p1","goal":"给贾珩当面追问云光留出机会","premises":[{"text":"两人仍在官厅能交谈","evidenceRefs":["plan-hall"]}],"status":"active"}],
    "changeReason":"开场时双方仍可当面交谈。",
    "evidenceRefs":["plan-hall"]
  },
  "directorResult": {
    "outcome":"success",
    "beats":[{"id":"leave","actorIds":["C1-P001"],"text":"贾珩告辞离厅。","revealRefs":["departure"]}],
    "impact":{"major":true,"itemIds":["p1"],"reason":"双方已不在同一地点，原定的当面追问无法继续。"},
    "evidenceRefs":["departure"]
  },
  "originalDirections":[],
  "evidenceRefs":["plan-hall","departure"]
}
```

**编剧提交给程序的完整计划。** 事项 `p1` 保留原编号并标为取消，新增事项 `p2` 记录以后还能追查什么，以及具备什么条件才可能推进。

```json
{"items":[{"id":"p1","goal":"给贾珩当面追问云光留出机会","premises":[{"text":"两人仍在官厅能交谈","evidenceRefs":["plan-hall"]}],"status":"cancelled"},{"id":"p2","goal":"保留云光改口原因尚待弄清的矛盾","premises":[{"text":"贾珩以后若再找到可询问的知情人，才有机会继续查证","evidenceRefs":["plan-hall","departure"]}],"status":"active"}],"changeReason":"贾珩告辞离厅，没有进行上一版本的当面追问。","evidenceRefs":["plan-hall","departure"]}
```

**下一轮怎样用。** 本轮写手和编剧都完成后，程序把正文、贾珩的新位置和 `snapshot.plan` 一起存入 V1b。计划里有已取消的 p1 和有效的 p2。如果下一句是“我去找个知情人问问”，程序把相关的 p2 放入导演的 `currentPlan.items`，将依据换成本次请求可用的编号。导演检查现场有没有能接触的知情人，再决定能否问、问到什么。若玩家转去做别的事，p2 可以继续保留。写手只收到导演本轮允许写的经过。新增 p2 时，原著事件节点表不增加记录，本局也还没有发生“找到知情人”这件事。

原拟计划按存档版本保存在 `snapshot.plan`。`p1`、`p2` 是本局内的计划事项编号。若本轮作废，候选随该轮作废。若以后恢复这项需求，须重新审查与当时存档、工具及角色可见资料之间的关系。
