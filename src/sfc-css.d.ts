declare module 'virtual:sfc-css' {
  // 引数を strings のみにすることで ${} 補間を型エラーにする
  export function css(strings: TemplateStringsArray): Readonly<Record<string, string>>
}
