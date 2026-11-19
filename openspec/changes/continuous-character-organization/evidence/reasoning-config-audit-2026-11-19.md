# BUG-32 思考配置与输出截断核查

关联 REQ-019、BUG-32；检查日期：2026-11-19。

## 用户要求与结论

用户要求先检查思考配置是否已经修复，不希望再出现单次请求约 112 秒、8192 个输出 Token 全是思考的情况。本次读取当前代码、锁定 SDK、历史确认与修复记录，并运行固定响应测试，没有调用真实模型或修改运行代码。

**结论：已修复第一步查重的 low 映射，但尚未完整处理纯思考耗尽输出后的恢复。不能将原故障整体判定为已经消除。**

原始样本见[39人查重诊断](identity-cost-2026-11-13.md)；后续批准的修复范围见[轻量整理设计](../lightweight-review.md)。该设计明确第一步使用 low，其余阶段保持既有档位，不扩大输出上限、不新增思考字数或固定 API 次数校验。

## 当前请求配置

下面是使用已知 `deepseek-v4-pro`、经当前应用和 Pi 组装的配置。其他模型按各自能力目录处理。

| 调用 | 应用参数 | 当前请求行为 | 核查依据 |
|---|---|---|---|
| P2 第一步目录／疑似组 | reasoning=low | thinking.enabled，reasoning_effort=low | 模型和完整 P2 固定 fetch 测试通过 |
| P2 第二步资料整理 | reasoning=medium | thinking.enabled，reasoning_effort=high | 完整 P2 固定 fetch 测试通过 |
| P2 第三步关系整理 | reasoning=medium | thinking.enabled，reasoning_effort=high | 完整 P2 固定 fetch 测试通过 |
| P3 叙事整理 | 运行器未显式传 reasoning | 默认 DeepSeek 适配路径会发送 thinking.disabled | 运行器、网关和已安装 SDK 分支核对；本次未新增 P3 真实模型验证 |
| 目录外模型 | 即使调用方传 reasoning，能力未被识别 | 不注入未确认的思考参数 | 目录外模型固定 fetch 测试通过 |

[registry.ts](../../../../src/features/models/registry.ts) 为已知 DeepSeek V4 补上 `minimal/low → low`；[runtime.ts](../../../../src/features/agents/runtime.ts) 只对 P2 人物整理显式设置上述档位。SDK 1.0.2 原始目录的 low 和 medium 均为 null，应用只补了 low；medium 仍向上选为 high。DeepSeek 当前[官方映射](https://api-docs.deepseek.com/guides/thinking_mode/)也将 medium 对应到 high，因此这里没有实际独立的中档。

## 尚未处理的路径

1. 正式 Agent 默认输出上限仍是 8192，当前网关没有为这些请求单独配置思考额度与回答额度。low 是推理强度选择，不是“必定在某个秒数内输出工具调用”的保证。
2. P2 连续人物整理、P3 单次请求超时为 120 秒；旧样本约 112 秒，未达到该超时。这个超时不能识别“时间花掉了，但没有业务进展”。
3. `finishTurn` 对无工具调用的回复统一追加“当前任务尚未收到完成确认，请继续处理”。没有为 `stopReason=length` 且仅含 thinking 的结果设置单独分支；满足其他继续条件时仍会再请求模型。
4. 已有重复失败止损检查针对工具错误。纯思考回复没有工具结果，不会触发这项检查。

代码依据：[运行器](../../../../src/features/agents/runtime.ts)的 `finishTurn` 和请求选项、[网关](../../../../src/features/models/gateway.ts)的 `runTurn`。这是当前路径核查；本次未重新产生一条耗时 112 秒的真实响应。

## 检查证据

执行：

```powershell
npm run test:unit -- tests/models.test.ts tests/organization.test.ts tests/agents.test.ts --maxWorkers=2
```

结果：3 文件、107 项通过，耗时 24.79 秒。使用固定 fetch 和隔离数据库。

- [models.test.ts](../../../../tests/models.test.ts)：验证 medium 实际为 high、low 实际保持 low、默认探测关闭思考、目录外模型不猜测能力。
- [organization.test.ts](../../../../tests/organization.test.ts)：完整 P2 请求组装验证第一步 low、第二三步 high。
- [agents.test.ts](../../../../tests/agents.test.ts)：既有运行、工具和恢复相关检查通过；未据此宣称纯思考截断已获得专门处理。
- 只读已安装 Pi 模型目录确认版本对应的原始能力映射；没有读取或输出凭据。
- 文档检查：本地链接与锚点检查、`npm run governance:check`、`npm run openspec -- validate continuous-character-organization --strict`、`git diff --check`通过。

## 后续取舍

如继续修复，建议先单独设计“输出耗尽且未产生工具调用”的处理：识别截断原因、保留已提交结果、明确下一次请求应完成什么，以及连续无进展时怎样暂停恢复。第二、三步是否降低思考强度属于效果与速度的取舍，需要与该处理分别决定。

这些是待确认方向。本次不修改已批准的推理档位、请求次数、输出长度、提示词和恢复行为。BUG-32 沿用原编号；用户实际副本质量与耗时验收仍未完成。
