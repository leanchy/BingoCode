import * as React from 'react'
import type { LocalJSXCommandContext } from '../../commands.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import { updateSettingsForSource } from '../../utils/settings/settings.js'

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
  args?: string,
): Promise<React.ReactNode | null> {
  const arg = args?.trim().toLowerCase()
  const enable = arg !== 'off'

  // Persist to disk
  updateSettingsForSource('userSettings', { execMode: enable })

  // Update AppState to trigger React re-render (like /fast does)
  if (enable) {
    context.setAppState(prev => ({ ...prev, execMode: true }))
    onDone('✓ Exec Mode enabled')
  } else {
    context.setAppState(prev => ({ ...prev, execMode: false }))
    onDone('✗ Exec Mode disabled')
  }
  return null
}
