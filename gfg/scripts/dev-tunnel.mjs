// scripts/dev-tunnel.mjs
// Mobile dev testing: relay + Vite + a free Cloudflare HTTPS tunnel.
// `npm run dev:tunnel`
//
// WHY: a phone can't fully sign in against plain http://<LAN-IP>:3000 because
// WebCrypto (crypto.subtle) only exists on HTTPS or localhost. The tunnel gives
// a real https://<random>.trycloudflare.com URL that Dynamic's wallet login can
// use. 99% of users are mobile, so test on the phone before committing.
//
// The tunnel URL changes every run. Add it (or the wildcard https://*.trycloudflare.com)
// to Dynamic's allowed CORS origins once, then Dynamic login works on any run.
//
// Usage: npm run dev:tunnel
//
// Env tweaks (all optional):
//   GFG_CLOUDFLARED    path to the cloudflared binary (default: auto-resolve)
//   GFG_VITE_PORT      fixed port for Vite (default: find a free one from 3000)

import { spawn } from 'child_process';
import { existsSync, statSync } from 'fs';
import { homedir } from 'os';
import { join, dirname, extname } from 'path';
import { fileURLToPath } from 'url';
import net from 'net';

const root = dirname(fileURLToPath(import.meta.url)) + '/..';
const node = process.execPath;

// stdio: stdin is '/dev/null' (ignore) for every child. Spawning with full
// 'inherit' hands the children the parent's TTY stdin; when that stream is
// closed/detached under npm or a tunnel the read throws EIO
// ('Unhandled error event … read EIO' on a readline interface). These are
// long-running servers that never need keyboard input, so detaching their
// stdin is safe and removes the crash.
const detachedStdio = ['ignore', 'inherit', 'inherit'];

// Resolve the cloudflared binary: explicit env, PATH, then the common
// ~/.local/bin install location (our setup instructions put it there).
// Returns a string path or null (with the reason logged).
function resolveCloudflared() {
  if (process.env.GFG_CLOUDFLARED && existsSync(process.env.GFG_CLOUDFLARED)) {
    return process.env.GFG_CLOUDFLARED;
  }
  const candidates = [process.env.GFG_CLOUDFLARED, 'cloudflared'].filter(Boolean);
  for (const c of candidates) {
    // If it's a bare command name, only keep it if it exists as an executable
    // file somewhere relative to the repo or on a PATH-like lookup is not
    // reliable here — so we check ~/.local/bin and then fall through.
    if (c.includes('/') || c.includes('\\')) {
      if (existsSync(c) && statSync(c).isFile()) return c;
    }
  }
  const local = join(homedir(), '.local', 'bin', 'cloudflared');
  if (existsSync(local)) {
    return extname(local) === '' || process.platform !== 'win32' ? local : (local + '.exe');
  }
  return null;
}

// Reserve a free port starting from `start` (default 3000). This prevents the
// "Port 3000 is in use, trying another one…" drift where Vite moves to 3001 but
// the tunnel keeps targeting 3000.
function findFreePort(start = 3000) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => {
      // Port taken — try the next one.
      resolve(findFreePort(start + 1));
    });
    probe.listen(start, () => {
      probe.close(() => resolve(start));
    });
  });
}

// True if something is already listening on `port`. Used to decide whether to
// spawn a fresh relay or reuse a stray one left over from a crashed run.
function portInUse(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(true));
    probe.listen(port, () => probe.close(() => resolve(false)));
  });
}

const cloudflared = resolveCloudflared();
if (!cloudflared) {
  console.error(`[dev:tunnel] cloudflared not found. Install it and try again:
    ~/.local/bin/cloudflared  (see AGENTS.md / the deploy docs)
  or set GFG_CLOUDFLARED=/path/to/cloudflared`);
  process.exit(1);
}

const vitePort = process.env.GFG_VITE_PORT ? Number(process.env.GFG_VITE_PORT) : await findFreePort();

// The relay binds a fixed port (:8787). A stray from an earlier run is safe to
// reuse: the relay is stateless (reads accounts on-chain, spend ledger in a
// shared file), so spawning a second one merely loses the race and prints a
// scary "already in use" error. Reuse it; only spawn when the port is free.
const RELAY_PORT = 8787;
let relay = null;
if (await portInUse(RELAY_PORT)) {
  console.log(`[dev:tunnel] relay already listening on :${RELAY_PORT} — reusing it (left by an earlier run; /api proxy works)`);
} else {
  relay = spawn(node, ['scripts/relay-server.mjs'], { cwd: root, stdio: detachedStdio });
}
const vite = spawn(node, ['node_modules/vite/bin/vite.js', '--host', '--port', String(vitePort), '--strictPort'], { cwd: root, stdio: detachedStdio });

console.log(`[dev:tunnel] Vite will bind port ${vitePort} (strict) and the tunnel will point at http://localhost:${vitePort}`);

// Give Vite a moment to bind before opening the tunnel to it.
setTimeout(() => {
  const tunnel = spawn(cloudflared, ['tunnel', '--url', `http://localhost:${vitePort}`], { cwd: root, stdio: detachedStdio });
  tunnel.on('exit', (code) => {
    console.log(`[dev:tunnel] cloudflared exited (${code}) — stopping relay + vite`);
    shutdown('SIGTERM');
  });
  tunnel.on('error', (err) => {
    console.error(`[dev:tunnel] cloudflared error: ${err.message}`);
  });
}, 1500);

// Guard every child's 'error' event (spawn failure, EIO on the stream) so it
// never bubbles to an unhandled 'error' and kills the parent silently.
for (const child of [vite, ...(relay ? [relay] : [])]) {
  child.on('error', (err) => {
    console.error(`[dev:tunnel] process error: ${err.message}`);
  });
}

function shutdown(signal) {
  console.log(`\n[dev:tunnel] ${signal} received — stopping vite${relay ? ' + relay' : ''}`);
  if (relay) relay.kill('SIGTERM');
  vite.kill('SIGTERM');
  setTimeout(() => process.exit(0), 300);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));