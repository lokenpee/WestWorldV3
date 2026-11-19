import { execFileSync } from 'node:child_process'
import type { CredentialProtector } from './contracts.ts'

const prefix = 'dpapi-user:v1:'
/** 密钥只经标准输入传给Windows，不进入命令行参数、临时文件或错误日志。 */
export function windowsCredentialProtector(): CredentialProtector {
  if (process.platform !== 'win32') throw new Error('当前本机凭据保存需要Windows用户加密支持。')
  const transform = (input: string, encrypt: boolean) => {
    const action = encrypt ? 'Protect' : 'Unprotect'
    const command = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $data=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $result=[Security.Cryptography.ProtectedData]::${action}($data,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($result))`
    try {
      return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
        input, encoding: 'utf8', windowsHide: true, timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'],
      }).trim()
    } catch { throw new Error(encrypt ? '本机密钥加密保存失败，请重试。' : '无法解密本机密钥，请使用原Windows账户或重新配置密钥。') }
  }
  return {
    protect(value) { return prefix + transform(Buffer.from(value, 'utf8').toString('base64'), true) },
    unprotect(value) {
      if (!value.startsWith(prefix)) throw new Error('不支持的本机凭据格式。')
      return Buffer.from(transform(value.slice(prefix.length), false), 'base64').toString('utf8')
    },
  }
}
