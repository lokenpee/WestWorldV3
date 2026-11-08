/** 标签描述人物自身在关系中的身份；称呼和单次互动不能代替身份。 */
export function isNonRoleLabel(value: string): boolean {
  const label = value.trim()
  if (/^(?:(?:表|堂|族|义|结义)?(?:兄长|哥哥|兄|弟弟|弟|姐姐|姐|妹妹|妹))$/.test(label)) return false
  return ['打趣', '被打趣', '称呼', '被称呼'].includes(label)
    || /(?:-->|<--|→|←)/.test(label)
    || /^(?:大爷|老爷|少爷|公子|姑娘|小姐|陛下|殿下)$/.test(label)
    || /^.+(?:[一二三四五六七八九十大小]?哥(?:哥)?|[一二三四五六七八九十大小]?姐(?:姐)?|弟弟|妹妹|大爷|老爷|公子|姑娘|小姐|先生|夫人|殿下)$/.test(label)
}

export function relationRoleLabel(value: string): string {
  const label = value.trim()
  return !label || /^(?:未知.*|不详|不明|待核对|未明确)$/.test(label) || isNonRoleLabel(label) ? '未知' : label
}

export function relationLines(currentName: string, otherName: string, forward: string[], reverse: string[]): [string, string] {
  const text = (labels: string[]) => [...new Set(labels.map(relationRoleLabel))].join('、') || '未知'
  return [`${currentName}--${text(forward)}-->${otherName}`, `${currentName}<--${text(reverse)}--${otherName}`]
}
