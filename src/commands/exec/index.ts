import type { Command } from '../../commands.js'

const exec: Command = {
  type: 'local-jsx',
  name: 'exec',
  description:
    'Enable execution policy — dispatch-first, context protection, compressed output',
  aliases: ['executor'],
  argumentHint: '[off]',
  isEnabled: () => true,
  immediate: true,
  load: () => import('./exec.js'),
}

export default exec
