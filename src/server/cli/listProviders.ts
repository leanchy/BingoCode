import fs from 'fs/promises'
import path from 'path'
import os from 'os'

// 统一读取与服务端一致的 providers.json 位置
const home = process.env.CLAUDE_CONFIG_DIR || os.homedir();
const configPath = path.resolve(home, '.claude', 'bingo', 'providers.json')

async function main() {
  try {
    const raw = await fs.readFile(configPath, 'utf-8')
    const { activeId, providers } = JSON.parse(raw)

    if (!providers?.length) {
      console.log('没有任何 provider，请先添加。')
      return
    }

    console.log('当前 Providers 列表：')
    for (const p of providers) {
      const active = (p.id === activeId) ? '★ 当前激活' : ''
      console.log(
        `- ${p.name} (${p.id})\n  baseUrl: ${p.baseUrl}\n  apiKey: ${p.apiKey?.slice(0, 6) ?? ''}*** ${active}\n`
      )
    }
  } catch (e) {
    console.error('读取 providers.json 失败:', e)
    console.error('当前尝试访问路径:', configPath)
  }
}

main()
