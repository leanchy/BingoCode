import * as React from 'react'
import type { LocalJSXCommandContext } from '../../commands.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import { logError } from '../../utils/log.js'
import { updateSettingsForSource } from '../../utils/settings/settings.js'

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
  args?: string,
): Promise<React.ReactNode | null> {
  try {
    const arg = args?.trim().toLowerCase()
    const enable = arg !== 'off'

    // Persist to disk
    const result = updateSettingsForSource('userSettings', { execMode: enable })
    if (result.error) {
      logError(result.error)
    }

    // Update AppState to trigger React re-render (like /fast does)
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
    onDone(`Exec command error: ${String(e)}`, { display: 'system' })
    return null
  }
}
