import type { StoryService } from './service'
import { NarrativePanel } from './NarrativePanel'
import './StoryPanel.css'

export function StoryPanel({ bookId, service, createCopy }: {
  bookId: string; service: StoryService; createCopy?: (bookId:string)=>Promise<string>
}) {
  return <NarrativePanel key={bookId} bookId={bookId} service={service} createCopy={createCopy} />
}
