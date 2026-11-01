import discipline from '../../../docs/v2/resources/v2.2/prompts/active/output-discipline.txt?raw'

/** 所有模型请求共用的输出纪律正文；业务Prompt文件不重复保存这段文字。 */
export const outputDiscipline = discipline.trim()

/** 在业务正文之后追加输出纪律，保持业务正文原样。 */
export const withOutputDiscipline = (prompt: string) => `${prompt.trimEnd()}\n\n${outputDiscipline}\n`
