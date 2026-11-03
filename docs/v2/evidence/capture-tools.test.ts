import {it,expect}from'vitest'
import fs from'node:fs/promises'
import{createHarness}from'./baseline.adapter.ts'
it('记录13工具的真实执行分支，静态冻结为重建契约样例',async()=>{
 const base=JSON.parse(await fs.readFile(new URL('../resources/scenarios/table-flow-seed.json',import.meta.url),'utf8'))
 const tableNames=['storyEditorMemory','storyEditorNotes','storyEditorCheckpoints','storySessions','storySessionEntries']
 for(const name of tableNames)base.canon[name]=[JSON.parse(await fs.readFile(new URL('../resources/table-examples/'+name+'.json',import.meta.url),'utf8'))]
 const inputs:any={query_nodes:{},get_node_detail:{ids:['C1-N001']},query_event_lines:{},get_event_line_detail:{ids:['L01']},query_characters:{},get_character_detail:{ids:['C1-P001']},query_locations:{},read_original:{chapter_range:['1','1'],maxChars:12},get_editor_memory:{session_id:'session_example'},query_editor_notes:{session_id:'session_example'},get_editor_note_detail:{ids:['SN000001'],session_id:'session_example'},list_editor_sessions:{},query_editor_session_history:{session_id:'session_example',mode:'full'}}
 const records=[]
 const h=await createHarness()
 try{
  await h.reset();await h.load(base)
  for(const[name,args]of Object.entries(inputs)){
   const success=await h.execute('tool',{bookId:base.bookId,name,args})
   const invalid=await h.execute('tool',{bookId:base.bookId,name,args:{...args,unsupported_parameter:true}})
   expect(invalid.error).toBe('INVALID_ARGS')
   records.push({name,args,success,invalid})
  }
  await fs.writeFile(new URL('../resources/tool-response-examples.json',import.meta.url),JSON.stringify({seed:base,records},null,2))
 }finally{await h.close()}
})
