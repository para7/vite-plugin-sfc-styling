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
- 中身はプレーンな CSS です。ネストはブラウザのネイティブ CSS Nesting で書けます。`:global`、`composes`、`@import`、`url()` は、その `.tsx` ファイルからの相対パスで解決されます

既知の制約: 内側のスコープで `css` という名前をシャドーイングすると (`function f(css) { ... }` など)、誤ってエラーになります。

## 挙動

- **HMR**: `css` の中身だけを編集した場合は CSS だけが差し替わり、コンポーネントの再評価も React の再レンダーも起きません。JS を変えた場合は通常の Fast Refresh になります
- **クラス名**: `css.modules.generateScopedName` を指定していなければ、プラグインが設定を入れます。`css` ブロックのクラス名は「ファイルのパス + ブロック番号」から決まり、CSS を編集しても変わりません。通常の `.module.css` は Vite 既定と同じ命名のままです。`generateScopedName` を関数で指定している場合は、クラス名が変わりうるので、CSS だけの差し替えではなく全体の更新になります
- `'use client'` などの directive、SSR (`ssrLoadModule` / module runner)、lightningcss に対応しています

## 開発

```sh
pnpm dev        # src/App.tsx のデモ
pnpm test       # vitest: transform / build / dev サーバー
pnpm test:e2e   # playwright: 実ブラウザで HMR を確認 (初回は pnpm exec playwright install --only-shell chromium)
```

## 今後の予定

- 静的検査: `styles.xxx` の参照と CSS 側のクラスを突き合わせて、未定義の参照と未使用のクラスを警告する
