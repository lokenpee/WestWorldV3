from pathlib import Path
import re,json
ROOT=Path(__file__).resolve().parents[1]
rev='| 2.2 | 2026-10-24 | 明确任务身份、命令意图、逐项覆盖、完整Prompt组装和隔离探测；补接口与验收夹具 | 目标需求补全；应用及独立重建仍待执行 |'
for f in ROOT.glob('[0-1][0-9]-*.md'):
    x=f.read_text(encoding='utf-8')
    x=x.replace('2026-10-21 / 2026-10-23（Asia/Shanghai）','2026-10-21 / 2026-10-24（Asia/Shanghai）').replace('2.2 / 2026-10-23（Asia/Shanghai）','2.2 / 2026-10-24（Asia/Shanghai）')
    if '### 修订记录' in x and rev not in x:
        lines=x.splitlines(); start=lines.index('### 修订记录')+1
        while start<len(lines) and not lines[start].startswith('|'):start+=1
        while start<len(lines) and lines[start].startswith('|'):start+=1
        lines.insert(start,rev);x='\n'.join(lines)+'\n'
    if f.name.startswith('00-'):
        x=re.sub(r'^\*\*可重建性复核结论.*$', '**当前交付状态（2026-10-24）：** 已补上上一轮列明的Prompt调用、任务/命令归属、逐项覆盖恢复和隔离探测的明显需求缺漏，权威位置为03第10节、04 ALG-12、05 AI-14/15及11第7节。需要随本包交付resources中的Prompt、Schema、依赖锁和样例；仅14篇Markdown仍不是完整材料。已有具体请求/恢复夹具及独立适配器入口，但目标应用和空白工程重建未执行，不能据此宣称已验证可100%复现。剩余验证范围见12的2026-10-24闭合表。',x,flags=re.M)
    if f.name.startswith('03-'):
        x=x.replace('`{operationKey,payloadFingerprint,commitId,committedAt,resultSummary}[]`','`{taskId,operationKey,payloadFingerprint,commitId,committedAt,resultSummary}[]`')
        x=x.replace('nextTaskOrdinal=0、reconciliationPass=0','nextTaskOrdinal=0、reconciliationPass=0、noProgressTasks=0')
    if f.name.startswith('04-'):
        x=x.replace('attempt+1；恢复原task不改分配清单','恢复原task不改分配清单；attempt只在实际发Provider请求前递增')
        x=x.replace('这份逐项覆盖结构目前仍缺失，见12的RQ-04，不能仅凭一个checked计数宣称此条已可实现','逐项覆盖结构已在03第10节和本文件ALG-12.4–6定义，不能仅凭一个checked计数代替')
    if f.name.startswith('05-'):
        x=x.replace('P1及未变事实整编/压缩Prompt复用原资源；P2判同和P3串联/复核使用resources/v2.2/prompts中的目标Prompt。','2026-10-24起所有有效Prompt使用resources/v2.2/prompts/active的目标版本，完整组装见AI-14。')
        replacements={'resources/prompts/extraction/01-extract-world-assets.md':'resources/v2.2/prompts/active/p1-world.md','resources/prompts/extraction/02-extract-narrative-assets.md':'resources/v2.2/prompts/active/p1-narrative.md','resources/v2.2/prompts/p3-story-editor.md':'resources/v2.2/prompts/active/p3-story.md','resources/v2.2/prompts/p2-asset-editor.md':'resources/v2.2/prompts/active/p2-identity.md','resources/v2.2/prompts/optimize-locations.md':'resources/v2.2/prompts/active/location-optimize.md','resources/prompts/session/07-compact-story-session.md':'resources/v2.2/prompts/active/compact.md','resources/prompts/merge/08-optimize-characters.md':'resources/v2.2/prompts/active/character-optimize.md'}
        for a,b in replacements.items():x=x.replace(a,b)
        x=re.sub(r'^串联用户消息包括阶段.*$', '串联/复核用户消息按AI-14的StoryTask规范JSON和story.txt模板组装，明确phase、分配项、窗口/队列、前50条已有线提示、工作摘要和恢复信息。旧模板参数资源仅作为2.1取证，不能代替目标请求。',x,flags=re.M)
        x=x.replace('maxSteps2/timeout30000/maxTokens512','每套maxSteps3/timeout30000/maxTokens1024')
        x=x.replace('（status/commitIds/summary/remainingWorkIds）','（status/commitIds/summary/remainingWorkIds/reviewedItems）')
        x=x.replace('## AI-13 提示词调用清单与重建缺口审查\n','## AI-13 提示词调用清单与重建缺口审查\n\n> 以下保留2026-10-23审查时的缺口记录；其中“缺失/未交付”不是当前状态。2026-10-24的完整定义与当前状态以AI-14/15、03第10节和12闭合表为准。\n') if '以下保留2026-10-23审查时的缺口记录' not in x else x
        x=x.replace('**当前仍不是完整的2.2 Prompt调用包。**','**2026-10-23历史审查结论：当时不是完整的2.2 Prompt调用包。**')
    if f.name.startswith('11-'):
        x=x.replace('Agent参数四项均必填：','Agent参数五项均必填：')
        x=x.replace('remainingWorkIds=非空string元素数组；数组本身可空。','remainingWorkIds=非空string元素数组、reviewedItems={workItemId,outcome,reason}数组；数组本身可空。reviewedItems与remainingWorkIds必须按第7节分割分配项。')
        x=x.replace('（status/commitIds/summary/remainingWorkIds）','（status/commitIds/summary/remainingWorkIds/reviewedItems）')
        x=x.replace('本书B已有C1-P001','本task分配C1-P001/C2-P001对应的两个workItem。本书B已有C1-P001')
        x=x.replace('summary:"本子任务已合并",remainingWorkIds:[]','summary:"本子任务已合并",remainingWorkIds:[],reviewedItems:[{workItemId:"ai_identity:fullBook:character:C1-P001",outcome:"changed",reason:"本task已合并"},{workItemId:"ai_identity:fullBook:character:C2-P001",outcome:"changed",reason:"并入目标"}]')
    if f.name.startswith('12-'):
        x=x.replace('## 2026-10-23 · 可重建性复核结论\n','## 2026-10-23 · 可重建性复核结论\n\n> 本节为上一轮历史审查，保留问题及反例供追溯；未闭合状态已由下方2026-10-24闭合表更新。不要把旧“缺失”描述当作当前契约。\n') if '本节为上一轮历史审查' not in x else x
        x=x.replace('部分；RQ-01/03/04','已补调用/身份/覆盖契约；应用验证待执行').replace('部分；RQ-02文档已修、RQ-04仍未闭合','已补实际读集/覆盖规则；应用验证待执行').replace('部分；RQ-03/04/06','任务/覆盖规则已补；完整目标验收仍待执行').replace('部分；RQ-01/03/05/06','调用/归属/探测已补；完整目标验收仍待执行')
    f.write_text(x,encoding='utf-8')
# 历史生成脚本加写保护，防止把新契约重新覆盖成旧差量。
for name in ['expand-data-dictionary.py','expand-tool-dictionary.py','audit-reconstructability.py']:
    f=ROOT/'scripts'/name;x=f.read_text(encoding='utf-8')
    marker="from pathlib import Path\n"
    guard="from pathlib import Path\nimport sys\nif '--legacy-snapshot' not in sys.argv:\n    raise SystemExit('该生成器已由2026-10-24目标契约取代；如确需生成旧快照，显式使用--legacy-snapshot，并勿覆盖当前规格。')\n"
    if '该生成器已由2026-10-24目标契约取代' not in x:x=x.replace(marker,guard,1);f.write_text(x,encoding='utf-8')
print('main-document dates, authoritative links, finalizer wording and historical-status markers synchronized')
