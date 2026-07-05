import type { Command } from '../../commands.js'
import { logError } from '../../utils/log.js'
import { updateSettingsForSource } from '../../utils/settings/settings.js'

const exec: Command = {
  type: 'local-jsx',
  name: 'exec',
  description:
    'Enable execution policy — dispatch-first, context protection, compressed output',
  aliases: ['executor'],
  argumentHint: '[off]',
  isEnabled: () => true,
  immediate: true,
  async load() {
    return {
      async call(onDone, context, args) {
        try {
          const arg = String(args ?? '').trim().toLowerCase()
          const enable = arg !== 'off'

          const result = updateSettingsForSource('userSettings', { execMode: enable })
          if (result.error) {
            logError(result.error)
          }

          if (enable) {
            context.setAppState(prev => ({ ...prev, execMode: true }))
            onDone('✓ Exec Mode enabled', { display: 'system' })
          } else {
            context.setAppState(prev => ({ ...prev, execMode: false }))
            onDone('✗ Exec Mode disabled', { display: 'system' })
          }
          return null
        } catch (e) {
          logError(e instanceof Error ? e : new Error(String(e)))
          onDone(`Error: ${String(e)}`, { display: 'system' })
          return null
        }
      },
    }
  },
}

export default exec
