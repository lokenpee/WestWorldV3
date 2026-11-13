import discipline from '../../../docs/v2/resources/v2.2/prompts/active/output-discipline.txt?raw'
import type { Context } from '@earendil-works/pi-ai'

/** 所有模型请求共用的文学资料处理说明，正文只在资源文件维护。 */
export const outputDiscipline = discipline.trim()

/** 在实际发送前追加到系统提示末尾，不修改原上下文或重复追加。 */
export function withContextDiscipline(context: Context): Context {
  const clean = (value: string) => value.replaceAll(outputDiscipline, '').trimEnd()
  const messages = context.messages.map(message => message.role !== 'system' ? message : {
    ...message,
    content: typeof message.content === 'string' ? clean(message.content) : message.content.map(part => ({ ...part, text: clean(part.text) })),
    ...(message.sections ? { sections: Object.fromEntries(Object.entries(message.sections).filter(([name]) => name !== 'literary-materials')) } : {}),
  })
  const last = messages.findLastIndex(message => message.role === 'system')
  const systemPrompt = context.systemPrompt === undefined ? undefined : clean(context.systemPrompt)
  if (last < 0) return { ...context, messages, systemPrompt: [systemPrompt, outputDiscipline].filter(Boolean).join('\n\n') }
  const message = messages[last]
  if (message.role === 'system') {
    if (messages.some(row => row.role === 'system' && Object.keys(row.sections ?? {}).length)) message.sections = { ...message.sections, 'literary-materials': outputDiscipline }
    else message.content = typeof message.content === 'string' ? [message.content, outputDiscipline].filter(Boolean).join('\n\n') : [...message.content, { type: 'text', text: outputDiscipline }]
  }
  return { ...context, messages, ...(systemPrompt === undefined ? {} : { systemPrompt }) }
}
