# 内部边界签名与类型

> **2.1历史资源：** 本文记录变更前实现/验收。2.2阶段、锁、会话、人工合并和新增字段以主文档及resources/v2.2为准；此处旧条款不得覆盖新流程，也不证明新流程已实现。


参数初值属于契约。无显式返回类型的函数返回语义由详细Spec规定；本文件不包含业务函数体。

## App.tsx

```typescript
export default function App();
```

## core/agent/profiles.ts

```typescript
export type AgentProfileId = 'asset_editor' | 'story_editor';
```

## core/agent/run.ts

```typescript
export interface AgentLimits {
    maxSteps?: number;
    timeoutMs?: number;
    contextWindow?: number;
    compaction?: Partial<CompactionSettings>;
}

export async function runAgent<T extends TSchema>(
  opts: CallModelOptions<T> & { schema: T; tools: ReadTool[] },
  limits: AgentLimits = {},
  deps: { stream?: StreamFn; summarize?: SummaryCall } = {},
): Promise<CallModelResult<Static<T>>>;
```

## core/assets/edit.ts

```typescript
export type CharacterSnapshotEdit = Partial<Pick<StoredCharacterSnapshot, 'name' | 'aliases' | 'roleWeight' | 'identity' | 'personality' | 'background' | 'appearance' | 'speech_style_sample'>> & {
    'profile.ageText'?: string;
};

export async function updateCharacterSnapshot(
  bookId: string,
  id: string,
  patch: CharacterSnapshotEdit,
): Promise<void>;

export async function deleteCharacterSnapshot(bookId: string, id: string): Promise<void>;

export async function mergeCharacterSnapshots(
  bookId: string,
  keepId: string,
  mergeIds: string[],
): Promise<void>;

export async function setCharacterRoleWeight(
  bookId: string,
  id: string,
  roleWeight: RoleWeight,
): Promise<void>;

export type LocationSnapshotEdit = Partial<Pick<StoredLocationSnapshot, 'name' | 'aliases' | 'description'>>;

export async function updateLocationSnapshot(
  bookId: string,
  id: string,
  patch: LocationSnapshotEdit,
): Promise<void>;

export async function deleteLocationSnapshot(bookId: string, id: string): Promise<void>;

export async function mergeLocationSnapshots(
  bookId: string,
  keepId: string,
  mergeIds: string[],
): Promise<void>;

export type NodeEdit = Partial<Pick<StoredNode, 'name' | 'summary' | 'process' | 'actors' | 'time_text'>>;

export async function updateNode(bookId: string, id: string, patch: NodeEdit): Promise<void>;

export async function deleteNode(bookId: string, id: string): Promise<void>;

export type EventLineEdit = Partial<Pick<EventLine, 'title' | 'cause' | 'process' | 'result' | 'lineStatus'>>;

export async function updateEventLine(bookId: string, id: string, patch: EventLineEdit): Promise<void>;

export async function deleteEventLine(bookId: string, id: string): Promise<void>;

export async function deleteCharacter(bookId: string, id: string): Promise<void>;

export async function deleteStoredLocation(bookId: string, id: string): Promise<void>;
```

## core/assets/library.ts

```typescript
export function deleteAssetBook(bookId: string): Promise<void>;
```

## core/config/settings.ts

```typescript
export async function isApiKeyConfigured(): Promise<boolean>;

export async function saveApiKey(key: string): Promise<void>;

export async function removeApiKey(): Promise<void>;

export async function getApiKeyHint(): Promise<string | null>;

export async function readApiKeyForProbe(): Promise<string | null>;

export async function getAppSetting<T>(key: string, fallback: T): Promise<T>;

export async function setAppSetting(key: string, value: unknown): Promise<void>;

export async function getLlmConfig(): Promise<LlmConfig>;

export async function setLlmConfig(patch: Partial<LlmConfig>): Promise<void>;

export async function getModelForRole(role: ModelRole): Promise<string>;

export async function getConcurrency(): Promise<number>;

export async function setConcurrency(n: number): Promise<void>;

export function getCatalogModels(): string[];

export async function probeFetchModels(signal?: AbortSignal): Promise<string[]>;

export async function probeQuickTest(
  role: ModelRole = 'extraction',
  signal?: AbortSignal,
): Promise<QuickTestResult>;

export async function probeAggregationTools(signal?: AbortSignal): Promise<QuickTestResult>;
```

## core/db/canon.ts

```typescript
export function getCanonDb(bookId: string): CanonDatabase;

export async function deleteCanonDb(bookId: string): Promise<void>;

export async function resetCanonDbForTest(bookId?: string): Promise<void>;

export function listOpenCanonDbs(): string[];
```

## core/db/repo.ts

```typescript
export async function createBook(input: {
  id: string
  title: string
  author?: string
  sourceFileName?: string
}): Promise<Book>;

export async function getBook(bookId: string): Promise<Book | undefined>;

export async function listBooks(): Promise<Book[]>;

export async function deleteBook(bookId: string): Promise<void>;

export async function saveChapters(
  bookId: string,
  drafts: Array<{ chapterIndex: string; chapterName: string; text: string; charCount: number; order: number }>,
): Promise<void>;

export async function listChapters(bookId: string): Promise<Chapter[]>;

export async function getChapterText(bookId: string, chapterIndex: string): Promise<string | undefined>;

export interface P1PersistPayload {
    characterSnapshots: StoredCharacterSnapshot[];
    locationSnapshots: StoredLocationSnapshot[];
    nodes: StoredNode[];
}

export async function saveP1Result(bookId: string, payload: P1PersistPayload): Promise<void>;

export async function listCharacterSnapshots(bookId: string): Promise<StoredCharacterSnapshot[]>;

export async function listLocationSnapshots(bookId: string): Promise<StoredLocationSnapshot[]>;

export async function listNodes(bookId: string): Promise<StoredNode[]>;

export async function replaceCharacterSnapshots(
  bookId: string,
  snapshots: StoredCharacterSnapshot[],
): Promise<void>;

export async function replaceLocationSnapshots(
  bookId: string,
  snapshots: StoredLocationSnapshot[],
): Promise<void>;

export async function listCharacters(bookId: string): Promise<Character[]>;

export async function listLocations(bookId: string): Promise<StoredLocation[]>;

export async function listEventLines(bookId: string): Promise<EventLine[]>;

export async function getProgress(
  bookId: string,
  stage: CompileProgress['stage'],
): Promise<CompileProgress | undefined>;

export async function putProgress(progress: CompileProgress): Promise<void>;
```

## core/db/settings.ts

```typescript
export interface StoredCredentialRow {
    providerId: string;
    credential: unknown;
}

export interface AppSettingRow {
    key: string;
    value: unknown;
    updatedAt: string;
}

export function getSettingsDb(): SettingsDatabase;

export async function resetSettingsDbForTest(): Promise<void>;
```

## core/db/stores.ts

```typescript
export type CanonStoreName = keyof typeof CANON_STORES;
```

## core/events/bus.ts

```typescript
export interface EventBus {
    emit(event: AppEvent): void;
    on(handler: (event: AppEvent) => void): () => void;
    onType<T extends AppEvent['type']>(type: T, handler: (event: Extract<AppEvent, {
        type: T;
    }>) => void): () => void;
}

export function createEventBus(): EventBus;

export function getEventBus(): EventBus;
```

## core/events/types.ts

```typescript
export type AppEvent = {
    type: 'task:start';
    bookId: string;
    stage: CompileStage;
    total: number;
    unit?: '章' | '步骤' | '批' | '窗口';
} | {
    type: 'task:progress';
    bookId: string;
    stage: CompileStage;
    completed: number;
    failed: number;
    total: number;
    cost: number;
} | {
    type: 'task:paused';
    bookId: string;
    stage: CompileStage;
} | {
    type: 'task:resumed';
    bookId: string;
    stage: CompileStage;
} | {
    type: 'task:cancelled';
    bookId: string;
    stage: CompileStage;
} | {
    type: 'task:done';
    bookId: string;
    stage: CompileStage;
    completed: number;
    failed: number;
    pendingFailures?: number;
} | {
    type: 'chapter:start';
    bookId: string;
    chapterIndex: string;
} | {
    type: 'chapter:done';
    bookId: string;
    chapterIndex: string;
    characters: number;
    locations: number;
    nodes: number;
} | {
    type: 'chapter:failed';
    bookId: string;
    chapterIndex: string;
    message?: string;
} | {
    type: 'log';
    level: 'info' | 'warn' | 'error';
    message: string;
    data?: unknown;
};

export type AppEventType = AppEvent['type'];
```

## core/export/export-book.ts

```typescript
export interface ExportResult {
    fileName: string;
    bytes: Uint8Array;
    manifest: BackupManifest;
}

export async function exportBook(bookId: string): Promise<ExportResult>;
```

## core/export/import-book.ts

```typescript
export interface InspectResult {
    ok: boolean;
    manifest?: BackupManifest;
    errors: string[];
    stats?: {
        chapters: number;
        characters: number;
        locations: number;
        nodes: number;
        eventLines: number;
    };
}

export function inspectBackup(bytes: Uint8Array): Promise<InspectResult>;

export interface ImportResult {
    bookId: string;
    chapterCount: number;
}

export async function importBackup(bytes: Uint8Array): Promise<ImportResult>;
```

## core/export/local-file.ts

```typescript
export interface ExportDirectory {
    name: string;
    queryPermission(options: {
        mode: 'readwrite';
    }): Promise<PermissionState>;
    requestPermission(options: {
        mode: 'readwrite';
    }): Promise<PermissionState>;
    getFileHandle(name: string, options: {
        create: true;
    }): Promise<{
        createWritable(): Promise<{
            write(data: Blob): Promise<void>;
            close(): Promise<void>;
            abort(): Promise<void>;
        }>;
    }>;
}

export async function exportDirectoryName(): Promise<string | null>;

export async function writeBackupToDirectory(backup: ExportResult, directory: ExportDirectory): Promise<string>;

export async function exportBookToDirectory(bookId: string, directory: ExportDirectory): Promise<{ fileName: string; directoryName: string }>;
```

## core/export/manifest.ts

```typescript
export interface BackupManifest {
    format: typeof BACKUP_FORMAT;
    formatVersion: number;
    appVersion: string;
    exportedAt: string;
    book: {
        id: string;
        title: string;
        author?: string;
        chapterCount: number;
    };
    contents: string[];
    excludes: string[];
    checksums: Record<string, string>;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string>;

export async function checksumOf(bytes: Uint8Array): Promise<string>;

export function chapterFileName(chapterIndex: string): string;

export function parseChapterFileName(fileName: string): string | null;
```

## core/graph/build-network.ts

```typescript
export type EdgeKind = 'shares_node' | 'shares_character' | 'temporal_overlap' | 'contains';

export interface NetworkNode {
    id: string;
    kind: 'line' | 'node';
    label: string;
    sublabel?: string;
    chapters: string[];
    lineStatus?: EventLine['lineStatus'];
    nodeCount?: number;
}

export interface NetworkEdge {
    id: string;
    source: string;
    target: string;
    kind: EdgeKind;
}

export interface NetworkGraph {
    nodes: NetworkNode[];
    edges: NetworkEdge[];
}

export function compareChapterIndex(a: string, b: string): number;

export function buildLineLevelGraph(lines: EventLine[], nodes: StoredNode[]): NetworkGraph;

export function buildNodeLevelGraph(
  line: EventLine,
  nodes: StoredNode[],
  allLines: EventLine[],
): NetworkGraph;

export function topByDegree(graph: NetworkGraph, limit = 5): string[];
```

## core/graph/chapter-timeline.ts

```typescript
export interface TimelineLine {
    id: string;
    title: string;
    color: string;
    nodeCount: number;
    lineStatus: EventLine['lineStatus'];
}

export interface TimelineEvent {
    node: StoredNode;
    lineIds: string[];
    x: number;
    y: number;
}

export interface ChapterTimeline {
    events: TimelineEvent[];
    lines: TimelineLine[];
    chapters: Array<{
        chapterIndex: string;
        x: number;
        width: number;
    }>;
    edges: Array<{
        id: string;
        source: string;
        target: string;
        lineId: string;
        color: string;
    }>;
    width: number;
    height: number;
}

export function buildChapterTimeline(lines: EventLine[], nodes: StoredNode[], chapterIndices: string[] = []): ChapterTimeline;
```

## core/graph/layout.ts

```typescript
export interface PositionedNode {
    id: string;
    x: number;
    y: number;
}

export interface LayoutOptions {
    direction?: 'LR' | 'TB';
    nodeWidth?: number;
    nodeHeight?: number;
    rankSep?: number;
    nodeSep?: number;
}

export function layoutGraph(graph: NetworkGraph, options: LayoutOptions = {}): PositionedNode[];
```

## core/llm/call.ts

```typescript
export interface CallUsage {
    input: number;
    output: number;
    totalTokens: number;
    cost: number;
}

export interface CallModelOptions<T extends TSchema> {
    role: ModelRole;
    system: string;
    messages: Message[];
    schema?: T;
    submitToolDescription?: string;
    temperature?: number;
    signal?: AbortSignal;
    tools?: ReadTool[];
    agentProfile?: AgentProfileId;
    session?: StorySessionRef;
    forceCompaction?: boolean;
    maxTokens?: number;
    bus?: EventBus;
    validateData?: (data: Static<T>) => Promise<string[]> | string[];
}

export interface CallModelResult<T> {
    ok: boolean;
    data?: T;
    stopReason: string;
    errorKind?: ErrorKind;
    errorMessage?: string;
    usage?: CallUsage;
    attemptsUsage: CallUsage[];
    attempts: number;
    degraded?: boolean;
}

export async function callModel<T extends TSchema>(
  opts: CallModelOptions<T>,
): Promise<CallModelResult<Static<T>>>;
```

## core/llm/credentials.ts

```typescript
export async function hasCredential(providerId: string): Promise<boolean>;

export async function setApiKey(providerId: string, key: string): Promise<void>;

export async function clearApiKey(providerId: string): Promise<void>;
```

## core/llm/errors.ts

```typescript
export type ErrorKind = 'network' | 'rate_limit' | 'server' | 'auth' | 'content_policy' | 'context_length' | 'validation' | 'unknown';

export interface RetryPolicy {
    retry: boolean;
    maxAttempts: number;
    baseDelayMs: number;
}

export function classifyError(stopReason: string, errorMessage?: string): ErrorKind;

export function backoffDelay(attempt: number, baseDelayMs: number): number;

export function parseRetryAfter(errorMessage?: string): number | null;
```

## core/llm/models.ts

```typescript
export interface LlmConfig {
    baseUrl: string;
    extractionModel: string;
    aggregationModel: string;
    aggregationContextWindow?: number;
}

export type ModelRole = 'extraction' | 'aggregation';

export function listCatalogModels(): string[];

export function resolveModel(role: ModelRole, cfg: LlmConfig);

export function getModelsForConfig(cfg: LlmConfig);

export function resetModelsForTest(): void;
```

## core/llm/normalize-result.ts

```typescript
export function normalizeModelResult(schema: TSchema, value: unknown): unknown;
```

## core/llm/probe.ts

```typescript
export interface ProbeTarget {
    baseUrl: string;
    apiKey: string;
}

export async function fetchModelList(target: ProbeTarget, signal?: AbortSignal): Promise<string[]>;

export interface QuickTestResult {
    ok: boolean;
    elapsedMs: number;
    detail: string;
}

export async function quickTestModel(
  target: ProbeTarget & { model: string },
  signal?: AbortSignal,
): Promise<QuickTestResult>;
```

## core/llm/provider.ts

```typescript
export interface ProviderConfig {
    id?: string;
    baseUrl?: string;
    models: string[];
}

export function buildProvider(cfg: ProviderConfig): Provider;
```

## core/memory/story-editor.ts

```typescript
export interface EditorContext {
    nodes: Map<string, StoredNode>;
    lines: Map<string, EventLine>;
    assetFingerprint?: string;
}

export type EditorWork = Pick<StoryEditorCheckpoint, 'stage' | 'phase' | 'scopeIds'> & {
    sessionId?: string;
};

export async function loadEditorContext(bookId: string): Promise<EditorContext>;

export async function editorAssetSignature(bookId: string);

export async function loadEditorAssets(bookId: string);

export async function editorDataFingerprint(context: EditorContext);

export async function validateEditorUpdate(bookId: string, value: unknown, context: EditorContext,
  temporaryNodeIds: string[] = [], sessionId?: string): Promise<string[]>;

export async function readEditorNotes(bookId: string, context?: EditorContext, sessionId?: string): Promise<StoryEditorNoteView[]>;

export async function readEditorMemory(bookId: string, context?: EditorContext, sessionId?: string);

export async function checkpointId(work: EditorWork);

export async function completedEditorWork(bookId: string, work: EditorWork, context: EditorContext): Promise<boolean>;

export async function prepareEditorCommit(bookId: string, update: EditorMemoryUpdate, work: EditorWork,
  context: EditorContext, expectedRevision: number);

export async function recordEditorFailure(bookId: string, work: EditorWork, context: EditorContext, status: 'failed' | 'cancelled');
```

## core/pipeline/asset-frequency.ts

```typescript
export interface AssetFrequency {
    chapters: number;
    mentions: number;
    scopeChapters: number;
    percentile: number;
}

export function assignAssetFrequency<T extends FrequencyAsset>(entities: T[], texts: ChapterText[], processedIds?: string[]): void;
```

## core/pipeline/asset-merge-policy.ts

```typescript
export interface AssetGroupingConfig<T> {
    name: (item: T) => string;
    aliases: (item: T) => string[];
    allowContainment?: boolean;
}

export function assetNames<T>(records: T[], config: AssetGroupingConfig<T>): string[];

export function nameSimilarity(a: string, b: string): number;

export function aliasSimilarity(left: string[], right: string[]): number;

export function twoPassAssetGroups<T>(records: T[], config: AssetGroupingConfig<T>, threshold = ALIAS_SIMILARITY_THRESHOLD);
```

## core/pipeline/character-merge-policy.ts

```typescript
export function characterNames(records: StoredCharacterSnapshot[]): string[];

export function twoPassCharacterGroups(records: StoredCharacterSnapshot[], threshold = 0.9);

export function collectMergeFacts(group: StoredCharacterSnapshot[]): CharacterMergeFact[];

export function optimizationFingerprint(entity: StoredCharacterSnapshot): string;

export function optimizationReason(entity: StoredCharacterSnapshot): string | undefined;

export function assignFrequencyWeights(entities: StoredCharacterSnapshot[], texts: ChapterText[], processedIds?: string[]): void;
```

## core/pipeline/compilation-lock.ts

```typescript
export async function withCompilationLock<T>(bookId: string, run: () => Promise<T>): Promise<T>;
```

## core/pipeline/decode-text.ts

```typescript
export interface DecodeResult {
    text: string;
    encoding: 'utf-8' | 'gbk';
    ok: boolean;
}

export function decodeBytes(bytes: ArrayBuffer): DecodeResult;

export function decodeWith(bytes: ArrayBuffer, encoding: 'utf-8' | 'gbk'): string;
```

## core/pipeline/import-book.ts

```typescript
export interface ImportBookInput {
    id: string;
    title: string;
    text: string;
    sourceFileName?: string;
    split?: SplitOptions;
}

export interface ImportBookResult {
    book: Book;
    chapterCount: number;
    chapters: Array<{
        chapterIndex: string;
        chapterName: string;
        charCount: number;
        order: number;
    }>;
}

export async function importBook(input: ImportBookInput): Promise<ImportBookResult>;
```

## core/pipeline/merge-characters.ts

```typescript
export function normalizeEntryName(name: string): string;

export function normalizeNameForComparison(name: string): string;

export function areNamesObviouslySame(a: string, b: string): boolean;

export function pickMainByQuality(snapshots: StoredCharacterSnapshot[]): StoredCharacterSnapshot;

export interface MergeGroup {
    main: StoredCharacterSnapshot;
    others: StoredCharacterSnapshot[];
    aliases: string[];
}

export function groupSnapshots(snapshots: StoredCharacterSnapshot[]): MergeGroup[];
```

## core/pipeline/p1.ts

```typescript
export interface P1Input {
    bookId: string;
    chapterIndex: string;
    chapterName: string;
    text: string;
}

export interface P1Failure {
    stage: 'worldAssets' | 'narrativeAssets';
    errorKind?: string;
    errorMessage?: string;
    attempts: number;
}

export interface P1Result {
    characterSnapshots: StoredCharacterSnapshot[];
    locationSnapshots: StoredLocationSnapshot[];
    nodes: StoredNode[];
    usages: CallUsage[];
    failures: P1Failure[];
}

export function buildChapterMessage(input: P1Input): string;

export function assignCharacterIds(
  input: P1Input,
  characters: CharacterSnapshot[],
): StoredCharacterSnapshot[];

export function assignLocationIds(
  input: P1Input,
  locations: LocationSnapshot[],
): StoredLocationSnapshot[];

export function assignNodeIds(input: P1Input, nodes: Node[]): StoredNode[];

export interface P1Deps {
    call?: typeof callModel;
    signal?: AbortSignal;
    onlyStages?: Array<'worldAssets' | 'narrativeAssets'>;
}

export async function extractChapter(input: P1Input, deps: P1Deps = {}): Promise<P1Result>;
```

## core/pipeline/pool.ts

```typescript
export async function runPool<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
  signal?: AbortSignal,
): Promise<void>;
```

## core/pipeline/publish.ts

```typescript
export interface PublishOptions {
    bus?: EventBus;
}

export interface PublishResult {
    characters: number;
    locations: number;
    mappedNodes: number;
    mappedLines: number;
    unmappedNames: string[];
}

export function createNameResolver(entries: Array<{ id: string; names: string[] }>): (name: string) => string | undefined;

export function toCharacterEntity(bookId: string, s: StoredCharacterSnapshot, id: string): Character;

export function toLocationEntity(bookId: string, s: StoredLocationSnapshot, id: string): StoredLocation;

export function deriveLineCharacterIds(nodeIds: string[], nodeById: Map<string, StoredNode>): string[];

export async function publishCanon(bookId: string, options: PublishOptions = {}): Promise<PublishResult>;

export function lineCharacterNames(line: EventLine, nodes: StoredNode[]): string[];
```

## core/pipeline/run-all.ts

```typescript
export interface RunAllOptions {
    concurrency?: number;
    signal?: AbortSignal;
    bus?: EventBus;
    useAi?: boolean;
    deps?: RunP1Options['deps'];
    windowSize?: number;
    overlap?: number;
    recheck?: boolean;
}

export interface RunAllResult {
    p1: {
        status: CompileStatus;
        completed: number;
        failed: number;
        cost: number;
    };
    merge: Pick<RunMergeResult, 'characters' | 'locations' | 'cost'> | null;
    link: Pick<RunLinkResult, 'eventLineCount' | 'batches' | 'failedBatches' | 'cost'> | null;
    totalCost: number;
}

export function buildChapterWindows(chapters: Chapter[], size = 100, overlap = 20): string[][];

export async function runAll(bookId: string, options: RunAllOptions = {}): Promise<RunAllResult>;
```

## core/pipeline/run-link.ts

```typescript
export interface RunLinkOptions {
    signal?: AbortSignal;
    deps?: {
        call?: typeof callModel;
    };
    bus?: EventBus;
    batchSize?: number;
    chapterIndices?: string[];
    stage?: Extract<CompileStage, 'P2' | 'P3'>;
    review?: boolean;
    quiet?: boolean;
    recheck?: boolean;
    sessionId?: string;
}

export interface RunLinkResult {
    status: 'completed' | 'cancelled';
    batches: number;
    nodeCount: number;
    eventLineCount: number;
    cost: number;
    failedBatches: number;
    reviewBatches: number;
    newNodes: number;
    skippedBatches: number;
}

export function splitIntoBatches<T>(items: readonly T[], batchSize: number): T[][];

export function buildExistingLinesDigest(lines: EventLine[]): string;

export function buildNodesDigest(nodes: StoredNode[]): string;

export function deriveLineFields(nodeIds: string[], nodeById: Map<string, StoredNode>): { chapters: string[]; timeRange?: string[] };

export async function validateLinkResult(bookId: string, result: Pick<LinkEventLinesResult, 'event_line_ops' | 'new_nodes'> & { memory_update?: EditorMemoryUpdate },
  nodeMap: Map<string, StoredNode>, lineMap: Map<string, EventLine>, checkMemory = false, sessionId?: string): Promise<string[]>;

export async function runLink(bookId: string, options: RunLinkOptions = {}): Promise<RunLinkResult>;
```

## core/pipeline/run-merge.ts

```typescript
export interface RunMergeOptions {
    signal?: AbortSignal;
    deps?: {
        call?: typeof callModel;
    };
    bus?: EventBus;
    useAi?: boolean;
    stage?: Extract<CompileStage, 'P2' | 'P3'>;
    chapterIndices?: string[];
    quiet?: boolean;
}

export interface RunMergeResult {
    status: 'completed' | 'cancelled';
    characters: {
        before: number;
        after: number;
    };
    locations: {
        before: number;
        after: number;
    };
    cost: number;
    degraded: boolean;
}

export function earliestChapter(ids: string[]): number;

export function pickEarliest<T extends Named>(group: T[]): T;

export function groupByName<T extends Named>(items: T[], _aliasOf?: (item: T) => string[]): T[][];

export function describeCallFailure(res: CallModelResult<unknown>): string;

export async function runMerge(bookId: string, options: RunMergeOptions = {}): Promise<RunMergeResult>;
```

## core/pipeline/run-p1.ts

```typescript
export interface RunP1Options {
    concurrency?: number;
    signal?: AbortSignal;
    deps?: P1Deps;
    bus?: EventBus;
    chapterIndices?: string[];
}

export interface RunP1Result {
    status: CompileStatus;
    total: number;
    completed: number;
    failed: number;
    cost: number;
    failures: Array<{
        chapterIndex: string;
        message?: string;
    }>;
}

export async function runP1(bookId: string, options: RunP1Options = {}): Promise<RunP1Result>;
```

## core/pipeline/run-test-stage.ts

```typescript
export type TestStage = 'p1' | 'p2-merge' | 'p2-link' | 'p3';

export interface TestStageOptions {
    signal?: AbortSignal;
    bus?: EventBus;
    concurrency?: number;
    deps?: RunP1Options['deps'];
}

export async function runTestStage(bookId: string, step: TestStage, options: TestStageOptions = {}): Promise<{ status: CompileStatus; cost: number }>;
```

## core/pipeline/split-chapters.ts

```typescript
export function parseChapterRegex(value: string): RegExp;

export interface SplitOptions {
    regex?: RegExp;
    maxChunkChars?: number;
    fallbackWindowChars?: number;
}

export interface ChapterDraft {
    chapterIndex: string;
    chapterName: string;
    text: string;
    charCount: number;
    order: number;
}

export function splitChapters(text: string, options: SplitOptions = {}): ChapterDraft[];
```

## core/pipeline/try-one.ts

```typescript
export interface TryOneResult {
    chapterIndex: string;
    chapterName: string;
    sourceText: string;
    sourceTruncated: boolean;
    characters: StoredCharacterSnapshot[];
    locations: StoredLocationSnapshot[];
    nodes: StoredNode[];
    failures: P1Failure[];
    cost: number;
    durationMs: number;
}

export async function tryOneChapter(
  bookId: string,
  chapterIndex?: string,
  options: { signal?: AbortSignal; deps?: Parameters<typeof extractChapter>[1] } = {},
): Promise<TryOneResult>;
```

## core/prompts/index.ts

```typescript
export type PromptName = keyof typeof PROMPTS;
```

## core/schema/book.ts

```typescript
export type Book = Static<typeof BookSchema>;

export type Chapter = Static<typeof ChapterSchema>;

export type ChapterText = Static<typeof ChapterTextSchema>;

export type CompileStage = Static<typeof CompileStageSchema>;

export type CompileStatus = Static<typeof CompileStatusSchema>;

export type CompileProgress = Static<typeof CompileProgressSchema>;
```

## core/schema/character-snapshot.ts

```typescript
export type CharacterSnapshot = Static<typeof CharacterSnapshotSchema>;

export type StoredCharacterSnapshot = Static<typeof StoredCharacterSnapshotSchema>;
```

## core/schema/character.ts

```typescript
export type RoleWeight = Static<typeof RoleWeightSchema>;

export type Character = Static<typeof CharacterSchema>;
```

## core/schema/common.ts

```typescript
export type Confidence = Static<typeof ConfidenceSchema>;

export type RelationDirection = Static<typeof RelationDirectionSchema>;

export type Relation = Static<typeof RelationSchema>;

export type CharacterMergeFact = Static<typeof CharacterMergeFactSchema>;
```

## core/schema/editor-memory.ts

```typescript
export type EditorNoteDraft = Static<typeof EditorNoteDraftSchema>;

export type EditorMemoryUpdate = Static<typeof EditorMemoryUpdateSchema>;

export type StoryEditorMemory = Static<typeof StoryEditorMemorySchema>;

export type StoryEditorNote = Static<typeof StoryEditorNoteSchema>;

export type StoryEditorNoteView = Static<typeof StoryEditorNoteViewSchema>;

export type StoryEditorCheckpoint = Static<typeof StoryEditorCheckpointSchema>;
```

## core/schema/event-line.ts

```typescript
export type LineStatus = Static<typeof LineStatusSchema>;

export type EventLine = Static<typeof EventLineSchema>;
```

## core/schema/extraction.ts

```typescript
export type WorldAssetsExtraction = Static<typeof WorldAssetsExtractionSchema>;

export type NarrativeAssetsExtraction = Static<typeof NarrativeAssetsExtractionSchema>;
```

## core/schema/link.ts

```typescript
export type NewNodeDraft = Static<typeof NewNodeDraftSchema>;

export type LinkEventLinesResult = Static<typeof LinkEventLinesResultSchema>;

export type EventLineOp = Static<typeof EventLineOpSchema>;
```

## core/schema/location-snapshot.ts

```typescript
export type LocationSnapshot = Static<typeof LocationSnapshotSchema>;

export type StoredLocationSnapshot = Static<typeof StoredLocationSnapshotSchema>;

export type StoredLocation = Static<typeof StoredLocationSchema>;
```

## core/schema/merge.ts

```typescript
export type AliasGroups = Static<typeof AliasGroupsSchema>;

export type AliasGroup = Static<typeof AliasGroupSchema>;

export function aliasGroupsSchemaFor(names: string[]);

export type MergedEntity = Static<typeof MergedEntitySchema>;

export type OptimizedCharacter = Static<typeof OptimizedCharacterSchema>;

export type CharacterOptimizationBatch = Static<typeof CharacterOptimizationBatchSchema>;

export function characterOptimizationSchemaFor(items: Array<{ id: string; name: string; aliases: string[]; facts: Array<{ id: string }> }>);

export type MergedLocation = Static<typeof MergedLocationSchema>;
```

## core/schema/node.ts

```typescript
export type Node = Static<typeof NodeSchema>;

export type TimePrecision = Static<typeof TimePrecisionSchema>;

export type StoredNode = Static<typeof StoredNodeSchema>;
```

## core/schema/story-session.ts

```typescript
export type StorySession = Static<typeof StorySessionSchema>;

export type StorySessionEntry = Static<typeof StorySessionEntrySchema>;

export type StorySessionRef = {
    bookId: string;
    id: string;
};
```

## core/schema/validate.ts

```typescript
export function compileSchema<T extends TSchema>(schema: T): AnyCheck;

export type ValidationResult<T> = {
    ok: true;
    value: T;
} | {
    ok: false;
    errors: string[];
};

export function validate<T extends TSchema>(
  schema: T,
  data: unknown,
): ValidationResult<Static<T>>;
```

## core/session/compaction.ts

```typescript
export type SummaryCall = (input: {
    previousSummary: string;
    transcript: string;
    signal?: AbortSignal;
    maxTokens: number;
}) => Promise<CallModelResult<{
    summary: string;
}>>;

export function settingsForWindow(window: number, configured: Partial<CompactionSettings> = {}): CompactionSettings;

export async function projectedStoryContext(ref: StorySessionRef);

export async function compactStoryContext(ref: StorySessionRef, owner: string, options: {
  contextWindow: number; settings?: Partial<CompactionSettings>; force?: boolean; signal?: AbortSignal;
  bus?: EventBus; summarize?: SummaryCall; onUsage?: (usage: CallUsage[]) => void;
}): Promise<Message[]>;
```

## core/session/pi-context.ts

```typescript
export type CompactionSettings = typeof PI_DEFAULT_COMPACTION;

export function estimateTextTokens(text: string): number;

export function estimateMessageTokens(message: Message): number;

export function shouldCompact(tokens: number, window: number, settings: CompactionSettings): boolean;

export function sessionPath(entries: StorySessionEntry[], leafId?: string): StorySessionEntry[];

export function buildContextEntries(entries: StorySessionEntry[], leafId?: string): StorySessionEntry[];

export function entryMessages(entry: StorySessionEntry): Message[];

export function projectSession(entries: StorySessionEntry[], leafId?: string);

export function estimateContextTokens(entries: StorySessionEntry[], messages: Message[]): number;

export function findCutPoint(entries: StorySessionEntry[], keepRecentTokens: number): number;

export function repairToolPairs(messages: Message[]): Message[];
```

## core/session/store.ts

```typescript
export async function activeStorySession(bookId: string);

export async function requireStorySession(ref: StorySessionRef, requireActive = false): Promise<StorySession>;

export async function ensureStorySession(bookId: string, newReview = false): Promise<StorySessionRef>;

export async function acquireStorySession(ref: StorySessionRef): Promise<string>;

export async function releaseStorySession(ref: StorySessionRef, owner: string);

export async function sessionEntries(ref: StorySessionRef): Promise<StorySessionEntry[]>;

export async function appendSessionEntry(ref: StorySessionRef, data: EntryData, owner?: string): Promise<StorySessionEntry>;

export async function appendSessionMessage(ref: StorySessionRef, message: Message, owner: string);

export async function resolveEditorSessionId(bookId: string, supplied?: string);
```

## core/shared/fuse-assets.ts

```typescript
export function uniqueText(values: Array<string | undefined>): string | undefined;

export function mergeRelations(relations: Relation[]): Relation[];

export function sources(items: Sourced[]): string[];

export function fuseCharacters(keep: StoredCharacterSnapshot, group: StoredCharacterSnapshot[]): StoredCharacterSnapshot;

export function fuseLocations(keep: StoredLocationSnapshot, group: StoredLocationSnapshot[]): StoredLocationSnapshot;
```

## core/tools/compile-tools.ts

```typescript
export function boundedRows(rows: unknown[], offset = 0, limit = 100, maxResults = 200);

export async function createCompileTools(bookId: string, state: {
  nodes?: () => StoredNode[]
  lines?: () => EventLine[]
  characters?: () => StoredCharacterSnapshot[]
  locations?: () => StoredLocationSnapshot[]
  profile?: AgentProfileId
  sessionId?: string
} = {}): Promise<ReadTool[]>;
```

## core/tools/types.ts

```typescript
export interface ReadTool {
    tool: Tool;
    kind: 'read';
    maxResults: number;
    maxBytes: number;
    returns?: TSchema;
    execute: (args: unknown, signal?: AbortSignal) => Promise<unknown>;
}
```

## features/app-shell/AppShell.tsx

```typescript
export function AppShell();
```

## features/assets/AssetDetail.tsx

```typescript
export type AssetKind = 'character' | 'location' | 'node' | 'line';

export type AssetItem = {
    kind: 'character';
    item: StoredCharacterSnapshot;
} | {
    kind: 'location';
    item: StoredLocationSnapshot;
} | {
    kind: 'node';
    item: StoredNode;
} | {
    kind: 'line';
    item: EventLine;
};

export interface MergeCandidate {
    id: string;
    name: string;
}

export function AssetDetail({
  bookId,
  asset,
  mergeCandidates,
  onClose,
  onChanged,
}: {
  bookId: string
  asset: AssetItem
  mergeCandidates: MergeCandidate[]
  onClose: () => void
  onChanged: () => void
});
```

## features/assets/AssetFields.tsx

```typescript
export function AssetFields({ asset }: { asset: AssetItem });
```

## features/assets/AssetsPanel.tsx

```typescript
export function AssetsPanel();
```

## features/assets/BookSidebar.tsx

```typescript
export function BookSidebar({ books, bookId, importing, disabled, onOpen, onImport, onDeleted }: Props);
```

## features/assets/EditorMemoryPanel.tsx

```typescript
export function EditorMemoryPanel({ bookId }: { bookId: string });
```

## features/assets/SessionHistory.tsx

```typescript
export function SessionHistory({ entries }: { entries: StorySessionEntry[] });
```

## features/assets/TryOnePanel.tsx

```typescript
export function TryOnePanel({ bookId, onClose }: { bookId: string; onClose: () => void });
```

## features/assets/local-file-export.ts

```typescript
export async function chooseExportDirectory(): Promise<ExportDirectory>;

export async function exportBookToDirectory(bookId: string);

export async function downloadBookBackup(bookId: string): Promise<string>;
```

## features/compile/CompilePanel.tsx

```typescript
export function CompilePanel({ onCancel }: { onCancel?: () => void });
```

## features/compile/StageTestPanel.tsx

```typescript
export function StageTestPanel({ bookId, onInspect, disabled = false }: { bookId: string; onInspect: (tab: 'characters' | 'lines') => void; disabled?: boolean });
```

## features/import/ImportPanel.tsx

```typescript
export function ImportPanel({ onImported }: { onImported?: () => void });
```

## features/network/NetworkPanel.tsx

```typescript
export interface NetworkPanelProps {
    lines: EventLine[];
    nodes: StoredNode[];
    chapterIndices?: string[];
    onSelectNode?: (node: StoredNode) => void;
}

export function NetworkPanel(props: NetworkPanelProps);
```

## features/play/PlayPanel.tsx

```typescript
export function PlayPanel();
```

## features/settings/SettingsPanel.tsx

```typescript
export function SettingsPanel();
```

## features/store/compile-store.ts

```typescript
export interface LogLine {
    id: number;
    at: number;
    level: 'info' | 'warn' | 'error';
    text: string;
}
```

## features/store/ui-store.ts

```typescript
export type ActiveView = 'assets' | 'play' | 'settings';
```

## queries/index.ts

```typescript
export function useBooks(): Book[] | undefined;

export function useBookSummary(bookId: string);

export function useChapterIndices(bookId: string | null): string[] | undefined;

export function useProgress(bookId: string | null): CompileProgress | undefined;

export function useCharacterSnapshots(bookId: string | null): StoredCharacterSnapshot[] | undefined;

export function useLocationSnapshots(bookId: string | null): StoredLocationSnapshot[] | undefined;

export function useNodes(bookId: string | null): StoredNode[] | undefined;

export function useEventLines(bookId: string | null): EventLine[] | undefined;

export function useCharacters(bookId: string | null): Character[] | undefined;

export function useLocations(bookId: string | null): StoredLocation[] | undefined;

export function useEditorMemory(bookId: string | null, sessionId?: string);

export function useEditorNotes(bookId: string | null, sessionId?: string);

export function useStorySessions(bookId: string);

export function useStorySessionEntries(bookId: string, sessionId?: string);
```
