"""重建审查材料：清点实际Prompt调用和文档缺口，不执行应用/模型。"""
from pathlib import Path
import sys
if '--legacy-snapshot' not in sys.argv:
    raise SystemExit('该生成器已由2026-10-24目标契约取代；如确需生成旧快照，显式使用--legacy-snapshot，并勿覆盖当前规格。')
import json,hashlib
ROOT=Path(__file__).resolve().parents[1]
RES=ROOT/'resources'
REPO=ROOT.parents[2]
def save(p,x): p.write_text(json.dumps(x,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
def digest(p): return hashlib.sha256(p.read_bytes()).hexdigest()

calls=[
dict(id='PROMPT-P1-WORLD',trigger='P1世界子步骤/单章试跑',mode='direct',role='extraction',prompt='prompts/extraction/01-extract-world-assets.md',input='ChapterTask',output='schemas.json#WorldAssetsExtractionSchema',tool='submit_result',temperature='omit: provider/model default',maxTokens='omit: Pi/model default',commit='调用方提交人物/地点、receipt、lifecycle、进度',coverage='defined-static-not-rebuilt'),
dict(id='PROMPT-P1-NARRATIVE',trigger='P1叙事子步骤/单章试跑',mode='direct',role='extraction',prompt='prompts/extraction/02-extract-narrative-assets.md',input='ChapterTask',output='schemas.json#NarrativeAssetsExtractionSchema',tool='submit_result',temperature='omit: provider/model default',maxTokens='omit: Pi/model default',commit='调用方提交节点、receipt、lifecycle、进度',coverage='defined-static-not-rebuilt'),
dict(id='PROMPT-P2-IDENTITY',trigger='P2 ai_identity人物/地点子任务',mode='agent',role='aggregation',profile='asset_editor',prompt='v2.2/prompts/p2-asset-editor.md',input='IdentityTask: target fields incomplete',output='v2.2/model-output-contract.json#AgentTaskSummarySchema',writePayload='v2.2/model-output-contract.json#IdentityGroupsSchema',tool='commit_asset_changes + submit_result',temperature=0,maxTokens='target temporary-agent budget not fully pinned',commit='写工具立即提交，最终总结不重写',coverage='partial: RQ-01/RQ-03'),
dict(id='PROMPT-P2-CHARACTER',trigger='P2 optimize命中人物候选',mode='direct',role='aggregation',prompt='prompts/merge/08-optimize-characters.md',input='CharacterOptimizationTask',output='dynamic: fixed entity IDs/name enums/fact IDs',tool='submit_result',temperature=0,maxTokens='min(16384,reserve,model.maxTokens or 16384)',commit='调用方核事实覆盖/当前版本后更新展示字段与缓存',coverage='defined-static-not-rebuilt'),
dict(id='PROMPT-P2-LOCATION',trigger='P2 optimize命中地点候选',mode='direct',role='aggregation',prompt='v2.2/prompts/optimize-locations.md',input='LocationOptimizationTask: target binding incomplete',output='v2.2/model-output-contract.json#LocationOptimizationSchema',tool='submit_result',temperature=0,maxTokens=8192,commit='调用方核description事实覆盖/版本后更新展示',coverage='partial: RQ-01'),
dict(id='PROMPT-P3-WINDOW',trigger='P3 window_link窗口内子任务',mode='agent',role='aggregation',profile='story_editor',prompt='v2.2/prompts/p3-story-editor.md',input='StoryTask phase=window_link: target binding incomplete',output='v2.2/model-output-contract.json#AgentTaskSummarySchema',writePayload='v2.2/model-output-contract.json#LinkEventLinesResultSchema',tool='commit_story_changes + submit_result',temperature=0,maxTokens='min(model.maxTokens or 8192,reserve)',commit='写工具原子提交叙事实体/记忆/确认',coverage='partial: RQ-01/RQ-03/RQ-04'),
dict(id='PROMPT-P3-GLOBAL',trigger='P3 global_review孤点/线/事项队列子任务',mode='agent',role='aggregation',profile='story_editor',prompt='v2.2/prompts/p3-story-editor.md',input='StoryTask phase=global_review: target binding incomplete',output='v2.2/model-output-contract.json#AgentTaskSummarySchema',writePayload='v2.2/model-output-contract.json#LinkEventLinesResultSchema',tool='commit_story_changes + submit_result',temperature=0,maxTokens='min(model.maxTokens or 8192,reserve)',commit='写工具原子提交；未完队列不能标全书完成',coverage='partial: RQ-01/RQ-03/RQ-04'),
dict(id='PROMPT-COMPACT',trigger='P3上下文超预算或一次强制恢复',mode='direct',role='aggregation',prompt='prompts/session/07-compact-story-session.md',input='CompactionTask',output='schemas.json#SessionCompactionResultSchema',tool='submit_result',temperature=0,maxTokens='min(16384,max(128,floor(window/8)))',commit='压缩有效且变小才追加compaction；不删历史',coverage='defined-static-not-rebuilt'),
dict(id='PROMPT-PROBE-DIRECT',trigger='设置页已保存配置的生成探测',mode='direct',role='extraction or selected role',prompt=None,input='user: 回复一个字：好',output='nonempty Pi text; no output schema',tool=None,temperature='omit',maxTokens=8,commit='无业务写入',coverage='partial: target Pi call specified, current implementation raw HTTP'),
dict(id='PROMPT-PROBE-AGENT',trigger='设置页归并工具探测',mode='agent',role='aggregation',profile='isolated probe',prompt=None,input='probe instructions must agree with selected result schema',output='target probe summary/write validation not fully specified',tool='isolated probe implementations; no real books',temperature='omit',maxTokens=512,commit='无真实业务写入',coverage='partial: RQ-01/RQ-05'),
]
for call in calls:
    if call['prompt']:
        p=RES/call['prompt']; call['promptSha256']=digest(p)

bindings={
'ChapterTask':{'shape':{'chapterIndex':'string, required, chapters.chapterIndex','chapterName':'string, required, chapters.chapterName','text':'string, required, chapterTexts.text; full chunk, never truncate silently'},'userTemplate':'章节标识：{chapterIndex}\n章节名：{chapterName}\n\n--- 正文开始 ---\n{text}\n--- 正文结束 ---','history':'none; world and narrative calls are independent','timestamp':'Unix milliseconds from application clock'},
'CharacterOptimizationTask':{'shape':{'stage':'literal P2 for target','entities':'array, 1..3 items per call'},'item':{'id':'current character ID','name':'current primary name','aliases':'current aliases, [] when absent','reason':'local optimization trigger description, not model-created','previous':'last valid optimized identity/appearance/personality/background; {} if absent','facts':'array of {id:local F1/F2...,field:one of 4 text fields,text:string}; source is unoptimized facts, all facts if none remain','conflicts':'mergeNotes or []'},'serialization':'JSON.stringify({stage,entities}); input local fact ID -> persistent fact ID mapping retained by caller','dynamicSchema':'entities object keys exactly current item IDs; each entity name/aliases enums are deduplicated [name,...aliases]; covered_fact_ids enum local fact IDs with minItems=maxItems=fact count, uniqueItems=true; additionalProperties=false; all entity keys required'},
'CompactionTask':{'shape':{'previousSummary':'string, previous successful compaction summary, empty -> 无','transcript':'string; selected non-system original messages with original entry IDs, exclude compaction entry body'},'userTemplate':'【旧摘要】\n{previousSummaryOr无}\n【需要压缩的原始会话数据】\n{transcript}','transcriptItemTemplate':'[原始条目 {entryId}，角色 {role}]\n{JSON.stringify(message)}','join':'two LF characters; chunking and token budget in 05 AI-08'},
'IdentityTask':{'knownFields':['bookId','runId','kind','scope=fullBook','cursor'],'missing':['stable subtask identity and resume checkpoint binding','exact user message template and field defaults','P2 stateless Agent system wrapper and maximum output budget','persistent task-local commit allow-list']},
'LocationOptimizationTask':{'knownFields':['current entity ID/revision','description','fact IDs/text/source','conflicts'],'missing':['exact object field names and serialization order','local-vs-persistent fact ID mapping','input facts vs previous description merge semantics']},
'StoryTask':{'knownFields':['bookId','runId','sessionId','phase','window or work queue','node IDs','line summaries','memory','cursor','remaining count'],'missing':['typed scope/queue unit and paging snapshot','exact phase-specific user message templates','stable subtask-to-commit association','partial output next-task/resume selection']},
}
save(RES/'v2.2/prompt-call-manifest.json',{'version':'2.2-audit','status':'partial-not-a-complete-target-prompt-pack','calls':calls,'bindings':bindings,'retiredPrompts':['03-merge-world-assets','prompts/merge/04-link-event-lines.md','prompts/merge/05-detect-alias-groups.md','prompts/merge/06-merge-locations.md'],'note':'Old prompt/body/replay assets remain historical. This inventory explicitly preserves missing bindings instead of inventing them.'})

# 保留审查前的关键冲突证据，即使随后修正文档，也可复核原发现。
files=['04-Spec-流程接口与算法.md','05-Spec-AI与会话.md','12-验收执行与覆盖矩阵.md']
snapshot={name:{'sha256':digest(ROOT/name),'lines':[(i,line) for i,line in enumerate((ROOT/name).read_text(encoding='utf-8').splitlines(),1) if any(q in line for q in ['事件串联/复核 |','在事务内验证旧节点、全部线','全书P1','尚未接入自动runner','本轮只执行'])]} for name in files}
before=ROOT/'evidence/2026-10-23-reconstruction-audit-before.json'
if not before.exists(): save(before,snapshot)
print('10 prompt call sites inventoried; missing target bindings explicitly retained')
