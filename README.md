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
| `vite build` | 566〜612ms | 499〜574ms |
| dev 初回ロード | 2477〜2505ms | 2396〜2439ms |
| dev 2 回目ロード (サーバーのキャッシュあり) | 1738〜1774ms | 1707〜1846ms |
| CSS だけの HMR | 33ms | 67〜83ms |

- プラグイン自身の transform は 1 ファイルあたり約 0.12ms (500 ファイルで約 60ms)。時間はファイル数に比例します (2000 ファイルでの build は 2348ms 対 2099ms)
- dev の初回ロードの大半は、モジュール約 1000 個の取得です。モジュール数はどちらも同じです
- HMR は `css` のほうが速くなります。`.module.css` は import 元の `.tsx` まで更新が伝わり React が再描画しますが、`css` は変わった CSS だけを差し替えます
- 未計測: 1 ファイルが大きいコンポーネント (生成するのは 25 行程度で、プラグインは `.tsx` 全体をパースするのでファイルの大きさに比例して遅くなる)、React Compiler を入れた構成、JS を変えたときの HMR

## 今後の予定

- 静的検査: `styles.xxx` の参照と CSS 側のクラスを突き合わせて、未定義の参照と未使用のクラスを警告する

