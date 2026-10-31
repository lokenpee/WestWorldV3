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

async function bootstrap() {
  const workspace = createWorkspace()
  let repository: BookRepository = workspace
  let importer = createImportService(workspace)
  let assets = createAssetService(workspace)
  let backups = createBackupService(workspace, importer)
  let models = createModelService(workspace)
  let extraction = createExtractionService(workspace, models)
  let world = createWorldService(workspace, models, assets)
  let story = createStoryService(workspace, models)
  let acceptanceTools: ReactNode
  const acceptanceStage = new URLSearchParams(location.search).get('acceptance')
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
  createRoot(document.getElementById('root')!).render(
    <StrictMode><App repository={repository} importer={importer} assets={assets} backups={backups} models={models} extraction={extraction} world={world} story={story} acceptanceTools={acceptanceTools} /></StrictMode>,
  )
}

void bootstrap().catch(error => {
  const root = document.getElementById('root')!
  root.setAttribute('role', 'alert')
  root.textContent = `页面初始化失败，请刷新重试。${error instanceof Error ? error.message : ''}`
})
