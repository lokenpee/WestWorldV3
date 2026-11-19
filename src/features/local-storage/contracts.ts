/** 本机存储接口：业务JSON与原业务revision原样保留，version用于存储层并发检查。 */
export type StoredValue = Record<string, unknown>
export interface StoredRecord { key: string; value: StoredValue; version: number }
export interface RecordAddress { scope: string; table: string; key: string }
export interface RecordWrite extends RecordAddress { value?: StoredValue; expectedVersion?: number | null }
export interface RecordPage { records: StoredRecord[]; nextKey?: string }
export interface CredentialProtector { protect(value: string): string; unprotect(value: string): string }
export type StorageCategory = 'business' | 'observation' | 'lease' | 'run' | 'merge' | 'history'
export interface StorageTarget { scope: string; table?: string; category?: StorageCategory }
export interface StorageNotice { epoch: string; revision: number; targets: StorageTarget[] }
export interface StorageInterest { scope: string; tables?: readonly string[]; category?: StorageCategory }
export interface StorageStatus { dataDirectory: string; schemaVersion: number; revision: number; lastSavedAt?: string; lastBackupAt?: string; backupError?: string; epoch?: string; change?: StorageNotice; notices?: StorageNotice[]; reset?: boolean }

export class StorageConflict extends Error {
  constructor() { super('CONFLICT:资料已被其他操作修改，请重新读取后保存。'); this.name = 'StorageConflict' }
}
