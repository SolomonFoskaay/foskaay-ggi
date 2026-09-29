import { defineConfig } from 'vite';

// Foskaay GGI site (this repo's ROOT). GFG lives under gfg/ for reference only.
// Developer-facing: home (pitch), demos, docs, explorer, about, contact, hire.
//
// The web JS (Dynamic auth) is under web/ and emitted at the stable path
// /web/main.js, which public/global_header.js injects. The Dynamic environment
// id is non-secret and comes from the build env (DYNAMIC_ENV_ID); the API token
// is NEVER exposed to the browser.
export default defineConfig({
  root: '.',
  publicDir: 'public',
  define: {
    __DYNAMIC_ENV_ID__: JSON.stringify(process.env.DYNAMIC_ENV_ID || ''),
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: 'index.html',
        demos: 'demos/index.html',
        'demos-board-ludo': 'demos/board/ludo/index.html',
        docs: 'docs/index.html',
        explorer: 'explorer/index.html',
        about: 'about/index.html',
        contact: 'contact/index.html',
        hire: 'hire/index.html',
        pricing: 'pricing/index.html',
        profile: 'profile/index.html',
        'arc-launch': 'arc-launch.html',
        'gfgnew-board-ludo-mp': 'gfgnew/board/ludo-mp/index.html',
        'web/main.js': 'web/main.js'
      },
      output: {
        entryFileNames: (chunk) => (
          chunk.name === 'web/main.js' ? 'web/main.js' : 'assets/[name]-[hash].js'
        )
      }
    }
  },
  server: {
    port: 3100,
    allowedHosts: true,
    proxy: {
      '/api': 'http://localhost:8787'
    }
  }
});
