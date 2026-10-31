type OwnerMessage = { kind: 'probe' | 'alive'; owner: string; request: string }

export function createImportOwnership(namespace: string) {
  const active = new Set<string>()
  const channel = typeof BroadcastChannel === 'undefined' ? undefined : new BroadcastChannel(`westworld-import:${namespace}`)
  const waiting = new Map<string, () => void>()
  if (channel) channel.onmessage = (event: MessageEvent<OwnerMessage>) => {
    const message = event.data
    if (!message || typeof message.owner !== 'string' || typeof message.request !== 'string') return
    if (message.kind === 'probe' && active.has(message.owner)) channel.postMessage({ ...message, kind: 'alive' })
    if (message.kind === 'alive') waiting.get(message.request)?.()
  }
  return {
    activate: (owner: string) => { active.add(owner) },
    release: (owner: string) => { active.delete(owner) },
    async isAlive(owner: string) {
      if (active.has(owner)) return true
      if (!channel) return false // The caller has already waited for lease expiry.
      return new Promise<boolean>(resolve => {
        const request = crypto.randomUUID()
        const finish = (alive: boolean) => { clearTimeout(timer); waiting.delete(request); resolve(alive) }
        const timer = setTimeout(() => finish(false), 200)
        waiting.set(request, () => finish(true))
        channel.postMessage({ kind: 'probe', owner, request })
      })
    },
    close() { channel?.close(); active.clear() },
  }
}
