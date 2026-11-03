import { layoutGraph, type LayoutRequest } from './layout'

self.onmessage = (event: MessageEvent<LayoutRequest>) => {
  if (event.data.type !== 'layout') return
  const positions = layoutGraph(event.data, initial => self.postMessage({ type: 'initial', positions: initial }))
  self.postMessage({ type: 'done', positions })
}
