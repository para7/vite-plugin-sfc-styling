/// <reference types="vitest/config" />
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import { defineConfig } from 'vite'
import sfcCss from './plugins/sfc-css.ts'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    sfcCss(),
    react(),
    babel({ presets: [reactCompilerPreset()] })
  ],
  test: {
    include: ['plugins/**/*.test.ts'],
  },
})
