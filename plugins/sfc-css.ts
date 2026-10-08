/*
 * ISC License
 *
 * Copyright (c) 2026 nanaket
 *
 * Permission to use, copy, modify, and/or distribute this software for any
 * purpose with or without fee is hereby granted, provided that the above
 * copyright notice and this permission notice appear in all copies.
 *
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
 * WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
 * MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
 * ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
 * WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
 * ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
 * OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
 */

import path from 'node:path'
import { normalizePath, parseAst, type Plugin, type ResolvedConfig } from 'vite'

// const styles = css`.root { color: red }` を、同じファイルから派生した
// 仮想 CSS Module (`App.tsx.sfc0.module.css`) の import に置き換える。
// id をクエリ形式 (`App.tsx?...`) にしないのは、vite:oxc 等がクエリを除いた `.tsx` を見て JS として変換してしまうため。

const MODULE_ID = 'virtual:sfc-css'
// `?inline` `?direct` 等のクエリ付きでも来る
const VIRTUAL_RE = /^(.*)\.sfc(\d+)\.module\.css(?:\?.*)?$/
const FILE_RE = /\.[cm]?[jt]sx?$/
const virtualId = (file: string, i: number) => `${file}.sfc${i}.module.css`

// oxc ESTree。必要なプロパティしか触らないので緩く型付けする
type Node = { type: string; start: number; end: number; [k: string]: any }

export function transformSfcCss(code: string, file: string) {
  if (!code.includes(MODULE_ID)) return null
  const lang = file.match(FILE_RE)![0].replace(/^\.[cm]?/, '') as 'js' | 'jsx' | 'ts' | 'tsx'
  const ast = parseAst(code, { lang }) as unknown as Node

  const names = new Set<string>()
  for (const n of ast.body)
    if (n.type === 'ImportDeclaration' && n.source.value === MODULE_ID)
      for (const s of n.specifiers)
        if (s.type === 'ImportSpecifier' && s.imported.name === 'css') names.add(s.local.name)
  if (!names.size) return null

  // 名前で判定するので、内側のスコープで css をシャドーイングすると誤ってエラーになる (既知の制約)
  const isCss = (n: Node | null) =>
    n?.type === 'TaggedTemplateExpression' && n.tag.type === 'Identifier' && names.has(n.tag.name)

  // 許可するのはトップレベルの `const x = css`...`` (export 付き含む) のみ
  const allowed = new Set<Node>()
  for (let n of ast.body) {
    if (n.type === 'ExportNamedDeclaration' && n.declaration) n = n.declaration
    if (n.type === 'VariableDeclaration' && n.kind === 'const')
      for (const d of n.declarations) if (isCss(d.init)) allowed.add(d.init)
  }

  const fail = (n: Node, msg: string) => {
    const line = code.slice(0, n.start).split('\n').length
    throw new Error(`[sfc-css] ${file}:${line} ${msg}`)
  }
  const blocks: Node[] = []
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) return n.forEach(walk)
    if (!n || typeof n !== 'object') return
    const node = n as Node
    if (isCss(node)) {
      if (!allowed.has(node)) fail(node, 'css`` はトップレベルの const 宣言でのみ使えます')
      if (node.quasi.expressions.length) fail(node, 'css`` 内で ${} は使えません')
      blocks.push(node)
      return
    }
    for (const k in node) walk(node[k])
  }
  walk(ast.body)
  blocks.sort((a, b) => a.start - b.start)

  // 後ろから置換して offset を保つ。改行数を維持して行番号をずらさない
  let out = code
  for (let i = blocks.length - 1; i >= 0; i--) {
    const { start, end } = blocks[i]
    const newlines = code.slice(start, end).split('\n').length - 1
    out = out.slice(0, start) + `__sfc_css_${i}` + '\n'.repeat(newlines) + out.slice(end)
  }
  // import は先頭の directive ('use client' 'use no memo' 等) の直後に、改行せずに詰めて行番号を保つ。
  // directive より前に置くと directive として扱われなくなる
  let at = 0
  for (const n of ast.body) {
    if (n.type !== 'ExpressionStatement' || !n.directive) break
    at = n.end
  }
  const imports = blocks.map((_, i) => `import __sfc_css_${i} from ${JSON.stringify(virtualId(file, i))};`).join('')
  // raw を使う: CSS のエスケープ (content: "\201C" 等) を書いたまま渡すため
  const css = blocks.map((b) => b.quasi.quasis[0].value.raw as string)
  return { code: out.slice(0, at) + (at ? ';' : '') + imports + out.slice(at), css }
}

// string-hash (postcss-modules が使うもの) と同じ
const stringHash = (s: string) => {
  let h = 5381
  for (let i = s.length; i; ) h = (h * 33) ^ s.charCodeAt(--i)
  return h >>> 0
}

export default function sfcCss(): Plugin[] {
  const cssByFile = new Map<string, string[]>()
  const jsByFile = new Map<string, string>()
  let config: ResolvedConfig
  // CSS だけの HMR は、クラス名が CSS の内容に依存しないことが前提
  let stableNames = true

  const run = (code: string, file: string) => {
    // 失敗・対象外になったら前回の JS を無効化し、次の hotUpdate を必ず全体更新にする
    if (jsByFile.has(file)) jsByFile.set(file, '')
    const r = transformSfcCss(code, file)
    if (r) {
      cssByFile.set(file, r.css)
      jsByFile.set(file, r.code)
    }
    return r
  }

  return [
    {
      name: 'sfc-css',
      enforce: 'pre',

      config(c) {
        const m = c.css?.modules
        const lc = c.css?.lightningcss?.cssModules
        stableNames =
          !(m && typeof m.generateScopedName === 'function') &&
          !(typeof lc === 'object' && lc.pattern?.includes('[content-hash]'))
        if (c.css?.transformer === 'lightningcss' || m === false || m?.generateScopedName) return
        // Vite 既定 (postcss-modules) のクラス名は CSS 内容のハッシュで、編集のたびに変わるため
        // CSS だけの HMR ができない。仮想 CSS は「ファイル + ブロック番号」由来の安定名にする。
        // それ以外は Vite 既定 (makeDefaultScopedNameGenerator) と同じ式。
        const prefix = m?.hashPrefix ?? ''
        return {
          css: {
            modules: {
              generateScopedName(name: string, filename: string, css: string) {
                if (VIRTUAL_RE.test(filename)) {
                  const rel = path.relative(config.root, filename.split('?')[0])
                  return `_${name}_${stringHash(prefix + rel).toString(36)}`
                }
                const i = css.indexOf(`.${name}`)
                const line = (i < 0 ? '' : css.slice(0, i)).split(/[\r\n]/).length
                return `_${name}_${stringHash(prefix + css).toString(36).slice(0, 5)}_${line}`
              },
            },
          },
        }
      },

      configResolved(c) {
        config = c
      },

      resolveId(id) {
        if (id === MODULE_ID) return '\0' + MODULE_ID
        const m = id.match(VIRTUAL_RE)
        if (!m) return
        // transform が出力した絶対パス。仮想 CSS は実在しないので Vite は /@fs/ を付けず、
        // dev でも root 外のファイルはこの形のまま URL になる
        if (cssByFile.has(m[1])) return id
        // dev の root 相対 URL (`/src/App.tsx.sfc0.module.css`)。
        // どちらも transform 済みのファイルしか受け付けない (server.fs.allow を回避されないため。緩めないこと)
        const abs = normalizePath(path.join(config.root, id))
        if (cssByFile.has(abs.match(VIRTUAL_RE)![1])) return abs
      },

      load(id) {
        // 正しく使われた css`` は transform で全て置換されるので、ここに来るのは誤用だけ
        if (id === '\0' + MODULE_ID)
          return `export function css() { throw new Error('[sfc-css] css は css\`...\` の形でのみ使えます') }`
        const m = id.match(VIRTUAL_RE)
        if (!m) return
        // 仮想 CSS は必ず tsx の transform の後に要求される (ブラウザ・SSR・ビルドのどれも importer が先)。
        // 未 transform のファイル (`/@id/<root>/../x` のような URL 由来の id も含む) は読まない
        const css = cssByFile.get(m[1])
        if (css) return css[Number(m[2])] ?? ''
      },

      transform: {
        filter: { id: { include: FILE_RE, exclude: /\/node_modules\// }, code: MODULE_ID },
        handler(code, id) {
          // クエリを残すと仮想 CSS の id が `x.tsx?...module.css` になり、クエリ前の .tsx として JS 変換されてしまう
          return run(code, id.split('?')[0])?.code
        },
      },

      async hotUpdate({ file, modules, read }) {
        const prev = jsByFile.get(file)
        if (prev === undefined) return
        const graph = this.environment.moduleGraph
        const cssMods = []
        for (let i = 0, m; (m = graph.getModuleById(virtualId(file, i))); i++) cssMods.push(m)
        // 仮想 CSS は file が別 (`X.tsx.sfc0.module.css`) なので、既定の modules に含まれない。
        // キャッシュの更新は client 環境の呼び出しだけで行う (二重に run すると prev がずれる)
        if (this.environment.config.consumer !== 'client') return [...modules, ...cssMods]
        const prevCss = cssByFile.get(file)!
        let r
        try {
          r = run(await read(), file)
        } catch {
          return // 書きかけの構文エラー等は通常フローでエラー表示させる
        }
        if (r?.code !== prev || !stableNames) return [...modules, ...cssMods]
        // css`` の中身だけが変わった (JS 部分が同一) なら、変わった仮想 CSS だけを更新する。
        // vite:css-analysis が CSS Module の isSelfAccepting を毎回 false にするので、ここで立て直す
        const changed = cssMods.filter((_, i) => prevCss[i] !== r.css[i])
        for (const m of changed) m.isSelfAccepting = true
        return changed
      },
    },
    {
      // クライアント側の accept 登録だけを行う。self-accept させるかの判定は hotUpdate で行う
      name: 'sfc-css:hmr',
      apply: 'serve',
      enforce: 'post',
      transform: {
        filter: { id: VIRTUAL_RE },
        handler(code) {
          return code + '\nif (import.meta.hot) import.meta.hot.accept()'
        },
      },
    },
  ]
}
