from pathlib import Path
import importlib.util,json
OUT=Path(__file__).resolve().parent.parent
spec=importlib.util.spec_from_file_location('complete',Path(__file__).with_name('complete-spec.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
ops=[]
def add(label,page,event,inputs,guard,reads,writes,steps,success,error,repeat='不新增幂等或取消机制；组件状态按原生命周期。',flow=None):
 ident=f'OP-{len(ops)+1:02}'
 ops.append(dict(id=ident,label=label,page=page,event=event,inputs=inputs,guard=guard,reads=reads.split(';')if reads!='无'else[],writes=writes.split(';')if writes!='无'else[],steps=steps,success=success,error=error,repeat=repeat,flow=flow))

add('切换顶层标签','外壳','click 资产/游玩/设置','目标view枚举','始终可点','无','内存ui.activeView','同步setActiveView；条件挂载对应面板；不调用模型','URL不变，目标组件出现','无专设错误态','离开游玩销毁消息，离开设置丢未保存表单；编译核心异步仍运行')
add('选择书籍/进入','书架','click卡片或进入','book.id','sidebar.blocked=false','T03.id/title;选中书各库列表','内存ui.bookId/selectedAssetId;局部showImport=false','setBookId清全局选择；key=bookId工作台重挂载并响应式查询','列表/章/进度切换本书','查询错误无全局ErrorBoundary','切书清工作台局部详情；global compile-store不自动按书隔离')
add('打开导入页','书架/工作台','click＋导入小说/导入另一本','无','书架blocked=false；工作台按钮依R/P/running禁用','无','局部showImport=true','仅改变右侧面板；当前bookId不清空','导入面板出现','无','已有当前书仍在，可通过书架再次进入')
add('修改分章正则','导入','input change','原样字符串chapterRegex','!busy','局部preview.chapterRegex','局部chapterRegex/error=null','仅设置输入；不分章、不发模型','旧预览保留；值不同则显示过期提示并禁用导入','无即时语法校验','每次编辑都要求apply后才可用新预览')
add('应用/恢复默认正则','导入','click apply/default','当前字符串；default使用默认正则.toString','!busy','局部preview.decode.text/bytes','局部preview.chapters/chapterRegex,error','parseChapterRegex；有preview则splitChapters，成功替换预览；default同时改输入','新预览有效','catch显示具体错误，旧preview不替换','无持久写入，未选文件仍可检查正则')
add('选择或拖放TXT','导入','file change/drop','首个File，arrayBuffer→decodeBytes；parse当前regex','file选择器accept=.txt；drop不复验后缀，无busy统一禁止','本地所选文件','局部preview={fileName,bytes,decode,chapters,chapterRegex},error','parse→await arrayBuffer→decode→split；顺序不调用模型','UTF8/GBK、章名/长度/总数显示前200条','catch error字符串显示，未清旧preview','drop只读第一文件；不保存完整bytes到DB',flow='DF-01')
add('按UTF8/GBK重读','导入','click编码按钮','preview.bytes+所选encoding','preview存在；无busy额外禁用','原始文件bytes','局部preview.decode/chapters/chapterRegex,error','decodeWith→用当前regex分章→替换预览','编码和预览刷新','catch显示，原预览保留','不修改原文件，不发模型')
add('换一个文件','导入','click','无','没有额外busy禁用','无','局部preview=null','清预览，不清regex','回到无预览','无','下次选择仍用当前regex')
add('仅导入','导入','click仅导入','newUUID书ID、去扩展文件title、preview.decode.text、regex','!busy、预览匹配regex且章数>0','局部preview','T03整条;T04/T05整章;T12.P1初始进度;内存bookId','busy=true→检查预览→await importBook→setBookId→compileStore.reset→回调关导入选人物','进入空草稿工作台；无模型请求','catch导入错误，finally busy=false；跨库失败可留书架','不去重同名书；每次新ID',flow='DF-01')
add('导入并完整提取','导入','click完整提取','同仅导入+signal=beginRun()','同仅导入','同上','同上;后续T06–T09/T12–T17','先await导入并选书，再不await地runAll；catch流水线失败写日志/failed；回调立刻进工作台','立即显示处理界面；完成依事件更新','导入catch回面板；任务catch全局日志，已导入保留','切页不自动cancel；关闭页面中断',flow='DF-02')
add('切换资产分类','工作台','click六标签','assetTab=characters/locations/nodes/lines/network/memory','始终可用','当前书对应查询','内存assetTab;局部selected=null','同步选标签、清详情','显示对应列表/图/记忆','空态依类型','任务中可切换，不中断任务')
add('筛选人物层级','人物列表','click全部/四层级','roleFilter','无运行禁用','T06.roleWeight（缺省按NPC）','局部roleFilter','内存过滤已加载快照，不修改数据库','符合层级的人物列表','空结果仍人物空态','筛选状态随工作台卸载重置')
add('打开资产详情','四列表/图','click行或图节点','选中对象快照asset={kind,item}','有对象；不检查compile锁','T06/T07/T08/T09当前查询对象','局部selected/toEditable表单','设置局部选中；详情根据kind初始化值','右384px详情栏','无独立取详情加载API','selected保存旧对象；列表更新不替换它，BUG-16')
add('编辑表单输入','资产详情','input/textarea change','UI-05字段到values[key]原字符串','无统一任务/必填校验','局部values','局部values','仅修改对应表单键；普通输入不自动保存','显示输入值','无即时required错误','切标签/关闭无未保存提示；尚未持久化')
add('保存人物','人物详情','click保存','主名/别名/身份/profile.ageText/四文本/原话；CSV拆逗号trim，字符串仅trim判空','!saving','T06整条及mergeFacts/cache','T06对应字段/updatedAt;四文本变化时mergeFacts/optimizedFactIds/optimizationFingerprint','saving→fromEditable→await updateCharacterSnapshot事务→savedAt；onChanged无实际重读详情','列表通过useLiveQuery刷新，页脚已保存；普通文本局部值保留','finally恢复saving；无统一catch toast','不统一Schema校验；空必填可undefined，P3不失效',flow='DF-06')
add('保存地点','地点详情','click保存','name/aliases/description同表单转换','!saving','T07被选行','T07三字段/updatedAt','await updateLocationSnapshot→savedAt；原详情只读区仍旧对象','列表刷新，已保存','无专设错误UI，finally解saving','不即时同步T11',flow='DF-06')
add('保存事件节点','节点详情','click保存','name/summary/process/actors/time_text/time_hint/targets/world_delta/new_facts/started_actions','!saving','局部values，T08行按id更新','T08提交patch（未自动更新actorIds/eventLineIds）','fromEditable→await updateNode→已保存；运行时patch含UI字段，不被较窄TS别名过滤','列表/图读新节点；详情只读区可旧','无完整Schema/原文校验，无统一catch','不自动重算T09派生或更新P3标记',flow='DF-06')
add('保存事件线','线详情','click保存','title/cause/process/result','!saving','局部values','T09四文本，不统一updatedAt','await updateEventLine→savedAt','线列表/图标题可变','无统一catch；finally解saving','不修改nodeIds，不重算派生',flow='DF-06')
add('即时改变人物层级','人物详情','select change','roleWeight值，当前id/bookId','无saving/任务统一禁用','当前selected快照','T06.roleWeight/roleWeightSource=manual/updatedAt;局部savedAt','await setCharacterRoleWeight→setSavedAt→onChanged空回调','列表新层级；旧详情Select可回显旧层级，关闭重开才读新','无统一catch','不待保存按钮；不得自动改为整表单提交',flow='DF-06')
add('即时改变事件线状态','线详情','select change','open/closed','无统一禁用','当前selected线','T09.lineStatus;局部savedAt','await updateEventLine→setSavedAt','列表状态变化，旧详情Select回显规则同BUG-16','无统一catch','不自动写updatedAt或修改正文',flow='DF-06')
add('选择并入目标/并入','人物地点详情','select change→click并入','目标keepId、mergeIds=[当前id]','目标非空才启按钮；仅同类非自己','T06或T07目标及当前全记录','同表目标融合put+其余delete','await merge；缺目标抛错；成功清mergeTarget，onChanged，关闭详情','目标保留，数量减少，资料融合','无二次确认或全局catch','不可撤销；不改已入库实体',flow='DF-07')
add('关闭详情','资产详情','click关闭','无','始终','无','局部selected=null','卸载详情，不保存','右栏消失','无','未保存输入丢弃；持久即时变更保留')
add('删除人物/地点草稿','人物地点列表','click删除，stopPropagation','当前bookId/id/kind','无运行统一禁用','当前对象id','T06或T07 delete单行;局部selected=null','void调用delete；同步清详情；不打开确认','列表订阅数量变化','未统一catch可能产生未处理错误','不删实体/文本称呼/原节点',flow='DF-07')
add('删除节点','节点列表','click删除','bookId/node.id','无统一禁用','T08全部;T09全部','T08删除并重算eventLineIds;T09有效成员/chapters/timeRange/characterIds，删空线','事务内删节点→逐线过滤/派生/删空→重建节点归属；UI同步清selected','节点/图/线数量和引用一致','事务失败回滚，无统一toast','不清人物/地点',flow='DF-08')
add('删除事件线','线列表','click删除','bookId/line.id','无统一禁用','T08.eventLineIds','T09删除线;T08移除该归属','节点+线事务；UI清selected','节点仍在，散落状态可能增加','事务失败回滚','无二次确认，不删成员节点',flow='DF-08')
add('展开只读字段/事实/经过','详情/试跑/历史','native details toggle','对应details','内容存在','当前selected或result/entry；不是每次回读DB','局部原生details开闭','字段为Schema+record键并集；复杂值JSON2缩进；历史另分页','展开指定只读内容','undefined/null→未填写','无业务写入；旧selected可旧显示')
add('开始完整流程/重新检查','工作台','click继续/重新检查','bookId,signal=beginRun(),recheck=progress.completed&&!testScope','!rerunning且C≠running','T04/T12–T17及所有草稿/原文','T06–T09/T12–T17;全局compileStore','rerunning=true→await runAll；事件更新；catch日志/failed；finally false','按钮恢复，日志和阶段结果；P1完成章仍跳过','同书锁冲突/任务错写日志，不清已提交资产','按计划/会话恢复，不是重提全书',flow='DF-02')
add('执行分阶段按钮','工作台','click四阶段之一','step=p1/p2-merge/p2-link/p3、bookId、beginRun.signal','!R/P/T、C≠running、无局部active','T04/T12及执行相关表','相应草稿/进度/会话；先删除旧P3，p1另删P2','先选人物或线并清详情，active=step→await runTestStage→catchfailed日志→finally active=null','仅跑所选步，P3样本testScope可入库','非P1样本P1不全则报错，无强制P2前序','成功阶段写草稿，不是沙盒',flow='DF-03')
add('取消编译','进度条','click取消','当前AbortController','仅显示状态running','内存controller','signal.aborted；任务后续T12 cancelled/批checkpoint','同步abort；已提交不撤销；任务检查signal决定何时退出','最终cancelled提示可继续','退避sleep本身不中断，可能延后','不强制先显示cancelling，不关标签代替取消',flow='DF-02')
add('入库','工作台','click入库/入库测试草稿','当前bookId','!publishing、C≠running、最近进度P3 completed','T06/T07/T08/T09当前草稿','T10/T11清表重建;T08.actorIds;T09.characterIds','publishing=true→await publishCanon四表事务→setPublishedNote→finallyfalse','人物地点数量/未匹配数量提示；标识按固定人物>0','无底层P3/待复核再次校验，无统一catch','重复替换而不叠加；不保历史版本',flow='DF-09')
add('关闭入库提示','工作台','click知道了','无','提示存在','无','局部publishedNote=null','仅隐藏提示','提示消失','无','不影响资产')
add('打开/关闭单章试跑','工作台/试跑','click试跑一章或关闭','bookId','打开!R/P/running；关闭不禁running','当前书id','局部trying=true/false','打开只挂载；关闭销毁，不发abort','试跑弹窗或返回工作台','无','关闭在途不停止请求，最终结果不写草稿')
add('开始/重跑单章','试跑弹窗','click开始试跑/重跑','bookId，底层默认第一章','!running','T04首order章;T05正文','仅局部result/running/error','running=true→await tryOneChapter完整章两请求→result→finallyfalse','原文前2000、资产、时长、费用、失败详情','catch显示错误，结果包含子步骤失败','重跑不写入DB，不缓存到书籍',flow='DF-04')
add('图的高亮/全部','事件网络','click线名或全部节点','line.id或null','有节点','T08/T09派生graph','局部highlight','同一线再次点清高亮；无此线时active=null','其他节点/边淡化，不移除','无','不持久、不改线成员')
add('图缩放/平移/全图/起点','事件网络','ReactFlow controls/drag背景','viewport或fit命令','图存在','graph尺寸/章刻度','局部ReactFlow viewport','min0.08 max2；全图padding.15；起点x20/y0/zoom1；250ms动画','章轴同步，<.65简化卡片','无专设错误','不拖节点不手动连线；不存布局偏好')
add('选择故事会话','编辑记忆','select change','空=当前或archived.id','报告已加载','T16;T13/T14/T15/T17按session','局部selection/page=0','刷新查询指定同书会话；旧会话提示不代表当前通过','摘要/记录/历史按会话显示','底层不存在会话抛错，UI无统一兜底','不激活旧会话，不回滚资产')
add('切换工作/完整会话视图','编辑记忆','click视图按钮','work/history','可见','记忆报告或T17','局部view','切视图挂载工作区或SessionHistory','对应内容显示','未加载为空数组/读取提示','SessionHistory局部page随卸载重置')
add('筛选与翻页工作记录','编辑记忆','click all/decision/review/pending/stale、上一页下一页','filter/page','页界禁用','T14查询视图validity/status/kind','局部filter/page','筛选后page0，按50分页，页数随数据夹限','列表和计数；空分类提示','无','pending是review active；stale按validity，不是持久status')
add('历史翻页与长条目分段','完整会话','click上一页下一页/上一段下一段','page/offset','页界/段界禁用','T17 ordinal序列及JSON','局部page/offset','30条/页；单条JSON每12000字符；details原生展开','精确条目/字符范围','无','不改压缩边界或原始记录')
add('编辑模型配置','设置','input四字段change','baseUrl/extraction/aggregation/window字符串','无全局任务禁用','局部表单','局部对应字段','不自动保存、不用于下一次探测直到save','显示未保存值','无即时完整校验','离开设置丢草稿；保存Key的refresh也可能覆盖')
add('保存模型配置','设置','click保存配置','trim地址/两模型，window空undefined否则Number','window若提供须整数≥8192','T02.llm.config原值','T02.llm.config.value和updatedAt','校验窗口→await setLlmConfig merge→success行及2200ms提示','已保存；空地址读取时回官方','非法窗口提示不写；其他异常无统一catch','不把Key一起保存；无额外busy禁用',flow='DF-12')
add('输入/保存Key','设置','password change→click保存','apiKeyDraft.trim','保存按钮仅trim非空','T01当前provider','T01.deepseek.credential;局部Key输入清空','await saveApiKey→清输入→await refresh全配置/Keyhint/concurrency→flash','只显示掩码尾4，短Key全掩码','无统一catch','不触网；不更改导出数据',flow='DF-12')
add('清除Key','设置','click清除','provider=deepseek','configured=true','T01','T01 delete provider','await remove→refresh→flash','测试禁用，hint消失','无统一catch','不清资产/其他配置',flow='DF-12')
add('拉取模型','设置','click拉取模型','保存的URL+Key','无loading禁用；无Key服务会报错','T01/T02','仅局部catalog/model输入/status','loading→await GET /models→去重排序；当前输入不在目录则暂选第一','数量成功行，尚需保存配置','catch错误行；空目录单独提示','不自动持久模型选项；可能重复触发',flow='DF-13')
add('测试提取模型','设置','click测试提取','保存URL/Key/extractionModel','按钮!configured禁用；handler loading时不执行','T01/T02','局部status','最小文本HTTP请求，显示elapsed与detail截取','2xx可空回复也成功；不证明工具提取','catch或非ok错误行','不保存会话/资产',flow='DF-13')
add('测试归并工具','设置','click测试归并','保存归并模型，Schema{ok:true}','!configured或loading禁用','T01/T02；工具声明不查小说','局部status','runAgent最多2轮30s；工具execute固定PROBE_ONLY','必须有效submit_result才成功','错误原样部分截取显示','不建持久故事会话、不写业务资产',flow='DF-13')
add('修改/保存并发','设置','number change→click保存','Number(input.value)；round+clamp','没有额外busy/NaN显式防护','T02现值','T02.compile.concurrency和updatedAt','await setConcurrency→refresh所有设置→flash','显示保存后数值','无统一catch','未保存不影响任务；新任务读取保存配置',flow='DF-12')
add('清空日志','设置','click清空日志窗口','无','无','无','仅compileStore.logs=[]','同步clearLogs','日志区空','无','不清数据库会话、进度或费用')
add('预览备份文件','设置数据','file change','Uint8Array(await file.arrayBuffer())','file label未按全局busy禁用','本地ZIP','局部importPreview.bytes/inspect','await inspectBackup→设置preview；input.value立即清供重选','显示标题/固定实体统计/确认取消或错误列表','handlePickBackup无catch，畸形统计JSON可未处理拒绝','不写库直到确认',flow='DF-10')
add('确认/取消备份导入','设置数据','click确认/取消','缓存preview.bytes','确认inspect.ok且!busy；取消无busy统一限制','ZIP内容','T03新书;目标新书T04–T17;ui.bookId','busy→await importBackup→setBookId→清preview→flash→finallyfalse；取消只清preview','新书（导入），仍停留设置页','confirm catch显示flash；跨库可留书架','每次新建，不覆盖当前书',flow='DF-10')
add('设置页下载备份','设置数据','click导出备份','当前bookId','busy或无书禁用','T03及本书T04–T17','文件下载;局部busy/flash','await exportBook→Blob URL→a.click→立即revoke→flash→finally','已导出filename','catch flash','不删除浏览器数据；与书架延迟revoke不同',flow='DF-10')
add('打开导出/删除弹窗','书架','click对应书操作','书籍对象','sidebar.blocked=false','T03当前卡','局部exporting或deleting/message空','仅打开；不写文件不删库','dialog aria与说明出现','无','不因遮罩/Escape自动关闭')
add('选择导出目录','书架','click选择导出目录','浏览器showDirectoryPicker结果handle','!blocked且API支持','T02目录旧句柄','T02.assets.exportDirectory/updatedAt','sidebar.busy→await picker→remember→directory.name→提示','目录名显示，路径字符串只是建议','AbortError不提示；其他错误message','权限仍在实际写文件时再检查',flow='DF-10')
add('保存到目录','导出弹窗','click保存到目录','exporting.bookId，已存handle或重新picker','!blocked且API支持','T02句柄;T03和T04–T17','新文件写入；必要时T02句柄','授权检查→export→文件名随机后缀→createWritable/write/close→关弹窗','已保存到目录+filename','失败abort尝试，弹窗保留rolealert','busy期间取消禁用；不覆盖同名历史备份',flow='DF-10')
add('书架下载备份','导出弹窗','click下载备份','exporting.bookId','!blocked','T03及本书表','下载文件;sidebar.message','await exportBook→DOM a添加点击移除→1000ms后revoke→关弹窗','已请求下载filename','catch保留弹窗显示','浏览器下载提示不等于已验证磁盘文件',flow='DF-10')
add('删除弹窗先导出','删除弹窗','click先导出','同一本书','!blocked','无','局部exporting=deleting;deleting=null','切到导出弹窗','等待用户选择导出','无','导出成功不继续自动删除')
add('确认删除整书','删除弹窗','click确认删除','deleting.id','!blocked；底层同书编译锁再次检查','T03/目标库缓存实例','删除本书DB(T04–T17)+T03记录','withLock→close/cache移除→await Dexie.delete→await books.delete→切另一书/导入→关弹窗','当前书消失，其他书/Key/导出文件保留','catch弹窗保留；非跨库原子','永久删除，无回收站；本轮UI不执行最终删除',flow='DF-11')
add('取消导出/删除弹窗','弹窗','click取消','无','只在busy禁用','无','局部exporting/deleting=null','关闭','无副作用','无','遮罩和Escape没有实现处理')
add('输入与发送游玩消息','游玩','input change/Enter非Shift/click发送','trim后非空text，当前bookId','无书禁输入；无书或trim空禁发送','内存bookId/input','仅局部lines追加player+固定narrator，input清空','不调用模型/DB，新增后自动滚底','固定占位说明','无','切顶层卸载清消息；无多行或历史恢复',flow='DF-14')
add('图节点打开详情','事件网络','click ReactFlow节点','node.id找到nodes当前对象','有匹配node','T08当前查询nodes','局部selected=node','与列表详情同服务，图保持在左','节点表单和原文出处','找不到则no-op','不生成新节点，不改状态')

autos=[
('AUTO-01','AppShell挂载/卸载','无','events.on注册唯一applyEvent，卸载取消订阅','读任务事件；写global compile-store，无DB写入','重挂载不重播历史事件'),
('AUTO-02','资产页书架首次解析','initialSelection=false且books!==undefined','置true；无bookId且有书则选最新books[0]','T03 createdAt倒序→ui.bookId；不写书','每次该组件挂载仅判一次'),
('AUTO-03','useLiveQuery订阅','所用bookId/数据表变化','重查对应表、按规定排序/计数','T03/T04/T06–T10/T12–T17→列表/报告','写库后列表刷新；局部selected不自动替换'),
('AUTO-04','工作台忙状态变化/卸载','R/P/T任一变化','onBusyChange(R或P或T)；卸载false','仅父sidebar.disabled','不等于底层全局编辑锁'),
('AUTO-05','选择asset对象变化','asset prop引用变化','重置toEditable、savedAt=0、mergeTarget空','读selected字段→局部表单','useLiveQuery新数组不保证selected引用变化'),
('AUTO-06','日志数量变化','logs.length变化','日志scroller.scrollTop=scrollHeight','内存logs→DOM滚动','无持久写入'),
('AUTO-07','游玩消息数量变化','lines.length变化','消息区滚到底','局部lines→DOM','无世界状态结算'),
('AUTO-08','设置页挂载','无','离线catalog；异步refresh配置+Keyhint+并发；storage.estimate显示MB','T01/T02→局部；不读取真实Key到表单','刷新未完成字段可短暂空；卸载草稿消失'),
('AUTO-09','书架挂载','无','读exportDirectoryName，失败吞掉','T02.handle.name→局部directory','不会自动取得目录写权限'),
('AUTO-10','flash触发','成功/异常提示文字','setSaved(text)，2200ms后null','仅局部toast','旧计时器未统一去重，连续flash可提前清除后来提示'),
('AUTO-11','网络数据/viewport变化','nodes/lines/chapterIndices/zoom','计算chapter layout与卡片紧凑状态，轴跟随','T08/T09/T04→图视图，无写库','无自动因果推断'),
('AUTO-12','会话请求准备','已取得故事会话租约','投影→必要压缩→重注当前任务→校验可用窗口','T16/T17读写、归并摘要模型；原记录保留','超预算失败，不发未容纳的请求'),
('AUTO-13','每个模型message_end','story_editor持久session','JSON标准消息校验→appendSessionMessage','T17追加、T16 nextOrdinal/leafId/租约','仅响应成功不表示事件提交，commit才确认写入'),
('AUTO-14','恢复/检查资料变更','下一批读取旧记忆和checkpoint','重新计算原文/资产/节点/线指纹，stale和跳批判定','T05–T09/T13–T15读；结果为视图；新提交才写','不是后台定时自动检查，需继续任务'),
]
def make():
 body='''## 1. 操作清单与读写口径

本文给每个有效动作一条可实现契约；同处理逻辑的多入口/多参数选择合并，差异在条目内列明。UI仅输入变化与原生details开闭也纳入，无写入明确为无。库表编号T01–T17见[数据规格](03-Spec-数据与存储.md)，R/P/T/C含义见UI-04。

''' +f'本目录有 **{len(ops)} 组UI动作契约**和 **{len(autos)} 个自动触发契约**。这不是控件总数：重复行操作、六标签和同类输入按参数化组计数。\n\n'
 body+='| 操作编号 | 页面/入口 | 事件 | 关联数据流 |\n|---|---|---|---|\n'
 for o in ops:body+=f"| {o['id']} · {o['label']} | {o['page']} | {o['event']} | {o['flow']or'仅界面/查询，见本条'} |\n"
 for o in ops:
  body+=f"\n## {o['id']} · {o['label']}\n\n| 项目 | 规定 |\n|---|---|\n"
  for title,k in [('页面/事件','page'),('输入与参数映射','inputs'),('前置/禁用','guard'),('读取','reads'),('写入与即时状态','writes'),('执行顺序','steps'),('成功反馈','success'),('异常与部分结果','error'),('重复/关闭/刷新','repeat')]:
   v=o[k];v='；'.join(v)if isinstance(v,list)else v
   body+=f"| {title} | {str(v or '无业务读写').replace('|','或')} |\n"
 body+='\n## 自动触发清单\n\n| 编号 | 触发 | 守卫 | 顺序 | 数据与副作用 | 生命周期/限制 |\n|---|---|---|---|---|---|\n'
 for row in autos:body+='| '+' | '.join(row)+' |\n'
 body+='\n精确组件、字段和原始文案继续见[UI规格](06-界面与交互规格.md)。本目录规定动作语义，class与签名摘录不能替代上面的读取、写入和异常步骤。\n'
 m.write('09-操作与自动触发契约.md','WW-OPS','UI动作与自动触发契约',body)
 m.dump('resources/operation-catalog.json',ops)
 m.dump('resources/automatic-triggers.json',[dict(zip(['id','trigger','guard','steps','data','lifecycle'],a))for a in autos])
 print(f'{len(ops)} UI operation groups; {len(autos)} automatic triggers')
if __name__=='__main__':make()
