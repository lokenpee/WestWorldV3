export function completionsBody(model = 'saved-extraction', text = '好') {
  const frame = (delta: object, finish_reason: string | null) => ({ id: 'response', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta, finish_reason }] })
  return [frame({ role: 'assistant', content: text }, null), frame({}, 'stop'), { id: 'usage', object: 'chat.completion.chunk', created: 1, model, choices: [], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } }].map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n'
}
export function responsesBody(model = 'saved-extraction') {
  const item = { type: 'message', id: 'msg-1', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: '好', annotations: [] }] }
  const response = { id: 'resp-1', object: 'response', created_at: 1, model, status: 'in_progress', output: [], usage: null }
  return [
    { type: 'response.created', response },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
    { type: 'response.content_part.added', item_id: 'msg-1', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
    { type: 'response.output_text.delta', item_id: 'msg-1', output_index: 0, content_index: 0, delta: '好' },
    { type: 'response.output_text.done', item_id: 'msg-1', output_index: 0, content_index: 0, text: '好' },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { ...response, status: 'completed', output: [item], usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } } },
  ].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
}
export function anthropicBody(model = 'saved-extraction') {
  return [
    { type: 'message_start', message: { id: 'msg-1', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 2, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '好' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } },
    { type: 'message_stop' },
  ].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
}
