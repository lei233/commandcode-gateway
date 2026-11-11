/**
 * 进程入口：装配配置与依赖，启动服务，处理进程信号。
 */

import { resolve } from 'node:path'

import { loadConfig } from './config.ts'
import { startGateway } from './server.ts'
import type { AdapterConfig } from './commandcode.ts'

async function main(): Promise<void> {
  const config = loadConfig(resolve(import.meta.dirname, '..', 'config.json'))
  const adapter: AdapterConfig = {
    apiBase: config.apiBase,
    workingDir: config.workingDir,
    modelsCachePath: config.modelsCachePath,
  }
  const gateway = await startGateway({ config, adapter })
  process.stdout.write(`commandcode-gateway listening on ${gateway.address.host}:${gateway.address.port}\n`)

  let closing = false
  const shutdown = (signalName: string) => {
    if (closing) return
    closing = true
    process.stdout.write(`received ${signalName}, shutting down\n`)
    void gateway.close(5_000).then((outcome) => {
      process.stdout.write(`gateway stopped (${outcome})\n`)
      process.exit(0)
    })
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  gateway.server.on('error', (error) => {
    process.stderr.write(`server error: ${error instanceof Error ? error.message : String(error)}\n`)
  })
}

await main()
