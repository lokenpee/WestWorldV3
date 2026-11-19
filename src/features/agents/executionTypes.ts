/** 请求回放的只读 JSON 数据；浏览器和本机查询共用，不依赖存储实现。 */
export type ExecutionRow = Record<string, unknown>
export interface ExecutionData { entries: ExecutionRow[]; requests: ExecutionRow[]; snapshots: Map<string, ExecutionRow> }
