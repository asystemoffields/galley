import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Relative asset paths so the build works at any URL —
  // root domains, GitHub Pages subpaths, or file://
  base: './',
})
