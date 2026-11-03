/** Target application ports; type-checkable contract, not an implementation or a replacement for pinned Pi types. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type ObjectValue = { [key: string]: Json };
export type Scope = { bookId: string; runId: string; taskId: string; profile: 'asset_editor' | 'story_editor'; phase: string };
export type ModelSnapshot = { providerId: string; api: string; baseUrl: string; modelId: string; modelRole: 'extraction' | 'aggregation'; contextWindow: number; capabilities: { tools: boolean; structuredOutput: boolean }; credentialRef: string; pricingStatus?: "known" | "estimated" | "unknown"; pricingCurrency?: string };
/** Preserve native message extensions, also validate against locked Pi SDK when adapting. */
export type Message = ObjectValue & { role: 'system' | 'user' | 'assistant' | 'toolResult' };
export type ToolDeclaration = { name: string; description: string; parameters: ObjectValue; outputSchema?: ObjectValue };
export type Request = { callId: string; snapshot: ModelSnapshot; systemPrompt?: string; messages: Message[]; tools: ToolDeclaration[]; options: { temperature?: number; maxTokens?: number }; promptHash: string };
export type Usage = { input: number; output: number; totalTokens: number; cost: number; costStatus?: "known" | "estimated" | "unknown" };
export type Failure = { code: string; message: string; retryable: boolean };
export type Result<T> = { ok: true; value: T; usage: Usage[] } | { ok: false; error: Failure; usage: Usage[] };
export type Validation<T> = { valid: true; data: T } | { valid: false; errors: string[] };
export interface ConfigRepository { load(): Promise<ObjectValue>; }
export interface ModelResolver { resolve(config: ObjectValue, role: ModelSnapshot['modelRole']): Result<ModelSnapshot>; }
/** Pure function: no DB, credential lookup, global UI selection or network. */
export interface RequestBuilder { build(callId: string, input: ObjectValue, snapshot: ModelSnapshot, history: Message[]): Request; }
/** Authentication injected into gateway closure; never serialize API Key in Request. */
export interface ModelGateway { complete(request: Request, signal: AbortSignal): Promise<Result<Message>>; stream(request: Request, signal: AbortSignal): AsyncIterable<ObjectValue>; }
export interface DirectExecutor { execute<T extends Json>(request: Request, validate: (value: Json) => Validation<T>, signal: AbortSignal): Promise<Result<T>>; }
export interface QueryService { execute(scope: Scope, name: string, args: ObjectValue, signal: AbortSignal): Promise<ObjectValue>; }
export type CommitAck = { ok: true; commitId: string; operationKey: string; alreadyApplied: boolean; summary: string };
export interface CommandService {
  prepare(scope: Scope, toolCallId: string, toolName: string, operationKey: string, payload: ObjectValue, readSet: ObjectValue): Promise<Validation<{ operationKey: string }>>;
  executePrepared(scope: Scope, operationKey: string, signal: AbortSignal): Promise<CommitAck | { error: string; message: string }>;
}
export interface BoundTool { declaration: ToolDeclaration; execute(toolCallId: string, args: ObjectValue, signal: AbortSignal): Promise<ObjectValue>; }
export interface ToolRegistry { bind(scope: Scope, queries: QueryService, commands: CommandService): BoundTool[]; }
export interface SessionPort { project(bookId: string, sessionId: string): Promise<Message[]>; append(bookId: string, sessionId: string, owner: string, message: Message): Promise<string>; }
export type Summarizer = (previousSummary: string, transcript: string, maxTokens: number, signal: AbortSignal) => Promise<Result<{ summary: string }>>;
export interface Compactor { compact(history: Message[], summarize: Summarizer, signal: AbortSignal): Promise<Result<Message[]>>; }
export type TaskSummary = { status: 'completed' | 'partial'; commitIds: string[]; summary: string; remainingWorkIds: string[]; reviewedItems: { workItemId: string; outcome: 'changed' | 'no_change' | 'needs_review'; reason: string }[] };
export interface AgentExecutor { run(request: Request, scope: Scope, tools: BoundTool[], session: SessionPort | null, signal: AbortSignal): Promise<Result<TaskSummary>>; }
export interface RunRepository { load(bookId: string, runId: string): Promise<ObjectValue>; }
export interface RunCoordinator {
  start(bookId: string, stage: 'P1' | 'P2' | 'P3'): Promise<{ runId: string }>;
  resume(bookId: string, runId: string): Promise<void>;
  cancel(bookId: string, runId: string): Promise<void>;
  finalize(scope: Scope, summary: TaskSummary): Promise<{ accepted: true } | { error: string; message: string }>;
}
