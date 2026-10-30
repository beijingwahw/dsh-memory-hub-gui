/**
 * 构建脚本：esbuild 三目标打包（main / preload CJS + renderer IIFE）+ 静态资源拷贝
 * 产物全部落入 dist/——electron-builder 只需打包 dist + package.json（零运行时 node_modules）。
 */
import { build } from 'esbuild'
import { mkdir, copyFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(root, 'src')
const dist = join(root, 'dist')

const watch = process.argv.includes('--watch')

await mkdir(join(dist, 'renderer'), { recursive: true })

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  sourcemap: true,
  logLevel: 'info',
  legalComments: 'none',
}

const mainOptions = {
  ...common,
  entryPoints: [join(src, 'main', 'index.ts')],
  outfile: join(dist, 'main', 'index.cjs'),
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['electron'],
}

const preloadOptions = {
  ...common,
  entryPoints: [join(src, 'preload', 'index.ts')],
  outfile: join(dist, 'preload', 'index.cjs'),
  platform: 'node',
  format: 'cjs',
  target: 'chrome130',
  external: ['electron'],
}

const rendererOptions = {
  ...common,
  entryPoints: [join(src, 'renderer', 'index.ts')],
  outfile: join(dist, 'renderer', 'app.js'),
  platform: 'browser',
  format: 'iife',
  target: 'chrome130',
}

if (watch) {
  const ctxMain = await (await import('esbuild')).context(mainOptions)
  const ctxPreload = await (await import('esbuild')).context(preloadOptions)
  const ctxRenderer = await (await import('esbuild')).context(rendererOptions)
  await Promise.all([ctxMain.watch(), ctxPreload.watch(), ctxRenderer.watch()])
  console.log('[build] watching…')
} else {
  await Promise.all([build(mainOptions), build(preloadOptions), build(rendererOptions)])
  await copyFile(join(src, 'renderer', 'index.html'), join(dist, 'renderer', 'index.html'))
  await copyFile(join(src, 'renderer', 'styles.css'), join(dist, 'renderer', 'styles.css'))
  console.log('[build] done →', dist)
}
