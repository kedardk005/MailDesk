import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
  },
  {
    /*
     * The design-system layer legitimately exports non-components alongside
     * components: cva variant factories (`buttonVariants`), re-exported Radix
     * primitives (`DialogTrigger`), context hooks (`useAuth`, `useConfirm`) and
     * helpers (`emailSnippet`). `react-refresh/only-export-components` is a
     * hot-reload ergonomics rule, not a correctness rule, and splitting each of
     * these into its own file would make the library harder to use, not safer.
     */
    files: [
      'src/components/ui/**/*.{js,jsx}',
      'src/components/*Provider.jsx',
      'src/components/CommandRegistry.jsx',
      'src/components/EmailBody.jsx',
      'src/components/ErrorBoundary.jsx',
    ],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },
])
