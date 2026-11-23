export interface NarrativeErrorDetails {
  fields?: string[]
  objectIds?: string[]
  operationNumber?: number
  expectedValues?: string[]
  hint?: string
}

export class NarrativeToolError extends Error {
  readonly code: string
  readonly context: NarrativeErrorDetails

  constructor(code: string, message: string, context: NarrativeErrorDetails = {}) {
    super(message)
    this.code = code
    this.context = context
  }
}
