import { fileURLToPath } from 'node:url'
import { mergeConfig, defineConfig } from 'vitest/config'
import viteConfig from './vite.config.js'

/**
 * Client test harness.
 *
 * The audit's root cause #2 was "no lint or tests in CI": a hard ReferenceError
 * on the app's primary screen shipped and survived. `.github/workflows/ci.yml`
 * already runs `npm run test -- --run` in the client job — this file is what
 * makes that job real.
 *
 * It reuses `vite.config.js` so tests compile with the exact same JSX / alias /
 * plugin pipeline the app builds with. `test.env` is set explicitly because
 * `client/.env` is gitignored: `src/lib/config.js` throws on a missing
 * VITE_API_URL in a production build and warns in dev, and CI has no .env file.
 */
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      globals: true,
      environment: 'jsdom',
      setupFiles: ['./src/test/setup.js'],
      css: false,
      restoreMocks: true,
      clearMocks: true,
      unstubEnvs: true,
      unstubGlobals: true,
      env: {
        VITE_API_URL: 'http://localhost:5015/api',
        VITE_SOCKET_URL: 'http://localhost:5015',
      },
      include: ['src/**/*.{test,spec}.{js,jsx}'],
      exclude: ['node_modules/**', 'dist/**'],
      /* Radix + TanStack render deep trees; 10s is generous but keeps a genuine
       * hang from burning the whole CI job. */
      testTimeout: 15000,
      hookTimeout: 15000,
      coverage: {
        provider: 'v8',
        reporter: ['text-summary', 'html', 'lcov'],
        reportsDirectory: './coverage',
        include: ['src/**/*.{js,jsx}'],
        exclude: [
          'src/test/**',
          'src/main.jsx',
          'src/**/*.test.{js,jsx}',
          'src/components/ui/index.js',
        ],
      },
    },
    resolve: {
      alias: {
        '@test': fileURLToPath(new URL('./src/test', import.meta.url)),
      },
    },
  })
)
