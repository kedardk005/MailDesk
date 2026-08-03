import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    strictPort: true,
  },
  build: {
    // Every route is React.lazy'd (see App.jsx). These manual groups keep the
    // heavy shared dependencies out of the first paint on /login.
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined
          if (id.includes('socket.io') || id.includes('engine.io')) return 'vendor-socket'
          // recharts/d3 are deliberately NOT grouped. A manual chunk for them
          // captured recharts' CJS-interop copy of React, which vendor-react
          // then imported — making vendor-charts (385 kB) a static import of the
          // entry chunk and modulepreloaded into /login. recharts has exactly
          // one importer (the lazy /reports route), so leaving it unnamed lets
          // Rollup fold it into that route's chunk, fully lazy.
          if (id.includes('@tanstack')) return 'vendor-table'
          // Radix / cmdk / sonner are deliberately NOT grouped: grouping them
          // would drag the command palette and every dialog primitive into the
          // eager chunk that /login downloads.
          if (id.includes('react-router')) return 'vendor-router'
          if (id.includes('/react-dom/') || id.includes('/react/') || id.includes('scheduler')) {
            return 'vendor-react'
          }
          return undefined
        },
      },
    },
  },
})
