import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { parseAst, type Plugin } from 'vite'

// const styles = css`.root { color: red }` を、同じファイルから派生した
// 仮想 CSS Module (`App.tsx.sfc0.module.css`) の import に置き換える。
// id をクエリ形式 (`App.tsx?...`) にしないのは、vite:oxc 等がクエリを除いた `.tsx` を見て JS として変換してしまうため。

const MODULE_ID = 'virtual:sfc-css'
const VIRTUAL_RE = /^(.*)\.sfc(\d+)\.module\.css$/
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
  // import は 1 行目の先頭に詰めて行番号を保つ
  const imports = blocks.map((_, i) => `import __sfc_css_${i} from ${JSON.stringify(virtualId(file, i))};`).join('')
  // raw を使う: CSS のエスケープ (content: "\201C" 等) を書いたまま渡すため
  const css = blocks.map((b) => b.quasi.quasis[0].value.raw as string)
  return { code: imports + out, css }
}

// string-hash (postcss-modules が使うもの) と同じ
const hash = (s: string) => {
  let h = 5381
  for (let i = s.length; i; ) h = (h * 33) ^ s.charCodeAt(--i)
  return (h >>> 0).toString(36).slice(0, 5)
}

export default function sfcCss(): Plugin[] {
  const cssByFile = new Map<string, string[]>()
  const jsByFile = new Map<string, string>()
  let root = ''

  const run = (code: string, file: string) => {
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
        if (c.css?.transformer === 'lightningcss' || m === false || m?.generateScopedName) return
        // Vite 既定 (postcss-modules) のクラス名は CSS 内容のハッシュで、編集のたびに変わるため
        // CSS だけの HMR ができない。仮想 CSS は「ファイル + ブロック番号」由来の安定名にする。
        // それ以外は Vite 既定 (makeDefaultScopedNameGenerator) と同じ式。
        return {
          css: {
            modules: {
              generateScopedName(name: string, filename: string, css: string) {
                if (VIRTUAL_RE.test(filename)) return `_${name}_${hash(path.relative(root, filename))}`
                const line = css.slice(0, css.indexOf(`.${name}`)).split(/[\r\n]/).length
                return `_${name}_${hash(css)}_${line}`
              },
            },
          },
        }
      },

      configResolved(c) {
        root = c.root
      },

      resolveId(id) {
        if (id === MODULE_ID) return '\0' + MODULE_ID
        const m = id.match(VIRTUAL_RE)
        if (!m) return
        // transform が出力する絶対パスに加え、dev では `/src/...` や `/@fs/...` の URL 形式でも来る
        if (id.startsWith('/@fs/')) return id.slice(4)
        return existsSync(m[1]) ? id : root + id
      },

      load(id) {
        // 正しく使われた css`` は transform で全て置換されるので、ここに来るのは誤用だけ
        if (id === '\0' + MODULE_ID)
          return `export function css() { throw new Error('[sfc-css] css は css\`...\` の形でのみ使えます') }`
        const m = id.match(VIRTUAL_RE)
        if (!m) return
        const [, file, index] = m
        // dev サーバー再起動直後など、tsx より先に CSS が要求された場合
        if (!cssByFile.has(file)) run(readFileSync(file, 'utf8'), file)
        return cssByFile.get(file)?.[Number(index)] ?? ''
      },

      transform(code, id) {
        if (id.includes('?') || id.includes('/node_modules/') || !FILE_RE.test(id)) return
        return run(code, id)?.code
      },

      async hotUpdate({ file, modules, read }) {
        if (this.environment.name !== 'client') return
        const prev = jsByFile.get(file)
        if (prev === undefined) return
        const graph = this.environment.moduleGraph
        const cssMods = []
        for (let i = 0, m; (m = graph.getModuleById(virtualId(file, i))); i++) cssMods.push(m)
        const prevCss = cssByFile.get(file)!
        let r
        try {
          r = run(await read(), file)
        } catch {
          return // 書きかけの構文エラー等は通常フローでエラー表示させる
        }
        if (r?.code !== prev) return [...modules, ...cssMods]
        // css`` の中身だけが変わった (JS 部分が同一) なら、変わった仮想 CSS だけを更新する。
        // vite:css-analysis が CSS Module の isSelfAccepting を毎回 false にするので、ここで立て直す
        const changed = cssMods.filter((_, i) => prevCss[i] !== r.css[i])
        for (const m of changed) m.isSelfAccepting = true
        return changed
      },
    },
    {
      // CSS Module は exports を持つので Vite は self-accept させない (importer の再レンダーになる)。
      // 仮想 CSS はクラス名が安定しているので、差し替えても importer 側の参照は壊れない。
      // ここではクライアント側の accept 登録だけを行い、サーバー側の判定は hotUpdate で行う。
      name: 'sfc-css:hmr',
      apply: 'serve',
      enforce: 'post',
      transform(code, id) {
        if (VIRTUAL_RE.test(id)) return code + '\nimport.meta.hot.accept()'
      },
    },
  ]
}
