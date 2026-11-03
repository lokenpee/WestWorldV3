# 文档维护脚本

validate-v2.2.py是当前文档校验器，只读检查正文/JSON并写文档验证报告，不执行应用测试。

其余write-*、complete-*、finalize-2.1、extract/verify旧脚本面向2.0/2.1取证和生成，保留历史用途；不能直接运行来覆盖2.2主文档或用其结果证明新流程正确。更新2.2应同步主文档与resources/v2.2契约，按版本维护resource-manifest。

2026-10-23补充：expand-data-dictionary.py、expand-tool-dictionary.py、finalize-field-tool-clarification.py维护字段/工具章节；它们会重写对应生成区，运行前须核对后续人工修订。validate-expanded-contracts.mjs做结构/样例/哈希检查，不执行应用。audit-reconstructability.py清点十种Prompt调用和缺失绑定，首次保存审查前证据，后续不覆盖该证据；清单标partial不能当完整Prompt包。重建审查结论以12的RQ条目为准。

2026-10-24起上述三个旧展开/审查生成器默认写保护；当前维护顺序为close-requirement-gaps.py→build-request-examples.mjs→build-recovery-cases.py→finalize-gap-clarification.py，再运行validate-gap-contracts.mjs及validate-v2.2.py。close脚本会重建active Prompt、机器契约及03第10节生成区，编辑这些内容时必须同步生成源；它不会修改应用。

validate-gap-contracts仅检查文档契约、完整请求夹具、端口编译和runner接口，不执行6项恢复集成用例；真正执行用resources/v2.2/acceptance/run.mjs连接重建应用。不要运行旧finalize-field-tool-clarification.py把模型声明重新覆盖成旧的“未定义”状态。人工正文算法/界面/闭合表需同步维护，不由这些机械脚本自动证明完整。


缺陷优先修复策略生效后，生成请求夹具前必须在旧补全生成链之后运行specify-bug-fixes.py、write-fix-first-spec.py、finalize-bugfix-spec.py；再运行build-request-examples.mjs、build-bugfix-cases.py及三类validate脚本。specify会为旧恢复夹具补当前证据字段；若先重新生成recovery-cases，必须再应用specify。当前修复规则不能被旧生成器覆盖回“保留BUG”。资源更新后重算resource-manifest，旧取证文件保持不动。
