# CLAUDE.md

`.tsx` に `css\`...\`` で CSS を書ける Vite プラグインの試作です。使い方は README.md を参照してください。

## 構成

- `plugins/sfc-css.ts`: プラグイン本体。設計判断の理由はこのファイルのコメントに書く (単体でコピーして持ち運ぶので、正本はコード側)
- `src/sfc-css.d.ts`: `virtual:sfc-css` の型
- `plugins/sfc-css.test.ts`: vitest。transform の単体テスト、build、dev サーバーでの HMR の判定
- `e2e/`: playwright。専用アプリ `e2e/app/` で実ブラウザの HMR を確認する。テストは gitignore された `Counter.tsx` を書き換え、元の内容は `Counter.base.tsx`
- `src/App.tsx`: デモ
- `bench/`: ベンチマーク。`lib.ts` が `css` 版と `.module.css` 版のコンポーネントを `.bench/` に生成し、`build.ts` が vite build、`dev.ts` が dev サーバー (playwright で実ブラウザ) を計測する。結果は README.md に載せている

## 方針

- プラグインは他のプロジェクトへ 1 ファイルでコピーして使う前提。Vite 以外の依存を足さず、ファイルも分けない
- `resolveId` / `load` は transform 済みのファイルの仮想 CSS しか受け付けない。`server.fs.allow` を回避されないためなので、緩めないこと
- Vite を上げたら、まず「CSS だけの HMR」が壊れていないか確認する (`pnpm test:e2e`)。Vite の内部挙動 (`vite:css-analysis` による `isSelfAccepting` の上書きなど) に依存している

## コマンド

- `pnpm test` / `pnpm test:e2e` / `pnpm build` (`tsc -b` を含む) / `pnpm lint`
- `pnpm bench` / `pnpm bench:dev` (引数: ファイル数 クラス数 回数)。プラグインの処理を変えたら測り直し、README.md の数値を更新する
- Claude Code のサンドボックス内では、`pnpm add` は pnpm ストアへの書き込みで失敗する。dev サーバーへの接続もコマンドごとにネットワークが分かれるので失敗する。このプロジェクトでは、依存追加・テスト・dev サーバーを使う検証はサンドボックス外で実行してよい (ユーザー了承済み)

## テストの注意

- chokidar は同じパスへの change を 50ms 以内だと捨てる (Vite 本体の挙動)。E2E の書き込み間隔を詰めないこと
- 修正を入れたら、修正前のコードではテストが落ちることも確認する (テストが意味のある検査になっているかを見るため)

## 今後 (フェーズ2)

- `styles.xxx` の静的な参照と CSS のクラスを transform 時に突き合わせ、未定義の参照と未使用のクラスを警告する。`styles[key]` のような動的アクセスや、`styles` を丸ごと渡している場合は、そのファイルの検査をスキップする。警告にするかエラーにするかは未定
