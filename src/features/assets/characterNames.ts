import type { Fact } from './types'

// 完整词匹配保留“林姑父”“宋皇后”等带限定的称呼。
const contextualNames = new Set([
  '爸爸', '妈妈', '父亲', '母亲', '爹', '娘', '爹爹', '爹娘', '父母', '父母亲', '阿爹', '阿娘', '老爹', '老妈', '父亲大人', '母亲大人',
  '父皇', '母后', '父王', '母妃', '祖父', '祖母', '爷爷', '奶奶', '外公', '外婆', '外祖父', '外祖母',
  '叔叔', '伯父', '伯伯', '叔父', '婶婶', '婶娘', '伯母', '姑姑', '姑母', '姑父', '姑丈', '舅舅', '舅父', '舅母', '舅妈', '姨妈', '姨母', '姨父', '姨夫',
  '哥哥', '姐姐', '弟弟', '妹妹', '兄长', '嫂子', '姐夫', '妹夫', '弟媳', '儿子', '女儿', '夫君', '丈夫', '妻子', '夫人', '娘子', '相公',
  '娘娘', '陛下', '殿下', '皇上', '圣上', '皇帝', '皇后', '太后', '皇太后', '太皇太后', '皇祖母', '太后娘娘', '皇后娘娘', '贵妃娘娘', '贵妃', '皇贵妃', '王爷', '王妃', '太子', '公主',
  '老爷', '太太', '老太太', '少爷', '小姐', '公子', '姑娘', '大人', '先生', '师父', '师傅', '师兄', '师姐', '师弟', '师妹', '将军',
  '我', '你', '他', '她', '本宫', '哀家', '朕', '孤', '寡人', '臣妾', '本王', '老夫', '奴婢', '奴才', '儿臣', '妾身', '在下',
])
export const isContextualName = (value: string) => contextualNames.has(value.trim().replace(/\s/g, ''))
type Names = { name: string; aliases?: string[]; identity?: string; mergeFacts?: Fact[]; sourceChapters?: string[]; chapterIndex?: string }
export function characterMatchNames(person: Names) {
  return [...new Set([person.name, ...(person.aliases ?? [])].map(name => name.trim()).filter(name => name && !isContextualName(name)))]
}
