# CLAUDE.md

`.tsx` に `css\`...\`` で CSS を書ける Vite プラグインの試作です。使い方は README.md を参照してください。

## 構成

- `plugins/sfc-css.ts`: プラグイン本体。他のプロジェクトへ 1 ファイルでコピーして使う前提なので、Vite 以外の依存を足さず、ファイルも分けないこと
- `src/sfc-css.d.ts`: `virtual:sfc-css` の型
- `plugins/sfc-css.test.ts`: vitest。transform の単体テスト、build (lib モードで出力を data: URL で評価)、dev サーバー (`watch: null` + `watcher.emit('change')` + `hot.send` の spy)
- `e2e/`: playwright。専用アプリ `e2e/app/` の `Counter.tsx` を書き換えながら実ブラウザで HMR を確認する
- `src/App.tsx`: デモ

## コマンド

- `pnpm test` / `pnpm test:e2e` / `pnpm build` (`tsc -b` を含む) / `pnpm lint`
- Claude Code のサンドボックス内では、`pnpm add` は pnpm ストアへの書き込みで失敗する。dev サーバーへの接続もコマンドごとにネットワークが分かれるので失敗する。このプロジェクトでは、依存追加・テスト・dev サーバーを使う検証はサンドボックス外で実行してよい (ユーザー了承済み)

## 設計上の判断 (コードからは読み取りにくいもの)

- **仮想 CSS の id を `X.tsx.sfc0.module.css` にしている理由**: `X.tsx?sfc-css...` のようなクエリ形式にすると、vite:oxc などがクエリを除いた `.tsx` を見て JS として変換してしまう
- **仮想 CSS は実在しないファイル**なので、Vite は root 外でも `/@fs/` を付けず、絶対パスのまま URL にする。`resolveId` / `load` は「transform 済み」か「`isFileServingAllowed` が許可する正規化済みパス」しか受け付けない。`server.fs.allow` を回避されないためで、緩めないこと
- **CSS だけの HMR は Vite の内部挙動に依存している**。Vite を上げたら、まずここが壊れていないか確認する
  - Vite 既定 (postcss-modules) のクラス名は CSS の内容のハッシュなので、`config` フックで仮想 CSS 用の安定した `generateScopedName` を入れている
  - `vite:css-analysis` が CSS Module の `isSelfAccepting` を毎回 false に戻すので、`hotUpdate` で立て直している。クライアント側の `accept()` は post プラグインで付けている
- `jsByFile` には transform 後の JS を保持し、`hotUpdate` で「JS 部分が変わったか」を判定する。transform が失敗したり対象外になったりしたら、空文字にして次の更新を必ず全体の更新にする (構文エラーから元に戻したときに、エラー表示を残さないため)
- import は先頭の directive の直後に、改行せずに入れる。行番号を保つため (ソースマップは出していない)

## テストの注意

- E2E は `Counter.tsx` を書き換えるので直列で実行する。途中で落ちると書き換わったまま残るが、その場合は spec が検知して止まる。`git checkout -- e2e/app/Counter.tsx` で戻す
- chokidar は同じパスへの change を 50ms 以内だと捨てる (Vite 本体の挙動)。E2E の書き込み間隔を詰めないこと
- 修正を入れたら、修正前のコードではテストが落ちることも確認する (テストが意味のある検査になっているかを見るため)

## 今後 (フェーズ2)

- `styles.xxx` の静的な参照と CSS のクラスを transform 時に突き合わせ、未定義の参照と未使用のクラスを警告する。`styles[key]` のような動的アクセスや、`styles` を丸ごと渡している場合は、そのファイルの検査をスキップする。警告にするかエラーにするかは未定
