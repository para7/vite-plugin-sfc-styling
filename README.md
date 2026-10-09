# sfc-css

Vue / Svelte の `<style>` のように、`.tsx` の中に CSS を書ける Vite プラグインです。特殊な構文は使わず、CSS Modules 互換で動きます。

```tsx
import { css } from 'virtual:sfc-css'

export function Button() {
  return <button className={styles.root}>OK</button>
}

const styles = css`
  .root {
    color: red;
    &:hover { color: blue; }
  }
`
```

`css` の中身は、ビルド時に仮想の CSS Module (`Button.tsx.sfc0.module.css`) として切り出されます。`styles` は通常の `import styles from './x.module.css'` と同じクラス名マップなので、ランタイムのコストはありません。

## 導入

公開パッケージではありません。次の 2 ファイルをコピーして使います。追加の依存はありません (Vite 8 以上が必要です)。

- `plugins/sfc-css.ts`: プラグイン本体
- `src/sfc-css.d.ts`: `virtual:sfc-css` の型。tsconfig の `include` に入る場所に置いてください

master の最新版は [Releases](https://github.com/para7/vite-plugin-react-sfc/releases/latest) からダウンロードできます。

```sh
curl -LO https://github.com/para7/vite-plugin-react-sfc/releases/latest/download/sfc-css.ts
curl -LO https://github.com/para7/vite-plugin-react-sfc/releases/latest/download/sfc-css.d.ts
```

```ts
// vite.config.ts
import sfcCss from './plugins/sfc-css.ts'

export default defineConfig({
  plugins: [sfcCss(), react()],
})
```

## 書き方のルール

違反するとビルドエラーになります。

- `css` はトップレベルの `const` 宣言でのみ使えます (`export const` も可)。関数の中や式の中では使えません
- `${}` による補間は使えません。値を共有したいときは CSS カスタムプロパティ (`var(--gap)`) を使ってください
- 1 ファイルに複数書けます。ブロックごとに別のスコープになります
- 中身はプレーンな CSS で、CSS Modules の機能 (`:global`、`composes` など) も使えます。ネストはブラウザのネイティブ CSS Nesting で書けます
- `composes ... from`、`@import`、`url()` のパスは、その `.tsx` ファイルからの相対パスで解決されます

既知の制約: 内側のスコープで `css` という名前をシャドーイングすると (`function f(css) { ... }` など)、誤ってエラーになります。

## 挙動

- **HMR**: `css` の中身だけを編集した場合は CSS だけが差し替わり、コンポーネントの再評価も React の再レンダーも起きません。JS を変えた場合は通常の Fast Refresh になります
- **クラス名**: `css.modules.generateScopedName` を指定していなければ、プラグインが設定を入れます。`css` ブロックのクラス名は「ファイルのパス + ブロック番号」から決まり、CSS を編集しても変わりません。通常の `.module.css` は Vite 既定と同じ命名のままです。`generateScopedName` を関数で指定している場合は、クラス名が変わりうるので、CSS だけの差し替えではなく全体の更新になります
- `'use client'` などの directive、SSR (`ssrLoadModule` / module runner)、lightningcss に対応しています

## エディタ

VS Code では、styled-components 向けの拡張機能 [vscode-styled-components](https://marketplace.visualstudio.com/items?itemName=styled-components.vscode-styled-components) を入れると、`css` の中身が CSS としてハイライトされ、補完も効きます。色付けだけでよければ、より軽い [es6-string-css](https://marketplace.visualstudio.com/items?itemName=bashmish.es6-string-css) でも構いません。

## 静的検査

transform のときに、`css` ブロックごとに JS 側の参照と CSS 側のクラスを突き合わせ、警告を出します (ビルドは止めません)。

```
[plugin sfc-css] /path/to/src/App.tsx:26 styles.countr は css`` (124 行目) に定義されていません
[plugin sfc-css] /path/to/src/App.tsx:124 styles の未使用のクラス: .counter
```

- **未定義の参照**: `styles.foo` と書いているのに、CSS 側に `foo` という名前がどこにもない。参照箇所の行を出します。CSS Modules は keyframes 名・`@value`・`:export` (lightningcss では grid や container の名前なども) をキーにするので、クラスに限らず名前が現れれば定義済みとみなします。そのため `styles.red` は `color: red` があると見逃します
- **未使用のクラス**: CSS 側に `.bar` があるのに、そのファイルのどこからも参照されていない。`css` ブロックの行を出します。`composes` で同じブロックから使っているクラスと、keyframes の名前は対象外です

静的な参照として数えるのは `styles.foo`、`styles['foo-bar']`、`const { foo } = styles` の 3 つだけです。判定できないときは、誤検知を出さないように検査をスキップします。

- `styles[key]`、関数へ渡す、スプレッド、`...rest` を含む分割代入など、それ以外の使い方が 1 つでもあるブロックは検査しません。`styles.toString()` などの `Object.prototype` のプロパティや、内側のスコープで同じ名前をシャドーイングしている場合も同じです
- `export const` しているブロックは、他のファイルから使われうるので未使用の検査をしません (`export { styles }` は上の「それ以外の使い方」なので、検査ごとしません)
- `@import` を含むブロックは、取り込んだ CSS のクラスもキーになるので未定義の検査をしません
- `:global(.x)` と `:global .x` のクラスはスコープ外なので数えません。エスケープを含むクラス名 (`.sm\:p-4`) や、括弧が 2 段以上ネストした `:global()` があるブロックは検査しません
- `css.modules` の `localsConvention`・`exportGlobals`・`scopeBehaviour: 'global'`・`globalModulePaths` を指定している場合は、キーが変わるので検査しません (lightningcss では Vite がこれらの設定を無視するので検査します)

dev では `[sfc-css]` を付けて Vite のロガーに出します。ファイルごとに前回と警告の内容が変わったときだけ出します (CSS だけの HMR でも出ます)。

## 開発

```sh
pnpm dev        # src/App.tsx のデモ
pnpm test       # vitest: transform / build / dev サーバー
pnpm test:e2e   # playwright: 実ブラウザで HMR を確認 (初回は pnpm exec playwright install --only-shell chromium)
pnpm bench      # vite build の時間
pnpm bench:dev  # dev サーバーの起動・初回ロード・CSS だけの HMR の時間 (実ブラウザ)
```

## パフォーマンス

同じ見た目のコンポーネントを「`css` で書いたもの」と「`.module.css` に分けたもの」の 2 通りで生成し (`.bench/` に出力、gitignore 済み)、時間を比べます。引数で規模を変えられます: `pnpm bench [ファイル数=500] [クラス数=20] [回数=5]` (`bench:dev` も同じ)。

500 ファイル × 20 クラスでの結果 (中央値。Intel Core Ultra 7 268V / WSL2 / Vite 8.3.2):

| | `css` | `.module.css` |
|---|---|---|
| `vite build` | 581〜593ms | 523〜540ms |
| dev 初回ロード | 2307〜2458ms | 2318〜2391ms |
| dev 2 回目ロード (サーバーのキャッシュあり) | 1677〜1732ms | 1706〜1794ms |
| CSS だけの HMR | 33〜35ms | 78〜81ms |

- プラグイン自身の transform は 1 ファイルあたり約 0.15ms (500 ファイルで約 75ms)。静的検査の分は 1 ファイルあたり約 0.01〜0.03ms です。時間はファイル数に比例します (2000 ファイルでの build は 2241ms 対 1863ms)
- dev の初回ロードの大半は、モジュール約 1000 個の取得です。モジュール数はどちらも同じです
- HMR は `css` のほうが速くなります。`.module.css` は import 元の `.tsx` まで更新が伝わり React が再描画しますが、`css` は変わった CSS だけを差し替えます
- 未計測: 1 ファイルが大きいコンポーネント (生成するのは 25 行程度で、プラグインは `.tsx` 全体をパースするのでファイルの大きさに比例して遅くなる)、React Compiler を入れた構成、JS を変えたときの HMR

## 今後の予定

- 静的検査の警告をエラーにするオプション (CI で落としたくなったら)
- `localsConvention` を指定している場合の静的検査

