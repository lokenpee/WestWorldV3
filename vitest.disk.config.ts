import { defineConfig } from 'vitest/config'
export default defineConfig({ test: {
  environment: 'node', setupFiles: ['./tests/disk.setup.ts'], maxWorkers: 4,
  include: ['tests/{assets,models,extraction,extraction-controls,world,story,story-reading,organization,world-asset-review,identity-discovery,backup,concurrency,merge,mechanical-queue}.test.ts'],
  // These cases inject native IndexedDB hooks or assert native database enumeration/blocking.
  // They still run in test:unit; equivalent disk failure/recovery checks are in local-storage-integration.
  testNamePattern: /^(?!.*(?:损坏ZIP、缺文件|登记删除后失败|原生连接阻塞删库|单项模型异常及结果约束失败|资产写入失败时资产|资产与队列确认同事务|统计失败保留收尾|报告写入失败时人物|连续三次心跳只暂时|人物资料提交前发生快照冲突)).*$/,
} })
