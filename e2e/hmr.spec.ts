import { readFileSync, writeFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'

// テストは gitignore された Counter.tsx を書き換える。元の内容は Counter.base.tsx
const FILE = 'e2e/app/Counter.tsx'
const BASE = readFileSync('e2e/app/Counter.base.tsx', 'utf8')
// chokidar は同じパスの change を 50ms 以内だと捨てるので、書き込み同士の間隔を空ける
const write = async (content: string) => {
  await new Promise((r) => setTimeout(r, 100))
  writeFileSync(FILE, content)
}
const edit = (f: (s: string) => string) => write(f(readFileSync(FILE, 'utf8')))

// Fast Refresh のコミットは少し遅れて起きるので、落ち着くのを待ってから読む
const counters = async (page: Page) => {
  await page.waitForTimeout(300)
  return page.evaluate(() => {
    const w = window as unknown as { __evals: number; __commits: number }
    return { evals: w.__evals, commits: w.__commits }
  })
}

test.beforeEach(async ({ page }) => {
  await write(BASE)
  await page.goto('/')
  const button = page.getByRole('button')
  for (let i = 0; i < 3; i++) await button.click()
  await expect(button).toHaveText('Count is 3')
})

test('CSS だけの変更: スタイルが変わり、モジュール再評価も再レンダーも <style> の重複も起きない', async ({ page }) => {
  const button = page.getByRole('button')
  const sfcStyles = page.locator('style[data-vite-dev-id*=".sfc"]')
  await expect(button).toHaveCSS('color', 'rgb(255, 0, 0)')
  await expect(sfcStyles).toHaveCount(2)
  const before = await counters(page)

  await edit((s) => s.replace('rgb(255, 0, 0)', 'rgb(0, 0, 255)'))
  await expect(button).toHaveCSS('color', 'rgb(0, 0, 255)')

  expect(await counters(page)).toEqual(before)
  await expect(button).toHaveText('Count is 3')
  await expect(sfcStyles).toHaveCount(2)
})

test('JS と CSS を同時に変更 (クラス追加): 新しいクラスが当たる', async ({ page }) => {
  const button = page.getByRole('button')
  await edit((s) =>
    s
      .replace('.button { color: rgb(255, 0, 0); }', '.button { color: rgb(255, 0, 0); }\n  .big { font-size: 40px; }')
      .replace('className={styles.button}', 'className={`${styles.button} ${styles.big}`}'),
  )
  await expect(button).toHaveCSS('font-size', '40px')
  await expect(button).toHaveText('Count is 3')
})

test('CSS だけでクラスを追加した後、JS でそのクラスを使う', async ({ page }) => {
  const button = page.getByRole('button')
  await edit((s) => s.replace('.button { color: rgb(255, 0, 0); }', '.button { color: rgb(255, 0, 0); }\n  .big { font-size: 40px; }'))
  // CSS だけの更新を待つ (追加したクラスはまだどこにも使われていない)
  const hasRule = () =>
    page.evaluate(() => [...document.styleSheets].some((sh) => [...sh.cssRules].some((r) => r.cssText.includes('font-size: 40px'))))
  await expect.poll(hasRule).toBe(true)
  await edit((s) => s.replace('className={styles.button}', 'className={`${styles.button} ${styles.big}`}'))
  await expect(button).toHaveCSS('font-size', '40px')
  await expect(button).toHaveText('Count is 3')
})

test('ブロックを削除すると、その <style> も消える', async ({ page }) => {
  const sfcStyles = page.locator('style[data-vite-dev-id*=".sfc"]')
  await expect(sfcStyles).toHaveCount(2)
  await edit((s) => s.replace(/\nconst extra = css`[^`]*`\n/, '\n').replace('className={extra.label}', ''))
  await expect(sfcStyles).toHaveCount(1)
  await expect(page.locator('span')).toHaveCSS('font-weight', '400')
  await expect(page.getByRole('button')).toHaveText('Count is 3')
})

test('CSS → JS → CSS: JS の変更は state を保った Fast Refresh、最後の CSS 変更は再評価なしで反映される', async ({ page }) => {
  const button = page.getByRole('button')
  await edit((s) => s.replace('rgb(255, 0, 0)', 'rgb(0, 128, 0)'))
  await expect(button).toHaveCSS('color', 'rgb(0, 128, 0)')
  const afterCss = await counters(page)

  await edit((s) => s.replace('Count is', 'Clicks:'))
  await expect(button).toHaveText('Clicks: 3')
  // 再評価後もクラス名マップが CSS と一致している
  await expect(button).toHaveCSS('color', 'rgb(0, 128, 0)')
  const afterJs = await counters(page)
  expect(afterJs.evals).toBe(afterCss.evals + 1)

  await edit((s) => s.replace('rgb(0, 128, 0)', 'rgb(0, 0, 255)'))
  await expect(button).toHaveCSS('color', 'rgb(0, 0, 255)')
  expect(await counters(page)).toEqual(afterJs)
})

test('構文エラーから CSS を変えて復帰: エラー表示が消え、state を保ったまま反映される', async ({ page }) => {
  const button = page.getByRole('button')
  await edit((s) => s + '\nconst (')
  await expect(page.locator('vite-error-overlay')).toBeAttached()

  await write(BASE.replace('rgb(255, 0, 0)', 'rgb(0, 0, 255)'))
  await expect(button).toHaveCSS('color', 'rgb(0, 0, 255)')
  await expect(page.locator('vite-error-overlay')).not.toBeAttached()
  await expect(button).toHaveText('Count is 3')
})

