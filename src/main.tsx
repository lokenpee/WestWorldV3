import { createStoryService } from './features/story/service'
import { createWorldService } from './features/world/service'
import { createExtractionService } from './features/extraction/service'
import { StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { createWorkspace, type BookRepository } from './lib/storage/workspace'
import { createImportService } from './lib/storage/importService'
import { createAssetService } from './features/assets/service'
import { createBackupService } from './features/backup/service'
import { createModelService } from './features/models/service'
import { httpStorageCall, watchDiskRevision } from './features/local-storage/client'
import { StoragePanel } from './features/local-storage/StoragePanel'

async function bootstrap() {
  const acceptanceStage = new URLSearchParams(location.search).get('acceptance')
  const fixture = import.meta.env.DEV && ['stage1', 'stage2', 'assets', 'merge', 'backup', 'models', 'world', 'story'].includes(acceptanceStage ?? '')
  const disk = fixture ? undefined : httpStorageCall()
  if (disk) await disk({ action: 'status' })
  const workspace = createWorkspace(undefined, disk)
  let repository: BookRepository = workspace
  let importer = createImportService(workspace)
  let assets = createAssetService(workspace)
  let backups = createBackupService(workspace, importer)
  let models = createModelService(workspace)
  let extraction = createExtractionService(workspace, models)
  let world = createWorldService(workspace, models, assets)
  let story = createStoryService(workspace, models)
  let acceptanceTools: ReactNode
  if (import.meta.env.DEV && (acceptanceStage === 'stage1' || acceptanceStage === 'stage2' || acceptanceStage === 'assets' || acceptanceStage === 'merge' || acceptanceStage === 'backup' || acceptanceStage === 'models' || acceptanceStage === 'world' || acceptanceStage === 'story')) {
    const { createStage1Acceptance } = await import('./dev/Stage1Acceptance')
    importer.close(); workspace.close()
    const acceptance = createStage1Acceptance(acceptanceStage === 'story' ? 'story' : acceptanceStage === 'world' ? 'world' : acceptanceStage === 'models' ? 'models' : acceptanceStage === 'backup' ? 'backup' : acceptanceStage === 'merge' ? 'merge' : acceptanceStage === 'assets' ? 'assets' : acceptanceStage === 'stage2' ? 2 : 1)
    repository = acceptance.repository
    importer = acceptance.importer
    assets = acceptance.assets
    backups = acceptance.backups
    models = acceptance.models
    extraction = acceptance.extraction
    world = acceptance.world
    story = acceptance.story
    acceptanceTools = <acceptance.Tools />
  }
  const root = createRoot(document.getElementById('root')!)
  const renderApp = () => root.render(
    <StrictMode><App repository={repository} importer={importer} assets={assets} backups={backups} models={models} extraction={extraction} world={world} story={story} acceptanceTools={acceptanceTools} storageTools={disk && <StoragePanel call={disk} />} /></StrictMode>,
  )
  if (disk) {
    const stop = watchDiskRevision(disk)
    window.addEventListener('pagehide', stop, { once: true })
    if (!await workspace.settings.appSettings.get('storage.ready')) {
      root.render(<main className="placeholder-page"><h1>本机书库已就绪</h1><StoragePanel call={disk} onContinue={async () => {
        await workspace.settings.appSettings.put({ key: 'storage.ready', value: true }); renderApp()
      }} /></main>)
      return
    }
  }
  renderApp()
}

void bootstrap().catch(error => {
  const root = document.getElementById('root')!
  root.setAttribute('role', 'alert')
  root.textContent = `页面初始化失败，请刷新重试。${error instanceof Error ? error.message : ''}`
  const retry = document.createElement('button')
  retry.textContent = '重新连接'
  retry.onclick = () => location.reload()
  root.appendChild(retry)
})
