import { defineConfig } from 'vite';

// Google AdSense loader, injected STATICALLY into the <head> of every built
// HTML page (Adsense's checker requires the script to be in the served HTML
// between <head></head>, not injected at runtime). One place; applies to every
// page via Vite's transformIndexHtml.
const ADSENSE_SCRIPT = '<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-7686312364288737" crossorigin="anonymous"></script>';

export default defineConfig({
  root: '.',
  plugins: [
    {
      name: 'inject-adsense-head',
      transformIndexHtml(html) {
        if (html.indexOf('pagead2.googlesyndication.com/pagead/js/adsbygoogle.js') >= 0) return html;
        if (html.indexOf('</head>') === -1) return html;
        return html.replace('</head>', '    ' + ADSENSE_SCRIPT + '\n  </head>');
      }
    }
  ],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: 'index.html',
        'ludo-lab': './games/ludo-lab/index.html',
        chess: './games/chess/index.html',
        changelog: './changelog/index.html',
        'changelog-admin': './changelog/admin.html',
        'changelog-economics': './changelog/economics.html',
                'changelog-architecture': './changelog/architecture.html',
        'changelog-research': './changelog/research.html',
        'changelog-tests': './changelog/tests.html',
        'changelog-architecture-v2': './changelog/architecture-v2.html',
        'changelog-architecture-arcv1m1': './changelog/architecture-arcv1m1.html',
        'changelog-architecture-arcv1m2': './changelog/architecture-arcv1m2.html',
        'changelog-architecture-arcv1m3': './changelog/architecture-arcv1m3.html',
        'changelog-architecture-arcv1m4': './changelog/architecture-arcv1m4.html',
        'changelog-architecture-arcv1m5': './changelog/architecture-arcv1m5.html',
        'changelog-architecture-arcv1m6': './changelog/architecture-arcv1m6.html',
        'changelog-architecture-arcv1m7': './changelog/architecture-arcv1m7.html',
        'changelog-architecture-arcv1m8': './changelog/architecture-arcv1m8.html',
        'changelog-architecture-arcv1m9': './changelog/architecture-arcv1m9.html',
        'changelog-architecture-arcv1m10': './changelog/architecture-arcv1m10.html',
        'changelog-architecture-arcv1m11': './changelog/architecture-arcv1m11.html',
        'changelog-architecture-v2-arcv2m1': './changelog/architecture-v2-arcv2m1.html',
        'changelog-architecture-v2-arcv2m2': './changelog/architecture-v2-arcv2m2.html',
        'changelog-architecture-v2-arcv2m3': './changelog/architecture-v2-arcv2m3.html',
        'changelog-architecture-v2-arcv2m4': './changelog/architecture-v2-arcv2m4.html',
        'changelog-architecture-v2-arcv2m5': './changelog/architecture-v2-arcv2m5.html',
        'changelog-architecture-v2-arcv2m6': './changelog/architecture-v2-arcv2m6.html',
        'changelog-architecture-v2-arcv2m7': './changelog/architecture-v2-arcv2m7.html',
        'changelog-architecture-v2-arcv2m8': './changelog/architecture-v2-arcv2m8.html',
        'changelog-architecture-v2-arcv2m9': './changelog/architecture-v2-arcv2m9.html',
        'changelog-architecture-v2-arcv2m10': './changelog/architecture-v2-arcv2m10.html',
        'changelog-architecture-v2-arcv2m11': './changelog/architecture-v2-arcv2m11.html',
        'changelog-architecture-v2-arcv2m12': './changelog/architecture-v2-arcv2m12.html',
        'changelog-architecture-v2-arcv2m13': './changelog/architecture-v2-arcv2m13.html',
        'changelog-architecture-v2-arcv2m14': './changelog/architecture-v2-arcv2m14.html',
        'changelog-architecture-v2-arcv2m15': './changelog/architecture-v2-arcv2m15.html',
        'changelog-architecture-v2-arcv2m16': './changelog/architecture-v2-arcv2m16.html',
        'changelog-architecture-v2-arcv2m17': './changelog/architecture-v2-arcv2m17.html',
        'changelog-architecture-v2-arcv2m18': './changelog/architecture-v2-arcv2m18.html',
        agm: './agm/index.html',
        competitions: './competitions/index.html',
        games: './games/index.html',
        'foskaay-ggi-demos': './foskaay-ggi/demos/index.html',
        'foskaay-ggi-demos-board-ludo': './foskaay-ggi/demos/board/ludo/index.html',
        'foskaay-ggi-home': './foskaay-ggi/index.html',
        'foskaay-ggi-explorer': './foskaay-ggi/explorer/index.html',
        'foskaay-ggi-docs': './foskaay-ggi/docs/index.html',
        game: './games/game.html',
        countries: './countries/index.html',
        about: './about/index.html',
        contact: './contact/index.html',
        support: './support/index.html',
        forum: './forum/index.html',
        donate: './donate/index.html',
        economy: './economy/index.html',
        academy: './academy/index.html',
        privacy: './privacy.html',
        profile: './profile/index.html',
        'profile-points': './profile/points.html',
        'profile-upgrade': './profile/upgrade.html',
        'profile-subscription': './profile/subscription.html',
        'profile-booster': './profile/booster.html',
        'profile-pay-crypto': './profile/pay-crypto.html',
        'profile-affiliate': './profile/affiliate.html',
        'profile-activity': './profile/activity.html',
        'subscription-paid': './subscription-paid/index.html',
        payment: './payment/index.html',
        dashboard: './dashboard/index.html',
        backers: './backers/index.html',
        'dashboard-arc': './dashboard/arc.html',
        'dashboard-ops': './dashboard/ops.html',
        'dashboard-endpoints': './dashboard/endpoints.html',
        'dashboard-activity': './dashboard/activity.html',
        'dashboard-accounts': './dashboard/accounts.html',
        'dashboard-release': './dashboard/release.html',
        'dashboard-recovery': './dashboard/recovery.html',
        'dashboard-premium': './dashboard/premium.html',
        'dashboard-premium-subscribers': './dashboard/premium-subscribers.html',
        'dashboard-payment-tests': './dashboard/payment-tests.html',
        'dashboard-affiliate': './dashboard/affiliate.html',
        'dashboard-agm': './dashboard/agm.html',
        'dashboard-pricing': './dashboard/pricing.html',
        'dashboard-competitions': './dashboard/competitions.html',
        'dashboard-content-guide': './dashboard/content-style-guide.html',
        'dashboard-todo': './dashboard/todo.html',
        verify: './verify/index.html',
        // The header loader (public/global_header.js) injects the Dynamic
        // bootstrap module at runtime as /src/main.js (and /src/main-lab.js for
        // ludo-lab). Keep them as build inputs so they exist in dist under
        // those stable paths (see entryFileNames below). Before this, pages
        // referenced them with <script type="module"> tags, which is how Vite
        // bundled them; with the loader every page is header-script-free, so
        // the modules must be emitted explicitly.
        'src/main.js': './src/main.js',
        'src/main-lab.js': './src/main-lab.js'
      },
      output: {
        // Emit the runtime-injected modules under their stable root paths.
        entryFileNames: (chunk) => {
          if (chunk.name === 'src/main.js') return 'src/main.js';
          if (chunk.name === 'src/main-lab.js') return 'src/main-lab.js';
          return 'assets/[name]-[hash].js';
        }
      }
    }
  },
  server: {
    port: 3000,
    // Dev-only: allow LAN IPs and random tunnel domains (trycloudflare.com)
    // to reach Vite without its host check rejecting them.
    allowedHosts: true,
    proxy: {
      // App-sponsored delegation relay (scripts/relay-server.mjs)
      '/api': 'http://localhost:8787'
    }
  }
});