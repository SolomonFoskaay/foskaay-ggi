import { defineConfig } from 'vite';

// Foskaay GGI site (this repo's ROOT). GFG lives under gfg/ for reference only.
// The site is simplified: home (pitch), docs, explorer, and the Ludo demo.
//
// The web JS (Dynamic auth + chain helpers) is under web/ and emitted at the
// stable path /web/main.js, which public/global_header.js injects. The Solidity
// contracts live under src/ (Foundry), so the web JS uses web/ to avoid the clash.
export default defineConfig({
  root: '.',
  publicDir: 'public',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: 'index.html',
        docs: 'docs/index.html',
        explorer: 'explorer/index.html',
        demos: 'demos/index.html',
        'demos-board-ludo': 'demos/board/ludo/index.html',
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
