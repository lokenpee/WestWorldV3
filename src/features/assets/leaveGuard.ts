type Guard = (next: () => void) => void
let guard: Guard | undefined

/** 人物工作台注册未保存修改的统一切换入口；其他页面通过 requestLeave 走同一保护。 */
export function setLeaveGuard(next: Guard | undefined) { guard = next }
export function requestLeave(next: () => void) { if (guard) guard(next); else next() }
