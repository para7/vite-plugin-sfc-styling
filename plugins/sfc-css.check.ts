// node plugins/sfc-css.check.ts
import assert from 'node:assert/strict'
import { transformSfcCss } from './sfc-css.ts'

const F = '/p/App.tsx'

// 正常系: 複数ブロック・alias import・export・マルチバイト文字の後ろ・行数維持・raw
{
  const src = [
    `import { css as c } from 'virtual:sfc-css'`,
    `// 日本語コメント 🎨`,
    `export const a = c\`.x { content: "\\201C" }\``,
    `const b = c\``,
    `  .y { color: red }`,
    `\``,
    `const App = () => <p className={a.x + b.y} />`,
  ].join('\n')
  const r = transformSfcCss(src, F)!
  assert.deepEqual(r.css, ['.x { content: "\\201C" }', '\n  .y { color: red }\n'])
  const lines = r.code.split('\n')
  assert.equal(lines.length, src.split('\n').length)
  assert.ok(lines[0].startsWith(`import __sfc_css_0 from "${F}.sfc0.module.css";import __sfc_css_1 from "${F}.sfc1.module.css";`))
  assert.equal(lines[2], 'export const a = __sfc_css_0')
  assert.equal(lines[3], 'const b = __sfc_css_1')
  assert.equal(lines[6], src.split('\n')[6])
}

// 対象外: import が無い / 別モジュールの css
assert.equal(transformSfcCss('const a = 1', F), null)
assert.equal(transformSfcCss(`import { css } from 'other'\nconst a = css\`.x{}\` // virtual:sfc-css`, F), null)

// 違反はエラー
const imp = `import { css } from 'virtual:sfc-css'\n`
const bad: [string, RegExp][] = [
  ['const a = css`.x { width: ${w}px }`', /:2 css`` 内で \$\{\} は使えません/],
  ['function f() { const a = css`.x{}` }', /トップレベルの const/],
  ['let a = css`.x{}`', /トップレベルの const/],
  ['const a = [css`.x{}`]', /トップレベルの const/],
]
for (const [code, re] of bad) assert.throws(() => transformSfcCss(imp + code, F), re)

console.log('sfc-css: ok')
