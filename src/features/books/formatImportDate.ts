export function formatImportDate(iso: string) {
  const date = new Date(iso)
  return Number.isNaN(date.valueOf()) ? '日期未知' : new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(date)
}
