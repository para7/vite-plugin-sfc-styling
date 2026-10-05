// build.ts / dev.ts 共通: 同じ見た目のコンポーネントを sfc-css と .module.css の 2 通りで生成する
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Plugin } from 'vite'

export type Variant = 'sfc' | 'module'
export const VARIANTS = ['sfc', 'module'] as const
export const ROOT = path.resolve(import.meta.dirname, '../.bench')

// ファイルごとに中身を変える (同じ CSS だと Vite 既定のクラス名が衝突し、出力の確認ができない)
const colorNum = (classes: number, f: number, c: number) => (f * classes + c) % 0xffffff
export const colorOf = (classes: number, f: number, c: number) => {
  const n = colorNum(classes, f, c)
  return `rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})`
}

export const cssOf = (classes: number, f: number) =>
  Array.from(
    { length: classes },
    (_, c) => `  .c${c} { color: #${colorNum(classes, f, c).toString(16).padStart(6, '0')}; padding: ${c}px; display: flex; }`,
  ).join('\n')
const jsxOf = (classes: number, f: number) =>
  `export function C${f}() {\n  return <div data-c="${f}">\n${Array.from({ length: classes }, (_, c) => `    <span className={styles.c${c}}>${c}</span>`).join('\n')}\n  </div>\n}\n`

export function generate(variant: Variant, files: number, classes: number) {
  const dir = path.join(ROOT, variant)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  for (let f = 0; f < files; f++) {
    const file = path.join(dir, `C${f}.tsx`)
    if (variant === 'sfc')
      writeFileSync(file, `import { css } from 'virtual:sfc-css'\n\n${jsxOf(classes, f)}\nconst styles = css\`\n${cssOf(classes, f)}\n\`\n`)
    else {
      writeFileSync(path.join(dir, `C${f}.module.css`), cssOf(classes, f) + '\n')
      writeFileSync(file, `import styles from './C${f}.module.css'\n\n${jsxOf(classes, f)}`)
    }
  }
  const ids = Array.from({ length: files }, (_, f) => f)
  writeFileSync(
    path.join(dir, 'main.tsx'),
    ids.map((f) => `import { C${f} } from './C${f}.tsx'\n`).join('') +
      `import { createRoot } from 'react-dom/client'\n` +
      `createRoot(document.getElementById('root')!).render(<>${ids.map((f) => `<C${f} />`).join('')}</>)\n`,
  )
  writeFileSync(path.join(dir, 'index.html'), `<!doctype html><div id="root"></div><script type="module" src="/main.tsx"></script>\n`)
  return dir
}

// プラグインの transform にかかった時間を合計する
export function timed(plugins: Plugin[], acc: { ms: number }) {
  for (const p of plugins) {
    const t = p.transform
    if (!t || typeof t !== 'object') continue
    const handler = t.handler
    t.handler = function (...args) {
      const s = performance.now()
      try {
        return handler.apply(this, args)
      } finally {
        acc.ms += performance.now() - s
      }
    }
  }
  return plugins
}

export const median = (xs: number[]) => xs.toSorted((a, b) => a - b)[xs.length >> 1]
