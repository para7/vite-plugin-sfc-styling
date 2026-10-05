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

test('CSS だけの変更: スタイルが変わり、モジュール再評価も再レンダーも起きない', async ({ page }) => {
  const button = page.getByRole('button')
  await expect(button).toHaveCSS('color', 'rgb(255, 0, 0)')
  const before = await counters(page)

  await edit((s) => s.replace('rgb(255, 0, 0)', 'rgb(0, 0, 255)'))
  await expect(button).toHaveCSS('color', 'rgb(0, 0, 255)')

  expect(await counters(page)).toEqual(before)
  await expect(button).toHaveText('Count is 3')
})

test('2 つ目のブロックだけの変更も反映される', async ({ page }) => {
  const label = page.locator('span')
  await expect(label).toHaveCSS('font-weight', '700')
  const before = await counters(page)

  // 400 はブラウザ既定値なので、スタイルが外れただけでも通ってしまう。既定以外の値を使う
  await edit((s) => s.replace('font-weight: 700', 'font-weight: 900'))
  await expect(label).toHaveCSS('font-weight', '900')
  expect(await counters(page)).toEqual(before)
})

test('JS の変更: Fast Refresh で state を保ったまま、スタイルも当たり続ける', async ({ page }) => {
  const button = page.getByRole('button')
  const before = await counters(page)

  await edit((s) => s.replace('Count is', 'Clicks:'))
  await expect(button).toHaveText('Clicks: 3')
  await expect(button).toHaveCSS('color', 'rgb(255, 0, 0)')
  expect((await counters(page)).evals).toBe(before.evals + 1)
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

test('CSS → JS → CSS の順に変更しても、最後の CSS 変更は再評価なしで反映される', async ({ page }) => {
  const button = page.getByRole('button')
  await edit((s) => s.replace('rgb(255, 0, 0)', 'rgb(0, 128, 0)'))
  await expect(button).toHaveCSS('color', 'rgb(0, 128, 0)')

  await edit((s) => s.replace('Count is', 'Clicks:'))
  await expect(button).toHaveText('Clicks: 3')
  const afterJs = await counters(page)

  await edit((s) => s.replace('rgb(0, 128, 0)', 'rgb(0, 0, 255)'))
  await expect(button).toHaveCSS('color', 'rgb(0, 0, 255)')
  expect(await counters(page)).toEqual(afterJs)
})

test('CSS を何度変更しても <style> が重複しない', async ({ page }) => {
  const styleCount = () => page.locator('style[data-vite-dev-id*=".sfc"]').count()
  const before = await styleCount()
  expect(before).toBe(2)
  for (const c of ['rgb(1, 1, 1)', 'rgb(2, 2, 2)', 'rgb(3, 3, 3)']) {
    await edit((s) => s.replace(/\.button \{ color: [^;]+;/, `.button { color: ${c};`))
    await expect(page.getByRole('button')).toHaveCSS('color', c)
  }
  expect(await styleCount()).toBe(before)
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

test('構文エラーから元の内容に戻す (自動保存でよくある): エラー表示が消える', async ({ page }) => {
  await edit((s) => s + '\nconst (')
  await expect(page.locator('vite-error-overlay')).toBeAttached()

  await write(BASE)
  await expect(page.locator('vite-error-overlay')).not.toBeAttached()
  await expect(page.getByRole('button')).toHaveText('Count is 3')
})
