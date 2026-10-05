import { useEffect, useState } from 'react'
import { css } from 'virtual:sfc-css'

// HMR でモジュールが再評価された回数 / React がコミットした回数をテストから観測する
const w = window as unknown as { __evals: number; __commits: number }
w.__evals = (w.__evals ?? 0) + 1

export function Counter() {
  const [n, setN] = useState(0)
  useEffect(() => {
    w.__commits = (w.__commits ?? 0) + 1
  })
  return (
    <button className={styles.button} onClick={() => setN(n + 1)}>
      <span className={extra.label}>Count is {n}</span>
    </button>
  )
}

const styles = css`
  .button { color: rgb(255, 0, 0); }
`

const extra = css`
  .label { font-weight: 700; }
`
