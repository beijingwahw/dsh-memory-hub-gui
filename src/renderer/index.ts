/**
 * 渲染进程入口：装配应用骨架；#smoke 哈希时装载无头冒烟驱动
 */
import { App } from './app'
import { installSmokeDriver } from './smoke-driver'

function main(): void {
  const app = new App()
  ;(window as unknown as Record<string, unknown>).__mhApp__ = app
  if (location.hash.includes('smoke')) installSmokeDriver(app)
  void app.boot()
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', main)
} else {
  main()
}
