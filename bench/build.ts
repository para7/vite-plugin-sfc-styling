// 500 ファイル × 20 クラスで vite build の時間を、同じ内容を .module.css に分けた場合と比べる。
// 実行: pnpm bench [ファイル数] [クラス数] [回数]
import path from 'node:path'
import react from '@vitejs/plugin-react'
import { build, type Rolldown } from 'vite'
import sfcCss from '../plugins/sfc-css.ts'
import { generate, median, timed, VARIANTS, type Variant } from './lib.ts'

const [FILES = 500, CLASSES = 20, RUNS = 5] = process.argv.slice(2).map(Number)

async function run(variant: Variant, dir: string) {
  const acc = { ms: 0 }
  const s = performance.now()
  const out = (await build({
    root: dir,
    configFile: false,
    logLevel: 'silent',
    plugins: [variant === 'sfc' ? timed(sfcCss(), acc) : [], react()],
    build: { write: false, rolldownOptions: { input: path.join(dir, 'main.tsx') } },
  })) as Rolldown.RolldownOutput
  const ms = performance.now() - s
  const css = out.output.flatMap((o) => (o.type === 'asset' && o.fileName.endsWith('.css') ? [String(o.source)] : [])).join('')
  // 全クラスが出力されているか (ビルドが中身を落としていないか) の確認
  const classes = new Set(css.match(/\._c\d+_[\w-]+/g)).size
  if (classes !== FILES * CLASSES) throw new Error(`${variant}: CSS のクラス数が ${classes} (期待値 ${FILES * CLASSES})`)
  return { ms, plugin: acc.ms }
}

const dirs = { sfc: generate('sfc', FILES, CLASSES), module: generate('module', FILES, CLASSES) }
const results = { sfc: [] as Awaited<ReturnType<typeof run>>[], module: [] as Awaited<ReturnType<typeof run>>[] }

console.log(`${FILES} ファイル × ${CLASSES} クラス, ${RUNS} 回 (+ ウォームアップ 1 回)`)
for (let i = 0; i <= RUNS; i++)
  for (const v of VARIANTS) {
    const r = await run(v, dirs[v])
    if (i) results[v].push(r)
  }
for (const v of VARIANTS) {
  const rs = results[v]
  const plugin = v === 'sfc' ? `  (うち sfc-css の transform: ${median(rs.map((r) => r.plugin)).toFixed(0)}ms)` : ''
  console.log(`${v.padEnd(6)} 中央値 ${median(rs.map((r) => r.ms)).toFixed(0)}ms${plugin}`)
}
