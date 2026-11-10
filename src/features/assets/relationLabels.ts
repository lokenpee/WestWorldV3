export function relationLines(currentName: string, otherName: string, forward: string[], reverse: string[]): [string, string] {
  const text = (labels: string[]) => [...new Set(labels.filter(Boolean))].join('、') || '未知'
  return [`${currentName}--${text(forward)}-->${otherName}`, `${currentName}<--${text(reverse)}--${otherName}`]
}
