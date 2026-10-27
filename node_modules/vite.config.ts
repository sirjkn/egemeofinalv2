import { defineConfig, type Plugin } from 'vite'
import path from 'path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { spawn, type ChildProcess } from 'child_process'
import { execSync } from 'child_process'

function devApiPlugin(): Plugin {
  let child: ChildProcess | null = null

  return {
    name: 'dev-api-server',
    configureServer() {
      const serverDir = path.resolve(__dirname, 'server')

      // Install server deps if needed (silent, only if node_modules missing)
      try {
        const nm = path.join(serverDir, 'node_modules')
        if (!require('fs').existsSync(nm)) {
          console.log('[api] Installing server dependencies...')
          execSync('npm install --silent', { cwd: serverDir, stdio: 'inherit' })
        }
      } catch { /* ignore */ }

      console.log('[api] Starting Express server on :3001...')
      child = spawn('npm', ['run', 'dev'], {
        cwd: serverDir,
        stdio: 'inherit',
        shell: true,
      })

      child.on('error', (err) => {
        console.error('[api] Failed to start Express:', err.message)
      })

      // Kill Express when Vite exits
      const cleanup = () => { child?.kill(); }
      process.once('exit', cleanup)
      process.once('SIGINT', () => { cleanup(); process.exit(0); })
      process.once('SIGTERM', () => { cleanup(); process.exit(0); })
    },
  }
}


function figmaAssetResolver() {
  return {
    name: 'figma-asset-resolver',
    resolveId(id) {
      if (id.startsWith('figma:asset/')) {
        const filename = id.replace('figma:asset/', '')
        return path.resolve(__dirname, 'src/assets', filename)
      }
    },
  }
}

export default defineConfig({
  plugins: [
    figmaAssetResolver(),
    // The React and Tailwind plugins are both required for Make, even if
    // Tailwind is not being actively used – do not remove them
    // App.tsx is excluded from Babel (uses esbuild instead) to keep the
    // transform fast enough to avoid the Figma Make proxy timeout.
    react({ exclude: [/\/src\/app\/App\.tsx$/] }),
    tailwindcss(),
    devApiPlugin(),
  ],
  resolve: {
    alias: {
      // Alias @ to the src directory
      '@': path.resolve(__dirname, './src'),
    },
  },

  // File types to support raw imports. Never add .css, .tsx, or .ts files to this.
  assetsInclude: ['**/*.svg', '**/*.csv'],

  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        // If Express isn't ready yet, retry the request after 1s
        configure: (proxy) => {
          proxy.on('error', (_err, _req, res: any) => {
            res.writeHead(503, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, error: 'API server starting up — please retry in a moment' }))
          })
        },
      },
      '/uploads': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
})
