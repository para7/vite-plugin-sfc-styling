/// <reference lib="dom" />
// dev サーバーで、実ブラウザの初回ロードと CSS だけの HMR の時間を .module.css に分けた場合と比べる。
// 実行: pnpm bench:dev [ファイル数] [クラス数] [回数]
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { chromium, type Page } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import sfcCss from '../plugins/sfc-css.ts'
import { colorOf, generate, median, timed, VARIANTS, type Variant } from './lib.ts'

const [FILES = 500, CLASSES = 20, RUNS = 5] = process.argv.slice(2).map(Number)
const HMR_RUNS = 10
const browser = await chromium.launch()

// 全コンポーネントが描画され、最後のファイルの CSS まで当たるまでの時間
async function load(url: string) {
  const context = await browser.newContext()
  const page = await context.newPage()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  const s = performance.now()
  await page.goto(url)
  await page.waitForFunction(
    ([n, color]) => {
      const spans = document.querySelectorAll('span')
      return spans.length === n && getComputedStyle(spans[n - 1]).color === color
    },
    [FILES * CLASSES, colorOf(CLASSES, FILES - 1, CLASSES - 1)] as const,
    { polling: 'raf', timeout: 120_000 },
  )
  const ms = performance.now() - s
  const styles = await page.locator('style[data-vite-dev-id]').count()
  if (styles !== FILES) throw new Error(`<style> が ${styles} 個 (期待値 ${FILES})`)
  if (errors.length) throw new Error(errors.join('\n'))
  return { ms, page }
}

// C0 の .c0 の色だけを書き換え、ブラウザに反映されるまでの時間
async function hmr(variant: Variant, dir: string, page: Page) {
  const file = path.join(dir, variant === 'sfc' ? 'C0.tsx' : 'C0.module.css')
  await page.evaluate(() => ((window as unknown as { __alive: boolean }).__alive = true))
  const times = []
  for (let i = 1; i <= HMR_RUNS; i++) {
    // chokidar は同じパスの change を 50ms 以内だと捨てるので、書き込み同士の間隔を空ける
    await new Promise((r) => setTimeout(r, 200))
    const src = readFileSync(file, 'utf8').replace(/\.c0 \{ color: [^;]+;/, `.c0 { color: rgb(${i}, 0, 0);`)
    const s = performance.now()
    writeFileSync(file, src)
    await page.waitForFunction(
      (color) => getComputedStyle(document.querySelector('[data-c="0"] span')!).color === color,
      `rgb(${i}, 0, 0)`,
      { polling: 'raf', timeout: 10_000 },
    )
    times.push(performance.now() - s)
  }
  if (!(await page.evaluate(() => (window as unknown as { __alive?: boolean }).__alive)))
    throw new Error(`${variant}: HMR でページ全体がリロードされた`)
  return times
}

async function run(variant: Variant, dir: string, withHmr: boolean) {
  const acc = { ms: 0 }
  const s = performance.now()
  const server = await createServer({
    root: dir,
    configFile: false,
    logLevel: 'silent',
    plugins: [variant === 'sfc' ? timed(sfcCss(), acc) : [], react()],
    // 依存の発見による途中リロードを避ける
    optimizeDeps: { include: ['react', 'react-dom/client', 'react/jsx-dev-runtime'] },
    server: { port: 0 },
  })
  await server.listen()
  const startup = performance.now() - s
  const url = server.resolvedUrls!.local[0]
  try {
    const cold = await load(url)
    await cold.page.context().close()
    const plugin = acc.ms
    // 2 回目はサーバーの transform キャッシュあり、ブラウザのキャッシュなし
    const warm = await load(url)
    const hmrTimes = withHmr ? await hmr(variant, dir, warm.page) : []
    await warm.page.context().close()
    return { startup, cold: cold.ms, warm: warm.ms, plugin, hmr: hmrTimes }
  } finally {
    await server.close()
  }
}

const dirs = { sfc: generate('sfc', FILES, CLASSES), module: generate('module', FILES, CLASSES) }
const results = { sfc: [] as Awaited<ReturnType<typeof run>>[], module: [] as Awaited<ReturnType<typeof run>>[] }

console.log(`${FILES} ファイル × ${CLASSES} クラス, ${RUNS} 回 (+ ウォームアップ 1 回), HMR は ${HMR_RUNS} 回`)
try {
  for (let i = 0; i <= RUNS; i++)
    for (const v of VARIANTS) {
      const r = await run(v, dirs[v], i === RUNS)
      if (i) results[v].push(r)
    }
} finally {
  await browser.close()
}
const fmt = (xs: number[]) => `${median(xs).toFixed(0)}ms`.padStart(7)
console.log('         起動    初回ロード  2回目ロード  HMR(CSSのみ)  うち sfc-css の transform (初回)')
for (const v of VARIANTS) {
  const rs = results[v]
  const hmrTimes = rs.flatMap((r) => r.hmr)
  console.log(
    `${v.padEnd(6)} ${fmt(rs.map((r) => r.startup))}  ${fmt(rs.map((r) => r.cold))}     ${fmt(rs.map((r) => r.warm))}      ` +
      `${fmt(hmrTimes)} (最大 ${Math.max(...hmrTimes).toFixed(0)}ms)  ${v === 'sfc' ? fmt(rs.map((r) => r.plugin)) : '-'}`,
  )
}
