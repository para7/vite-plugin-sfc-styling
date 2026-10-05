import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { build, createServer, mergeConfig, parseAst, type InlineConfig, type Rolldown, type ViteDevServer } from 'vite'
import { afterEach, describe, expect, test, vi } from 'vitest'
import sfcCss, { transformSfcCss } from './sfc-css.ts'

const IMPORT = `import { css } from 'virtual:sfc-css'\n`

describe('transformSfcCss', () => {
  const F = '/p/App.tsx'

  test('複数ブロック・複数 declarator・alias・export・マルチバイト文字の後ろ・行数維持・raw', () => {
    const src = [
      `import { css as c } from 'virtual:sfc-css'`,
      `// 日本語コメント 🎨`,
      `export const a = c\`.x { content: "\\201C" }\``,
      `const b = c\``,
      `  .y { color: red }`,
      `\`, d = c\`.z{}\``,
      `const App = () => <p className={a.x + b.y} />`,
    ].join('\n')
    const r = transformSfcCss(src, F)!
    expect(r.css).toEqual(['.x { content: "\\201C" }', '\n  .y { color: red }\n', '.z{}'])
    const lines = r.code.split('\n')
    expect(lines).toHaveLength(src.split('\n').length)
    expect(lines[0]).toMatch(
      new RegExp(`^import __sfc_css_0 from "${F}.sfc0.module.css";import __sfc_css_1 from "${F}.sfc1.module.css";`),
    )
    expect(lines[2]).toBe('export const a = __sfc_css_0')
    expect(lines[3]).toBe('const b = __sfc_css_1')
    expect(lines[5]).toBe(', d = __sfc_css_2')
    expect(lines[6]).toBe(src.split('\n')[6])
  })

  test('先頭の directive の後ろに import を入れ、directive として残す', () => {
    const src = `'use no memo'\n${IMPORT}const a = css\`.a{}\``
    const r = transformSfcCss(src, F)!
    const body = (parseAst(r.code, { lang: 'tsx' }) as unknown as { body: { directive?: string }[] }).body
    expect(body[0].directive).toBe('use no memo')
    expect(r.code.split('\n')).toHaveLength(src.split('\n').length)
  })

  test('拡張子から言語を判定する (.ts の型アサーション <T>x は tsx として読むと失敗する)', () => {
    expect(transformSfcCss(IMPORT + 'const n = <number>y\nconst a = css`.a{}`', '/p/a.ts')!.css).toEqual(['.a{}'])
  })

  test('別モジュールの css は対象外', () => {
    expect(transformSfcCss(`import { css } from 'other'\nconst a = css\`.x{}\` // virtual:sfc-css`, F)).toBeNull()
  })

  test.each([
    ['補間', 'const a = css`.x { width: ${w}px }`', /:2 css`` 内で \$\{\} は使えません/],
    ['関数内', 'function f() { const a = css`.x{}` }', /:2 css`` はトップレベル/],
    ['let', 'let a = css`.x{}`', /トップレベル/],
    ['配列の中', 'const a = [css`.x{}`]', /トップレベル/],
    ['export default', 'export default css`.x{}`', /トップレベル/],
  ])('違反はエラー: %s', (_, body, re) => {
    expect(() => transformSfcCss(IMPORT + body, '/p/a.tsx')).toThrow(re)
  })
})

// --- 結合テスト用のフィクスチャ ---------------------------------------------

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function fixture(files: Record<string, string>) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'sfc-css-')))
  dirs.push(dir)
  write(dir, files)
  return dir
}

function write(dir: string, files: Record<string, string>) {
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, f)), { recursive: true })
    writeFileSync(path.join(dir, f), c)
  }
}

const comp = (a = 'red', b = 'blue') => `${IMPORT}export const a = css\`.root { color: ${a} }\`
export const b = css\`.root { color: ${b} }\`
`

// lib モードで comp.ts をビルドし、export されたクラス名マップを実際に評価して返す
async function bundle(root: string, config: InlineConfig = {}) {
  const out = (await build(
    mergeConfig(
      {
        root,
        configFile: false,
        logLevel: 'silent',
        plugins: [sfcCss()],
        build: {
          write: false,
          minify: false,
          cssMinify: false,
          lib: { entry: path.join(root, 'comp.ts'), formats: ['es'], fileName: 'out' },
        },
      } satisfies InlineConfig,
      config,
    ),
  )) as Rolldown.RolldownOutput[]
  const files = out[0].output
  const js = files.find((f) => f.type === 'chunk')!.code
  const css = files.flatMap((f) => (f.type === 'asset' && f.fileName.endsWith('.css') ? [String(f.source)] : [])).join('')
  const mod = await import(`data:text/javascript,${encodeURIComponent(js)}`)
  return { css, mod: mod as Record<string, Record<string, string>> }
}

describe('build', () => {
  test('ブロックごとに別スコープになり、クラス名と CSS が対応する', async () => {
    const { css, mod } = await bundle(fixture({ 'comp.ts': comp() }))
    expect(mod.a.root).not.toBe(mod.b.root)
    expect(css).toMatch(new RegExp(`\\.${mod.a.root}\\s*\\{\\s*color: red`))
    expect(css).toMatch(new RegExp(`\\.${mod.b.root}\\s*\\{\\s*color: blue`))
  })

  test('CSS の中身を変えてもクラス名は変わらない', async () => {
    const dir = fixture({ 'comp.ts': comp() })
    const before = (await bundle(dir)).mod
    write(dir, { 'comp.ts': comp('green', 'pink') })
    const after = (await bundle(dir)).mod
    expect(after.a.root).toBe(before.a.root)
    expect(after.b.root).toBe(before.b.root)
  })

  test('クラス名は root からの相対パス由来: 別 root でも同じ、別ファイルなら違う', async () => {
    const a = (await bundle(fixture({ 'comp.ts': comp() }))).mod
    const b = (await bundle(fixture({ 'comp.ts': comp() }))).mod
    expect(b.a.root).toBe(a.a.root)
    const dir = fixture({ 'x/c.ts': comp(), 'y/c.ts': comp(), 'comp.ts': `export * as x from './x/c.ts'\nexport * as y from './y/c.ts'` })
    const { mod } = (await bundle(dir)) as unknown as { mod: Record<string, Record<string, Record<string, string>>> }
    expect(mod.x.a.root).not.toBe(mod.y.a.root)
  })

  test('css.modules.hashPrefix を反映する', async () => {
    const dir = fixture({ 'comp.ts': comp() })
    const plain = (await bundle(dir)).mod
    const prefixed = (await bundle(dir, { css: { modules: { hashPrefix: 'app2' } } })).mod
    expect(prefixed.a.root).not.toBe(plain.a.root)
  })

  test('generateScopedName を指定していればそれに従う', async () => {
    const { mod } = await bundle(fixture({ 'comp.ts': comp() }), {
      css: { modules: { generateScopedName: '[local]__custom' } },
    })
    expect(mod.a.root).toBe('root__custom')
  })

  test('lightningcss でも動く', async () => {
    const { css, mod } = await bundle(fixture({ 'comp.ts': comp() }), { css: { transformer: 'lightningcss' } })
    expect(mod.a.root).not.toBe(mod.b.root)
    expect(css).toContain(`.${mod.a.root}`)
    expect(css).toContain(`.${mod.b.root}`)
  })

  // 3 つとも「仮想 id が tsx と同じディレクトリにある」ことに依存している
  test('composes / @import / url() のパスは tsx からの相対で解決される', async () => {
    const { css, mod } = await bundle(
      fixture({
        'shared.module.css': '.base { color: green }',
        'g.css': '.imported { color: pink }',
        'img.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
        'comp.ts': `${IMPORT}export const a = css\`@import './g.css';
          .root { composes: base from './shared.module.css'; background: url(./img.svg) }\``,
      }),
    )
    const [own, composed] = mod.a.root.split(' ')
    expect(own).toMatch(/^_root_/)
    // 通常の .module.css は Vite 既定の命名 (_name_hash5_line) のまま
    expect(composed).toMatch(/^_base_[a-z0-9]{1,5}_1$/)
    expect(css).toContain('color: green')
    // @import で取り込んだクラスもローカル化される
    expect(css).toMatch(/\._imported_\w+ \{ color: pink \}/)
    expect(css).toContain('data:image/svg+xml')
  })

})

describe('dev server', () => {
  const servers: ViteDevServer[] = []
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close()))
  })

  // 自身で accept する comp.ts (= HMR 境界) を持つ。watcher は使わず change を手動で発火する
  const devComp = (a = 'red', b = 'blue', js = '') => `${comp(a, b)}${js}\nif (import.meta.hot) import.meta.hot.accept()\n`

  async function serve(root: string, config: InlineConfig = {}) {
    const server = await createServer(
      mergeConfig(
        {
          root,
          configFile: false,
          logLevel: 'silent',
          plugins: [sfcCss()],
          server: { watch: null, ws: false },
          optimizeDeps: { noDiscovery: true },
        } satisfies InlineConfig,
        config,
      ),
    )
    servers.push(server)
    const env = server.environments.client
    const send = vi.spyOn(env.hot, 'send')
    const transform = async (url: string) => (await env.transformRequest(url))!.code
    // ファイルを書き換え、HMR で送られたペイロードを返す
    const edit = async (file: string, content: string) => {
      writeFileSync(path.join(root, file), content)
      send.mockClear()
      server.watcher.emit('change', path.join(root, file))
      await vi.waitFor(() => expect(send).toHaveBeenCalled(), { timeout: 5000 })
      // spyOn は send(event: string, ...) のオーバーロードを拾うので unknown 経由
      return send.mock.calls.at(-1)![0] as unknown as { type: string; updates?: { path: string }[] }
    }
    const paths = (p: { updates?: { path: string }[] }) => p.updates?.map((u) => u.path).sort()
    return { server, env, transform, edit, paths }
  }

  async function warm(s: Awaited<ReturnType<typeof serve>>, n = 2) {
    await s.transform('/comp.ts')
    for (let i = 0; i < n; i++) await s.transform(`/comp.ts.sfc${i}.module.css`)
  }

  test('tsx は仮想 CSS を import し、仮想 CSS は self-accept コードと中身を持つ', async () => {
    const s = await serve(fixture({ 'comp.ts': devComp() }))
    expect(await s.transform('/comp.ts')).toContain('/comp.ts.sfc0.module.css')
    const css0 = await s.transform('/comp.ts.sfc0.module.css')
    expect(css0).toContain('color: red')
    expect(css0).toContain('import.meta.hot.accept()')
  })

  test('CSS だけの変更は、変わったブロックだけを self-accept で更新する', async () => {
    const s = await serve(fixture({ 'comp.ts': devComp() }))
    await warm(s)
    const p1 = await s.edit('comp.ts', devComp('red', 'green'))
    expect(s.paths(p1)).toEqual(['/comp.ts.sfc1.module.css'])
    expect(await s.transform('/comp.ts.sfc1.module.css')).toContain('color: green')

    const p0 = await s.edit('comp.ts', devComp('pink', 'green'))
    expect(s.paths(p0)).toEqual(['/comp.ts.sfc0.module.css'])
  })

  test('JS が変わると tsx も含めて更新し、その後の CSS だけの変更も再び self-accept になる', async () => {
    const s = await serve(fixture({ 'comp.ts': devComp() }))
    await warm(s)
    const js = await s.edit('comp.ts', devComp('red', 'blue', 'export const n = 1'))
    expect(s.paths(js)).toContain('/comp.ts')

    // tsx の再 transform で vite:css-analysis が isSelfAccepting を false に戻した後
    await warm(s)
    const css = await s.edit('comp.ts', devComp('red', 'pink', 'export const n = 1'))
    expect(s.paths(css)).toEqual(['/comp.ts.sfc1.module.css'])
  })

  test('構文エラー中は既定の流れに任せ、元の内容へ戻したら全体を更新する (エラー表示を確実に消すため)', async () => {
    const s = await serve(fixture({ 'comp.ts': devComp() }))
    await warm(s)
    const broken = await s.edit('comp.ts', devComp() + 'const (')
    expect(s.paths(broken)).toContain('/comp.ts')
    // 自動保存でよくある「壊す → そのまま戻す」。JS は前回と同一だが、ブラウザはエラー表示中
    const back = await s.edit('comp.ts', devComp())
    expect(s.paths(back)).toContain('/comp.ts')
  })

  test('import を消すと通常のモジュールとして更新し、元に戻すと全体を更新する', async () => {
    const s = await serve(fixture({ 'comp.ts': devComp() }))
    await warm(s)
    const removed = await s.edit('comp.ts', 'export const a = 1\nif (import.meta.hot) import.meta.hot.accept()\n')
    expect(s.paths(removed)).toContain('/comp.ts')
    await s.transform('/comp.ts')
    // 仮想 CSS の importer が一度いなくなるので full-reload になる。CSS だけの更新や空の更新にならなければよい
    const back = await s.edit('comp.ts', devComp('red', 'green'))
    expect(back.type === 'full-reload' || s.paths(back)?.includes('/comp.ts')).toBe(true)
  })

  test('generateScopedName が関数指定なら、クラス名が変わりうるので CSS だけの更新にしない', async () => {
    const s = await serve(fixture({ 'comp.ts': devComp() }), {
      css: { modules: { generateScopedName: (name: string, _f: string, css: string) => `${name}_${css.length}` } },
    })
    await warm(s)
    const p = await s.edit('comp.ts', devComp('red', 'green'))
    expect(s.paths(p)).toContain('/comp.ts')
  })

  test('?inline / ?direct 付きでも読め、クラス名は通常の import と同じ', async () => {
    const s = await serve(fixture({ 'comp.ts': devComp() }))
    await s.transform('/comp.ts')
    const root = (await s.transform('/comp.ts.sfc0.module.css')).match(/export const root = "([^"]+)"/)![1]
    // SSR フレームワークは dev 中に ?inline で CSS を集めるので、クラス名がずれるとスタイルが当たらない
    expect(await s.transform('/comp.ts.sfc0.module.css?inline')).toMatch(new RegExp(`export default ".*\\.${root} \\{ color: red`))
    expect(await s.transform('/comp.ts.sfc0.module.css?direct')).toContain('color: red')
  })

  test('SSR: ssrLoadModule で読め、CSS の変更後は新しいクラス名マップになる', async () => {
    const s = await serve(fixture({ 'comp.ts': devComp() }))
    await warm(s)
    const before = await s.server.ssrLoadModule('/comp.ts')
    expect(before.a.root).toMatch(/^_root_/)
    await s.edit('comp.ts', devComp().replace('color: red }', 'color: red } .added { color: blue }'))
    const after = await s.server.ssrLoadModule('/comp.ts')
    expect(after.a.added).toMatch(/^_added_/)
  })

  test('root 外のファイルは絶対パスの URL で扱える', async () => {
    const dir = fixture({ 'shared/comp.ts': devComp(), 'app/index.html': '' })
    const s = await serve(path.join(dir, 'app'), { server: { fs: { allow: [dir] } } })
    const code = await s.transform(`/@fs${dir}/shared/comp.ts`)
    expect(code).toContain(`"${dir}/shared/comp.ts.sfc0.module.css"`)
    expect(await s.transform(`${dir}/shared/comp.ts.sfc0.module.css`)).toContain('color: red')
  })

  test('fs.allow 外で transform されていないファイルの仮想 CSS は読まない', async () => {
    const dir = fixture({ 'secret/comp.ts': devComp(), 'app/index.html': '' })
    const s = await serve(path.join(dir, 'app'))
    const url = `${dir}/secret/comp.ts.sfc0.module.css`
    expect(await s.env.pluginContainer.resolveId(url)).toBeNull()
    // `/@id/<root>/../secret/...` の URL は、ミドルウェアで /@id/ が外されてこの形になる
    for (const u of [url, `${dir}/app/../secret/comp.ts.sfc0.module.css`, '/../secret/comp.ts.sfc0.module.css'])
      await expect(s.transform(u), u).rejects.toThrow(/Failed to load|ENOENT|does not exist/)
  })
})
