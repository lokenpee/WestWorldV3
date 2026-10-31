import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    include: [
      '@earendil-works/pi-ai/models',
      '@earendil-works/pi-ai/utils/event-stream',
      '@earendil-works/pi-ai/api/openai-completions',
      '@earendil-works/pi-ai/api/openai-responses',
      '@earendil-works/pi-ai/api/anthropic-messages',
      '@earendil-works/pi-ai/providers/deepseek',
      '@earendil-works/pi-ai/providers/openai',
      '@earendil-works/pi-ai/providers/anthropic',
      '@earendil-works/pi-agent-core',
    ],
  },
})
