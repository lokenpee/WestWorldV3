> 2.1历史工具字段/回放说明；不得覆盖2.2单层实体和新阶段规则。

# WestWorld V2 · AI工具返回与交互回放

| 文档控制项 | 内容 |
|---|---|
| 文档编号 | WW-TOOLS |
| 文档版本 | 2.1 |
| 产品 / 应用包版本 | WestWorld V2 / 1.0.0 |
| 复现基线 | WWV2-WORKTREE-20261021；实际工作区含未提交文件 |
| 文档状态 | 待评审；用户已确认忠实保留行为与缺陷 |
| 编写 / 维护 | Codex；后续维护负责人待指定 |
| 创建 / 更新 | 2026-10-21 / 2026-10-21（Asia/Shanghai） |
| 适用范围 | 当前工作区可达应用；不包含未来游玩功能 |
| 共同术语 / 关联 | [统一入口](../00-阅读入口与术语.md)、[PRD](../01-PRD.md)、[覆盖矩阵](../12-验收执行与覆盖矩阵.md) |

### 修订记录

| 版本 | 日期 | 内容 | 影响 |
|---|---|---|---|
| 2.0 | 2026-10-21 | 建立正式规格包 | 保留历史约束 |
| 2.1 | 2026-10-21 | 按17种实际表、操作链、字段流及独立验收补全 | 不改变应用行为；校正覆盖结论 |

## 1. 输入、输出与执行边界

系统有13个只读工具，其中资产整理只允许前8个，故事编辑允许全部13个。每个参数结构来自实际声明；本文件补齐原声明没有returns的成功形状和各分支，机器契约见`tool-results.schema.json`。

**这些补充输出Schema是重建说明与验收契约，不表示原运行时对13个工具都执行返回校验。** 原实现仅对3个声明returns的记忆工具校验返回；不得擅自扩大。人工弱校验可使原必填文本省略，因此普通读取结构保留缺字段的兼容分支。

通用分页：data、totalCount、truncated、nextOffset。一般offset0/limit100，再受工具maxResults限制。单行过大可替为{id?,fields_omitted:['oversized_detail'],hint}；累计正文约64512字节停止，Agent最终65536字节限制。页面总数为匹配集合数，nextOffset基于已返回条数。

错误对象：ABORTED（预取消）、INVALID_ARGS（参数结构错）、TOO_LARGE（Agent包装层超限）、INTERNAL（原有声明返回结构不符）、NOT_FOUND（历史条目不属于选择会话）。这些分支不都由每个工具直接生成；原本不支持某分支的工具不得新增业务失败规则。

提供不存在/归档错误session等内部条件时，部分工具可抛Error而不是返回error对象，须按原边界处理。不得把所有throw统一改成成功空页。

## 2. 逐工具参数与返回

### TOOL-01 · query_nodes

检索事件节点摘要。支持章节、人物、事件线过滤和 offset 分页；细节用 get_node_detail。

- 条数上限：200；字节上限65536；运行时返回Schema校验：无（不要新增）。
- 输入JSON Schema：

```json
{
  "additionalProperties": false,
  "type": "object",
  "properties": {
    "chapter_range": {
      "minItems": 2,
      "maxItems": 2,
      "description": "恰好两个字符串：[起始章节, 结束章节]。",
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "actor": {
      "type": "string"
    },
    "event_line_id": {
      "type": "string"
    },
    "offset": {
      "minimum": 0,
      "type": "integer"
    },
    "limit": {
      "minimum": 1,
      "maximum": 200,
      "type": "integer"
    }
  }
}
```
- 确定性成功输入与原边界输出（前置完整记录见tool-response-examples.json的seed）：

```json
{
  "args": {},
  "result": {
    "data": [
      {
        "id": "C1-N001",
        "name": "码头会面",
        "summary": "沈青在码头见到顾衡。",
        "actors": [
          "沈青",
          "顾衡"
        ],
        "chapterIndex": "1"
      },
      {
        "id": "C1-N002",
        "name": "交付书信",
        "summary": "顾衡将信交给沈青。",
        "actors": [
          "顾衡",
          "沈青"
        ],
        "chapterIndex": "1"
      }
    ],
    "totalCount": 2,
    "truncated": false,
    "nextOffset": null
  }
}
```
- 参数错误样例：

```json
{
  "input": {
    "unsupported_parameter": true
  },
  "output": {
    "error": "INVALID_ARGS",
    "message": "/unsupported_parameter: Unexpected property"
  }
}
```

成功返回结构在`tool-results.schema.json`同名项；空/分页/截断语义按AI-06，不能仅凭本例数据项数推断容量。
### TOOL-02 · get_node_detail

按 ID 读取节点详情，包含原文摘录与完整事件字段。

- 条数上限：20；字节上限65536；运行时返回Schema校验：无（不要新增）。
- 输入JSON Schema：

```json
{
  "additionalProperties": false,
  "type": "object",
  "required": [
    "ids"
  ],
  "properties": {
    "ids": {
      "minItems": 1,
      "maxItems": 20,
      "type": "array",
      "items": {
        "type": "string"
      }
    }
  }
}
```
- 确定性成功输入与原边界输出（前置完整记录见tool-response-examples.json的seed）：

```json
{
  "args": {
    "ids": [
      "C1-N001"
    ]
  },
  "result": {
    "data": [
      {
        "id": "C1-N001",
        "bookId": "bk_acceptance",
        "chapterIndex": "1",
        "chapterName": "第一章 码头会面",
        "order": 0,
        "name": "码头会面",
        "summary": "沈青在码头见到顾衡。",
        "process": "沈青在码头见到顾衡。",
        "quote": "沈青在码头见到顾衡。",
        "actors": [
          "沈青",
          "顾衡"
        ],
        "confidence": 1,
        "createdBy": "P1",
        "eventLineIds": [
          "L01"
        ]
      }
    ],
    "totalCount": 1,
    "truncated": false,
    "nextOffset": null
  }
}
```
- 参数错误样例：

```json
{
  "input": {
    "ids": [
      "C1-N001"
    ],
    "unsupported_parameter": true
  },
  "output": {
    "error": "INVALID_ARGS",
    "message": "/unsupported_parameter: Unexpected property"
  }
}
```

成功返回结构在`tool-results.schema.json`同名项；空/分页/截断语义按AI-06，不能仅凭本例数据项数推断容量。
### TOOL-03 · query_event_lines

检索事件线摘要。确认跨窗口是否同一件事；详情用 get_event_line_detail。

- 条数上限：50；字节上限65536；运行时返回Schema校验：无（不要新增）。
- 输入JSON Schema：

```json
{
  "additionalProperties": false,
  "type": "object",
  "properties": {
    "chapter_range": {
      "minItems": 2,
      "maxItems": 2,
      "description": "恰好两个字符串：[起始章节, 结束章节]。",
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "character": {
      "type": "string"
    },
    "name_like": {
      "type": "string"
    },
    "status": {
      "anyOf": [
        {
          "const": "open",
          "type": "string"
        },
        {
          "const": "closed",
          "type": "string"
        }
      ]
    },
    "offset": {
      "minimum": 0,
      "type": "integer"
    },
    "limit": {
      "minimum": 1,
      "maximum": 200,
      "type": "integer"
    }
  }
}
```
- 确定性成功输入与原边界输出（前置完整记录见tool-response-examples.json的seed）：

```json
{
  "args": {},
  "result": {
    "data": [
      {
        "id": "L01",
        "title": "书信交付",
        "chapters": [
          "1"
        ],
        "lineStatus": "closed",
        "cause": "双方会面",
        "result": "书信交付完成",
        "nodeCount": 2
      }
    ],
    "totalCount": 1,
    "truncated": false,
    "nextOffset": null
  }
}
```
- 参数错误样例：

```json
{
  "input": {
    "unsupported_parameter": true
  },
  "output": {
    "error": "INVALID_ARGS",
    "message": "/unsupported_parameter: Unexpected property"
  }
}
```

成功返回结构在`tool-results.schema.json`同名项；空/分页/截断语义按AI-06，不能仅凭本例数据项数推断容量。
### TOOL-04 · get_event_line_detail

按 ID 读取完整事件线，核对成员与连贯性。

- 条数上限：10；字节上限65536；运行时返回Schema校验：无（不要新增）。
- 输入JSON Schema：

```json
{
  "additionalProperties": false,
  "type": "object",
  "required": [
    "ids"
  ],
  "properties": {
    "ids": {
      "minItems": 1,
      "maxItems": 20,
      "type": "array",
      "items": {
        "type": "string"
      }
    }
  }
}
```
- 确定性成功输入与原边界输出（前置完整记录见tool-response-examples.json的seed）：

```json
{
  "args": {
    "ids": [
      "L01"
    ]
  },
  "result": {
    "data": [
      {
        "id": "L01",
        "bookId": "bk_acceptance",
        "title": "书信交付",
        "nodeIds": [
          "C1-N001",
          "C1-N002"
        ],
        "chapters": [
          "1"
        ],
        "cause": "双方会面",
        "process": "顾衡交信，沈青离开",
        "result": "书信交付完成",
        "lineStatus": "closed",
        "characterIds": [],
        "updatedAt": "2026-10-21T00:00:00.000Z"
      }
    ],
    "totalCount": 1,
    "truncated": false,
    "nextOffset": null
  }
}
```
- 参数错误样例：

```json
{
  "input": {
    "ids": [
      "L01"
    ],
    "unsupported_parameter": true
  },
  "output": {
    "error": "INVALID_ARGS",
    "message": "/unsupported_parameter: Unexpected property"
  }
}
```

成功返回结构在`tool-results.schema.json`同名项；空/分页/截断语义按AI-06，不能仅凭本例数据项数推断容量。
### TOOL-05 · query_characters

查询草稿人物主名、全部别名与身份；判定是否同人，不能仅凭同姓合并。

- 条数上限：100；字节上限65536；运行时返回Schema校验：无（不要新增）。
- 输入JSON Schema：

```json
{
  "additionalProperties": false,
  "type": "object",
  "properties": {
    "name_like": {
      "type": "string"
    },
    "offset": {
      "minimum": 0,
      "type": "integer"
    },
    "limit": {
      "minimum": 1,
      "maximum": 200,
      "type": "integer"
    }
  }
}
```
- 确定性成功输入与原边界输出（前置完整记录见tool-response-examples.json的seed）：

```json
{
  "args": {},
  "result": {
    "data": [
      {
        "id": "C1-P001",
        "name": "沈青",
        "aliases": [],
        "identity": "人工验证样本人物",
        "sourceChapters": [
          "1"
        ]
      },
      {
        "id": "C1-P002",
        "name": "顾衡",
        "aliases": [],
        "identity": "人工验证样本人物",
        "sourceChapters": [
          "1"
        ]
      },
      {
        "id": "C1-P003",
        "name": "阿宁",
        "aliases": [],
        "identity": "人工验证样本人物",
        "sourceChapters": [
          "1"
        ]
      }
    ],
    "totalCount": 3,
    "truncated": false,
    "nextOffset": null
  }
}
```
- 参数错误样例：

```json
{
  "input": {
    "unsupported_parameter": true
  },
  "output": {
    "error": "INVALID_ARGS",
    "message": "/unsupported_parameter: Unexpected property"
  }
}
```

成功返回结构在`tool-results.schema.json`同名项；空/分页/截断语义按AI-06，不能仅凭本例数据项数推断容量。
### TOOL-06 · get_character_detail

读取人物草稿完整档案、关系与冲突信息。

- 条数上限：20；字节上限65536；运行时返回Schema校验：无（不要新增）。
- 输入JSON Schema：

```json
{
  "additionalProperties": false,
  "type": "object",
  "required": [
    "ids"
  ],
  "properties": {
    "ids": {
      "minItems": 1,
      "maxItems": 20,
      "type": "array",
      "items": {
        "type": "string"
      }
    }
  }
}
```
- 确定性成功输入与原边界输出（前置完整记录见tool-response-examples.json的seed）：

```json
{
  "args": {
    "ids": [
      "C1-P001"
    ]
  },
  "result": {
    "data": [
      {
        "id": "C1-P001",
        "bookId": "bk_acceptance",
        "chapterIndex": "1",
        "chapterName": "第一章 码头会面",
        "name": "沈青",
        "confidence": 1,
        "identity": "人工验证样本人物",
        "roleWeight": "NPC",
        "aliases": []
      }
    ],
    "totalCount": 1,
    "truncated": false,
    "nextOffset": null
  }
}
```
- 参数错误样例：

```json
{
  "input": {
    "ids": [
      "C1-P001"
    ],
    "unsupported_parameter": true
  },
  "output": {
    "error": "INVALID_ARGS",
    "message": "/unsupported_parameter: Unexpected property"
  }
}
```

成功返回结构在`tool-results.schema.json`同名项；空/分页/截断语义按AI-06，不能仅凭本例数据项数推断容量。
### TOOL-07 · query_locations

查询地点与别名，区分同一地点、内部区域和相邻地点。

- 条数上限：100；字节上限65536；运行时返回Schema校验：无（不要新增）。
- 输入JSON Schema：

```json
{
  "additionalProperties": false,
  "type": "object",
  "properties": {
    "name_like": {
      "type": "string"
    },
    "offset": {
      "minimum": 0,
      "type": "integer"
    },
    "limit": {
      "minimum": 1,
      "maximum": 200,
      "type": "integer"
    }
  }
}
```
- 确定性成功输入与原边界输出（前置完整记录见tool-response-examples.json的seed）：

```json
{
  "args": {},
  "result": {
    "data": [
      {
        "id": "C1-L001",
        "bookId": "bk_acceptance",
        "chapterIndex": "1",
        "chapterName": "第一章 码头会面",
        "name": "码头",
        "confidence": 1,
        "description": "人工验证样本地点",
        "aliases": []
      },
      {
        "id": "C1-L002",
        "bookId": "bk_acceptance",
        "chapterIndex": "1",
        "chapterName": "第一章 码头会面",
        "name": "书铺",
        "confidence": 1,
        "description": "人工验证样本地点",
        "aliases": []
      }
    ],
    "totalCount": 2,
    "truncated": false,
    "nextOffset": null
  }
}
```
- 参数错误样例：

```json
{
  "input": {
    "unsupported_parameter": true
  },
  "output": {
    "error": "INVALID_ARGS",
    "message": "/unsupported_parameter: Unexpected property"
  }
}
```

成功返回结构在`tool-results.schema.json`同名项；空/分页/截断语义按AI-06，不能仅凭本例数据项数推断容量。
### TOOL-08 · read_original

读取章节原文核实称呼或补断点。返回受字数、字节上限约束，使用 offset 继续读取。

- 条数上限：200；字节上限65536；运行时返回Schema校验：无（不要新增）。
- 输入JSON Schema：

```json
{
  "additionalProperties": false,
  "type": "object",
  "required": [
    "chapter_range"
  ],
  "properties": {
    "chapter_range": {
      "minItems": 2,
      "maxItems": 2,
      "description": "恰好两个字符串：[起始章节, 结束章节]。",
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "offset": {
      "minimum": 0,
      "type": "integer"
    },
    "maxChars": {
      "minimum": 1,
      "maximum": 200000,
      "type": "integer"
    }
  }
}
```
- 确定性成功输入与原边界输出（前置完整记录见tool-response-examples.json的seed）：

```json
{
  "args": {
    "chapter_range": [
      "1",
      "1"
    ],
    "maxChars": 12
  },
  "result": {
    "text": "\n【章节 1：第一章 码",
    "totalChars": 45,
    "truncated": true,
    "nextOffset": 12
  }
}
```
- 参数错误样例：

```json
{
  "input": {
    "chapter_range": [
      "1",
      "1"
    ],
    "maxChars": 12,
    "unsupported_parameter": true
  },
  "output": {
    "error": "INVALID_ARGS",
    "message": "/unsupported_parameter: Unexpected property"
  }
}
```

成功返回结构在`tool-results.schema.json`同名项；空/分页/截断语义按AI-06，不能仅凭本例数据项数推断容量。
### TOOL-09 · get_editor_memory

读取当前故事会话的工作记忆；提供 session_id 可回查本书旧会话。历史记录不是本轮已通过的结论。

- 条数上限：10；字节上限65536；运行时返回Schema校验：有（按原returns）。
- 输入JSON Schema：

```json
{
  "additionalProperties": false,
  "type": "object",
  "properties": {
    "session_id": {
      "type": "string"
    }
  }
}
```
- 确定性成功输入与原边界输出（前置完整记录见tool-response-examples.json的seed）：

```json
{
  "args": {
    "session_id": "session_example"
  },
  "result": {
    "memory": {
      "id": "session_example",
      "bookId": "bk_acceptance",
      "sessionId": "session_example",
      "revision": 1,
      "workingSummary": "已核对第一章。",
      "dataFingerprint": "example-fingerprint",
      "updatedAt": "2000-01-01T00:00:00.000Z"
    },
    "dataChanged": true,
    "pendingCount": 0,
    "staleCount": 1,
    "notes": [
      {
        "id": "SN000001",
        "key": "会面",
        "kind": "decision",
        "status": "active",
        "statement": "会面属于书信交付线。",
        "nodeIds": [
          "C1-N001"
        ],
        "lineIds": [
          "L01"
        ],
        "validity": "stale",
        "truncated": false
      }
    ],
    "recentCheckpoints": [
      {
        "id": "example-checkpoint-hash",
        "stage": "P2",
        "phase": "link",
        "status": "completed",
        "scopeCount": 1,
        "updatedAt": "2000-01-01T00:00:00.000Z"
      }
    ]
  }
}
```
- 参数错误样例：

```json
{
  "input": {
    "session_id": "session_example",
    "unsupported_parameter": true
  },
  "output": {
    "error": "INVALID_ARGS",
    "message": "/unsupported_parameter: Unexpected property"
  }
}
```

成功返回结构在`tool-results.schema.json`同名项；空/分页/截断语义按AI-06，不能仅凭本例数据项数推断容量。
### TOOL-10 · query_editor_notes

查询已确认判断、待复核或已解决事项，按节点/事件线定位。过期结论不得直接沿用，核实后通过提交结果更新。

- 条数上限：50；字节上限65536；运行时返回Schema校验：有（按原returns）。
- 输入JSON Schema：

```json
{
  "additionalProperties": false,
  "type": "object",
  "properties": {
    "kind": {
      "anyOf": [
        {
          "const": "decision",
          "type": "string"
        },
        {
          "const": "review",
          "type": "string"
        }
      ]
    },
    "session_id": {
      "type": "string"
    },
    "key": {
      "maxLength": 120,
      "type": "string"
    },
    "status": {
      "anyOf": [
        {
          "const": "active",
          "type": "string"
        },
        {
          "const": "resolved",
          "type": "string"
        },
        {
          "const": "stale",
          "type": "string"
        }
      ]
    },
    "node_id": {
      "type": "string"
    },
    "line_id": {
      "type": "string"
    },
    "offset": {
      "minimum": 0,
      "type": "integer"
    },
    "limit": {
      "minimum": 1,
      "maximum": 200,
      "type": "integer"
    }
  }
}
```
- 确定性成功输入与原边界输出（前置完整记录见tool-response-examples.json的seed）：

```json
{
  "args": {
    "session_id": "session_example"
  },
  "result": {
    "data": [
      {
        "id": "SN000001",
        "bookId": "bk_acceptance",
        "sessionId": "session_example",
        "revision": 1,
        "stage": "P2",
        "key": "会面",
        "kind": "decision",
        "status": "active",
        "statement": "会面属于书信交付线。",
        "nodeIds": [
          "C1-N001"
        ],
        "lineIds": [
          "L01"
        ],
        "evidence": [],
        "basisFingerprint": "example-fingerprint",
        "createdAt": "2000-01-01T00:00:00.000Z",
        "updatedAt": "2000-01-01T00:00:00.000Z",
        "validity": "stale"
      }
    ],
    "totalCount": 1,
    "truncated": false,
    "nextOffset": null
  }
}
```
- 参数错误样例：

```json
{
  "input": {
    "session_id": "session_example",
    "unsupported_parameter": true
  },
  "output": {
    "error": "INVALID_ARGS",
    "message": "/unsupported_parameter: Unexpected property"
  }
}
```

成功返回结构在`tool-results.schema.json`同名项；空/分页/截断语义按AI-06，不能仅凭本例数据项数推断容量。
### TOOL-11 · get_editor_note_detail

读取工作记录详情；提供 session_id 可读本书旧会话记录。只读。

- 条数上限：20；字节上限65536；运行时返回Schema校验：有（按原returns）。
- 输入JSON Schema：

```json
{
  "additionalProperties": false,
  "type": "object",
  "required": [
    "ids"
  ],
  "properties": {
    "ids": {
      "minItems": 1,
      "maxItems": 20,
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "session_id": {
      "type": "string"
    }
  }
}
```
- 确定性成功输入与原边界输出（前置完整记录见tool-response-examples.json的seed）：

```json
{
  "args": {
    "ids": [
      "SN000001"
    ],
    "session_id": "session_example"
  },
  "result": {
    "data": [
      {
        "id": "SN000001",
        "bookId": "bk_acceptance",
        "sessionId": "session_example",
        "revision": 1,
        "stage": "P2",
        "key": "会面",
        "kind": "decision",
        "status": "active",
        "statement": "会面属于书信交付线。",
        "nodeIds": [
          "C1-N001"
        ],
        "lineIds": [
          "L01"
        ],
        "evidence": [],
        "basisFingerprint": "example-fingerprint",
        "createdAt": "2000-01-01T00:00:00.000Z",
        "updatedAt": "2000-01-01T00:00:00.000Z",
        "validity": "stale"
      }
    ],
    "totalCount": 1,
    "truncated": false,
    "nextOffset": null
  }
}
```
- 参数错误样例：

```json
{
  "input": {
    "ids": [
      "SN000001"
    ],
    "session_id": "session_example",
    "unsupported_parameter": true
  },
  "output": {
    "error": "INVALID_ARGS",
    "message": "/unsupported_parameter: Unexpected property"
  }
}
```

成功返回结构在`tool-results.schema.json`同名项；空/分页/截断语义按AI-06，不能仅凭本例数据项数推断容量。
### TOOL-12 · list_editor_sessions

列出本书当前及历史故事会话，供回查旧复核过程。不能查询其他书。

- 条数上限：50；字节上限65536；运行时返回Schema校验：无（不要新增）。
- 输入JSON Schema：

```json
{
  "additionalProperties": false,
  "type": "object",
  "properties": {
    "offset": {
      "minimum": 0,
      "type": "integer"
    },
    "limit": {
      "minimum": 1,
      "maximum": 200,
      "type": "integer"
    }
  }
}
```
- 确定性成功输入与原边界输出（前置完整记录见tool-response-examples.json的seed）：

```json
{
  "args": {},
  "result": {
    "data": [
      {
        "id": "session_example",
        "title": "初次故事编辑",
        "kind": "initial",
        "status": "active",
        "entryCount": 1,
        "createdAt": "2000-01-01T00:00:00.000Z",
        "updatedAt": "2000-01-01T00:00:00.000Z"
      }
    ],
    "totalCount": 1,
    "truncated": false,
    "nextOffset": null
  }
}
```
- 参数错误样例：

```json
{
  "input": {
    "unsupported_parameter": true
  },
  "output": {
    "error": "INVALID_ARGS",
    "message": "/unsupported_parameter: Unexpected property"
  }
}
```

成功返回结构在`tool-results.schema.json`同名项；空/分页/截断语义按AI-06，不能仅凭本例数据项数推断容量。
### TOOL-13 · query_editor_session_history

回查本书完整原始会话。默认摘要预览，mode=full 取完整记录；超长单条用 entry_id/char_offset/maxChars 分段。压缩不会删除原始消息，旧会话仅供历史参考。

- 条数上限：50；字节上限65536；运行时返回Schema校验：无（不要新增）。
- 输入JSON Schema：

```json
{
  "additionalProperties": false,
  "type": "object",
  "properties": {
    "session_id": {
      "type": "string"
    },
    "offset": {
      "minimum": 0,
      "type": "integer"
    },
    "limit": {
      "minimum": 1,
      "maximum": 200,
      "type": "integer"
    },
    "mode": {
      "anyOf": [
        {
          "const": "summary",
          "type": "string"
        },
        {
          "const": "full",
          "type": "string"
        }
      ]
    },
    "entry_id": {
      "type": "string"
    },
    "char_offset": {
      "minimum": 0,
      "type": "integer"
    },
    "maxChars": {
      "minimum": 1,
      "maximum": 20000,
      "type": "integer"
    }
  }
}
```
- 确定性成功输入与原边界输出（前置完整记录见tool-response-examples.json的seed）：

```json
{
  "args": {
    "session_id": "session_example",
    "mode": "full"
  },
  "result": {
    "data": [
      {
        "id": "entry_example",
        "bookId": "bk_acceptance",
        "sessionId": "session_example",
        "ordinal": 0,
        "parentId": null,
        "createdAt": "2000-01-01T00:00:00.000Z",
        "type": "message",
        "message": {
          "role": "user",
          "content": "核对第一章。",
          "timestamp": 946684800000
        }
      }
    ],
    "totalCount": 1,
    "truncated": false,
    "nextOffset": null
  }
}
```
- 参数错误样例：

```json
{
  "input": {
    "session_id": "session_example",
    "mode": "full",
    "unsupported_parameter": true
  },
  "output": {
    "error": "INVALID_ARGS",
    "message": "/unsupported_parameter: Unexpected property"
  }
}
```

成功返回结构在`tool-results.schema.json`同名项；空/分页/截断语义按AI-06，不能仅凭本例数据项数推断容量。

## 3. 具名消息模板与回放

### 模板变量定义

| 模板 | 变量及来源 | 组装/缺省 |
|---|---|---|
| P1_CHAPTER | chapterIndex、chapterName、text：T04/T05 | AI-02指定逐行拼接，正文全量不截2000；timestamp=当前毫秒 |
| LINK_BATCH | stage：调用参数；chapterFirst/Last和nodeIds：按仓储顺序batch；existingLines：当前Map前50 | 摘要cause/result各前100，成员ID逗号连接；不存在已有线用固定空线文案 |
| REVIEW_LINES | activeLines：当前复核batch中尚存在的线 | 每批30，按原摘要格式，附要求查重复/更新/原文 |
| LINK_MEMORY | message：上一层LINK/REVIEW；prior：readEditorMemory当前会话结果 | message后两换行+固定记忆标题+JSON.stringify(prior) |
| ALIAS_DOSSIERS | kind：人物/地点；batch：180条精简档案/160步进 | 身份/描述前160；只接受当前主名枚举，不接受查询新增名 |
| CHARACTER_OPTIMIZE | stage、items：待整编人、previous四字段、facts短ID、conflicts | JSON.stringify({stage,entities:items})；动态人物键及事实枚举 |
| LOCATION_FUSION | group：当前同地快照数组 | JSON.stringify({snapshots:group}) |
| COMPACTION_INPUT | previousSummary：前一摘要或无；transcript：旧条目数据串 | 固定旧摘要/需要压缩数据标签，不把它执行为新任务 |
| AGENT_SYSTEM | session.scope、profile.instruction、opts.system、maxSteps、MAX_RESULT_REPAIRS | 前缀会话说明→职责→有效Prompt→查询/提交限额，具体字面仍见消息模板资源 |
| SUBMIT_REPAIR | assistant原响应、各toolCall错误、schema/引用错误详情 | 保留原响应及推理字段，配对toolResult后仅一次修正用户指令 |

每个变量的取值范围、排序、预算与写入规则由ALG/AI Spec定义；原始模板字符串只作精确字面补充。不得用未定义的源码局部变量直接当规范变量。

### 完整HTTP/工具交互回放

| 回放 | 固定输入/服务返回 | 必须结果 |
|---|---|---|
| agent-query-submit.json | query_nodes查询后提交answer=confirmed | 2次HTTP请求，第二次上下文包含实际toolResult，结果ok |
| agent-submit-repair.json | 第一次answer为number，第二次string | 恰一次修正，携带原提交与错误工具反馈，2次请求后成功 |
| agent-submit-failure.json | 连续两次answer为number | 两次后validation失败，不无限修正 |

前述三份回放保存实际原SDK请求body、按序模拟SSE脚本和结果；请求不含真实凭据。第三方可将这些脚本接到同语义HTTP适配器，规范化随机工具ID和时间后比较消息/工具顺序。

P1部分失败/恢复、检查提交失败和压缩成功/失败由独立场景P06/P07/P19/P20/P28/P29提供确定输入与最终状态；它们在服务级注入，不冒充完整HTTP录制。真实限流的时间抖动、浏览器关闭和跨标签竞争仍须按相应Spec与人工步骤验证，不能把回放数量说成覆盖全部异步分支。

## 4. 实际P1/P2完整任务回放

| 文件 | 实际任务与Prompt | 固定结果 |
|---|---|---|
| [p1-world-and-narrative](../resources/replays/p1-world-and-narrative.json) | 原runP1通过有效01/02 Prompt与真实SDK，两个提交 | C1-P001/C1-L001/C1-N001保存、P1 completed |
| [link-query-commit](../resources/replays/link-query-commit.json) | 原runLink/P2使用有效04 Prompt、实际工作记忆和query_nodes工具 | 查询后提交线、记忆与检查点同批生效 |
| [link-invalid-repair](../resources/replays/link-invalid-repair.json) | 原P2第一次提交MISSING节点、第二次定向修正 | 仅一次修正，正确成员入库，memory.revision=1 |

P33/P34/P35给实际输入及持久断言，6份HTTP回放中前3份验证通用Agent边界、本节3份验证有效应用任务。所有网络响应均测试拦截，没有真实模型调用。其他尚未回放的时序依12的验证范围，不因增加3例宣称全覆盖。
