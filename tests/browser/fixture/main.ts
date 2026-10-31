import { runProbe } from '../../support/pi-probe'

const runButton = document.querySelector<HTMLButtonElement>('#run')!
const abortButton = document.querySelector<HTMLButtonElement>('#abort')!
const result = document.querySelector<HTMLPreElement>('[data-testid="result"]')!

runButton.addEventListener('click', async () => {
  runButton.disabled = true
  result.dataset.state = 'running'
  try {
    const report = await runProbe(abort => {
      abortButton.disabled = false
      abortButton.onclick = abort
    })
    result.textContent = JSON.stringify(report, null, 2)
    result.dataset.state = 'passed'
  } catch (error) {
    result.textContent = String(error)
    result.dataset.state = 'failed'
  } finally {
    runButton.disabled = false
    abortButton.disabled = true
  }
})
