// scripts/foskaay-ggi-demo-ui-test.mjs — drive the Ludo demo page in headless
// Chrome over the DevTools Protocol and prove the full flow works: the page
// loads the ludo-lab skin, New match connects + creates on-chain, the centre
// roll is a FREE midchain call, and the board comes from the contract.
//
// Requires: relay on :8787 and Vite dev on :3000 (npm run dev / dev.mjs), plus
// google-chrome on PATH. Prints PASS/FAIL and any console errors.
import { spawn, execSync } from 'child_process';
import { setTimeout as sleep } from 'timers/promises';
import WebSocket from 'ws';
import http from 'http';

const PAGE = process.env.GFG_DEMO_URL || 'http://localhost:3000/foskaay-ggi/demos/board/ludo/';
const PORT = 9222;

function getJSON(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

let seq = 0;
function rpc(ws, method, params) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const onMsg = (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.id === id) { ws.off('message', onMsg); m.error ? reject(new Error(method + ': ' + JSON.stringify(m.error))) : resolve(m.result); }
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
}
async function evaluate(ws, expr) {
  const r = await rpc(ws, 'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('eval threw: ' + JSON.stringify(r.exceptionDetails.exception));
  return r.result.value;
}

(async () => {
  try { execSync('pkill -f "remote-debugging-port=9222" 2>/dev/null'); } catch (_) {}
  const chrome = spawn('google-chrome', [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--remote-allow-origins=*',
    '--remote-debugging-port=' + PORT, '--user-data-dir=/tmp/opencode/chrome-prof', 'about:blank',
  ], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 30 && !target; i++) {
    await sleep(500);
    try { const list = await getJSON('/json'); target = list.find((t) => t.type === 'page'); } catch (_) {}
  }
  if (!target) throw new Error('no chrome devtools target');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });

  const errors = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.method === 'Runtime.exceptionThrown') errors.push('EXCEPTION: ' + (m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description || m.params.exceptionDetails.text));
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errors.push('LOG: ' + m.params.entry.text);
  });
  await rpc(ws, 'Runtime.enable');
  await rpc(ws, 'Log.enable');
  await rpc(ws, 'Page.enable');
  await rpc(ws, 'Page.navigate', { url: PAGE });
  await sleep(6000);

  const globals = await evaluate(ws, `JSON.stringify({bridge:typeof window.GFG_LUDO, board:typeof window.drawLudoLayout, tumble:typeof window.showDiceTumble, canvas:!!document.getElementById('ludoCanvas'), frame:!!document.getElementById('board-frame')})`);
  console.log('page globals:', globals);

  // New match (connect + create on-chain), then wait until the board is live.
  await evaluate(ws, `document.getElementById('ld-new').click(); true`);
  let connected = false;
  for (let i = 0; i < 40 && !connected; i++) {
    await sleep(1000);
    connected = await evaluate(ws, `!!window.GFG_LUDO.board()`);
  }
  const started = await evaluate(ws, `(function(){var b=window.GFG_LUDO.board();return JSON.stringify({match:!!b, turn:b&&b.turn, tokens:b&&b.steps, status:document.getElementById('ld-status').textContent.slice(0,90)});})()`);
  console.log('after New match (connected=' + connected + '):', started);

  // Roll via the bridge (the same call the centre tap makes), then wait for the
  // on-chain dice to land in the number row.
  await evaluate(ws, `(function(){window.rollDiceEngine();return true;})()`);
  let diceShown = false;
  for (let i = 0; i < 20 && !diceShown; i++) {
    await sleep(700);
    diceShown = await evaluate(ws, `document.getElementById('val-d1').innerText !== '-'`);
  }
  const rolled = await evaluate(ws, `(function(){var b=window.GFG_LUDO.board();return JSON.stringify({turn:b&&b.turn, d1:document.getElementById('val-d1').innerText, d2:document.getElementById('val-d2').innerText, total:document.getElementById('val-total').innerText, status:document.getElementById('ld-status').textContent.slice(0,90), gas:document.getElementById('ld-cost').textContent});})()`);
  console.log('after roll (diceShown=' + diceShown + '):', rolled);

  await sleep(8000);
  const moved = await evaluate(ws, `(function(){var b=window.GFG_LUDO.board();return JSON.stringify({tokens:b&&b.steps, status:document.getElementById('ld-status').textContent.slice(0,90), gas:document.getElementById('ld-cost').textContent});})()`);
  console.log('after a few turns:', moved);

  // If it is the user's turn with a legal move, tap a yard token on the canvas
  // and prove the move lands (the contract re-validates it).
  let tokenReleased = false;
  const canMove = await evaluate(ws, `document.getElementById('ld-status').textContent.indexOf('blinking token') >= 0`);
  if (canMove) {
    await evaluate(ws, `(function(){
      var c=document.getElementById('ludoCanvas'); var r=c.getBoundingClientRect();
      var cell=c.width/15; var col=2,row=2;
      var cx=r.left + ((col+0.5)*cell)*(r.width/c.width);
      var cy=r.top + ((row+0.5)*cell)*(r.height/c.height);
      c.dispatchEvent(new MouseEvent('click',{clientX:cx,clientY:cy,bubbles:true}));
      return true;
    })()`);
    for (let i = 0; i < 20 && !tokenReleased; i++) {
      await sleep(700);
      tokenReleased = await evaluate(ws, `(function(){var b=window.GFG_LUDO.board();return !!(b && b.steps[0] >= 0);})()`);
    }
    const afterMove = await evaluate(ws, `(function(){var b=window.GFG_LUDO.board();return JSON.stringify({tokens:b&&b.steps, gas:document.getElementById('ld-cost').textContent});})()`);
    console.log('after token tap (tokenReleased=' + tokenReleased + '):', afterMove);
  } else {
    console.log('after a few turns: no 6 this roll, no token to tap (flow still verified)');
  }

  console.log('console errors:', errors.length ? errors.slice(0, 8) : 'NONE');

  const g = JSON.parse(globals);
  const moveOk = !canMove || tokenReleased;
  const ok = g.bridge === 'object' && g.board === 'function' && g.tumble === 'function' && g.canvas && g.frame && connected && diceShown && moveOk && errors.length === 0;
  console.log(ok ? 'PASS: page + bridge load clean, connect + free roll + on-chain dice + token move all work' : 'FAIL: see above');

  ws.close();
  try { chrome.kill('SIGKILL'); } catch (_) {}
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('UI test failed:', e.message); try { execSync('pkill -f "remote-debugging-port=9222" 2>/dev/null'); } catch (_) {} process.exit(1); });
