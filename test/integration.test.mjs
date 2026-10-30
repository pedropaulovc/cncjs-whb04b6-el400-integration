import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { chromium, expect } from '@playwright/test';

// Use the client shipped with the pinned CNCjs server so protocol versions agree.
const require = createRequire(import.meta.url);
const cncRequire = createRequire(require.resolve('cncjs/package.json'));
const io = cncRequire('socket.io-client');

function event(socket, name, predicate = () => true, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off(name, listener); reject(new Error(`Timed out: ${name}`)); }, timeout);
    const listener = (...args) => {
      if (!predicate(...args)) return;
      clearTimeout(timer); socket.off(name, listener); resolve(args);
    };
    socket.on(name, listener);
  });
}

test('real CNCjs serves widgets and reports simulated jog/offset through its controller parser', { timeout: 45000 }, async t => {
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const temp = await mkdtemp(resolve(tmpdir(), 'manual-mill-test-'));
  const child = spawn(process.execPath, ['scripts/start.mjs', '--mode', 'simulator', '--port', String(port), '--config', resolve(temp, 'cncrc.json')], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); }
    await rm(temp, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  let response;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`CNCjs exited: ${output}`);
    try { response = await fetch(base); if (response.ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(response?.ok, `CNCjs did not start: ${output}`);
  for (const path of ['/el400/', '/whb04b/widget/index.html', '/whb04b/whb04b-webhid.js']) {
    const asset = await fetch(base + path);
    assert.equal(asset.status, 200, path);
  }
  const login = await fetch(base + '/api/signin', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(login.status, 200);
  const { token } = await login.json();
  assert.ok(token);
  const socket = io(base, { query: { token }, transports: ['websocket'], reconnection: false });
  t.after(() => socket.disconnect());
  await event(socket, 'connect');
  const portsPromise = event(socket, 'serialport:list');
  socket.emit('list');
  const [ports] = await portsPromise;
  assert.deepEqual(ports.map(p => p.port), ['SIMULATOR']);
  await new Promise((resolve, reject) => socket.emit('open', 'SIMULATOR', { controllerType: 'Grbl', baudrate: 115200 }, err => err ? reject(new Error(String(err))) : resolve()));
  await event(socket, 'controller:state', (type, state) => type === 'Grbl' && state.status?.activeState === 'Idle');
  const installed = JSON.parse(await readFile('.runtime/install.json', 'utf8'));
  const { CncjsSession } = await import(pathToFileURL(resolve(installed.pendant.mountPath, 'widget/cncjs-session.js')));
  const { Grbl } = await import(pathToFileURL(resolve(installed.pendant.mountPath, 'widget/grbl.js')));
  let joined;
  const ready = new Promise(resolve => { joined = resolve; });
  const pendant = new CncjsSession({ io, origin: base, onStatus: status => { if (status.phase === 'joined') joined(); } });
  t.after(() => pendant.disconnect());
  pendant.connect(token);
  await Promise.race([ready, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('Pendant failed to join real CNCjs controller')), 10000);
    timer.unref();
    ready.then(() => clearTimeout(timer));
  })]);
  assert.equal(pendant.status.port, 'SIMULATOR');
  const inches = event(socket, 'controller:state', (_, state) => state.parserstate?.modal?.units === 'G20');
  socket.emit('command', 'SIMULATOR', 'gcode', 'G20');
  await inches;
  const moved = event(socket, 'controller:state', (_, state) => Number(state.status?.mpos?.x) === 5 && state.status.activeState === 'Idle');
  new Grbl(pendant).jog('X', 5, 0x10);
  await moved;
  const zeroed = event(socket, 'controller:state', (_, state) => Number(state.status?.wpos?.x) === 0 && Number(state.status?.mpos?.x) === 5);
  socket.emit('command', 'SIMULATOR', 'gcode', 'G21 G10 L20 P1 X0');
  await zeroed;
  const rejected = await new Promise(resolve => socket.emit('open', 'COM1', { controllerType: 'Grbl', baudrate: 115200 }, resolve));
  assert.ok(rejected, 'Simulation must reject hardware even when directly requested');

  const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || undefined, headless: process.env.PW_DISPLAY !== 'headed' });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const browserErrors = [];
  page.on('pageerror', error => browserErrors.push(error.message));
  await page.route(`${base}/integration-test`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Widget integration test</title><body></body>' }));
  await page.goto(`${base}/integration-test`);
  // Embed the real built widgets using CNCjs's same-origin/token contract.
  await page.evaluate(({ token }) => {
    document.body.replaceChildren();
    for (const [name, route] of [['pendant', '/whb04b/widget/index.html?'], ['dro', '/el400/?source=cncjs&']]) {
      const frame = document.createElement('iframe');
      frame.name = name;
      frame.style.cssText = 'display:block;width:1100px;height:800px;border:0';
      frame.src = `${route}token=${encodeURIComponent(token)}`;
      document.body.append(frame);
    }
  }, { token });
  const pendantFrame = page.frameLocator('iframe[name="pendant"]');
  await expect(pendantFrame.locator('#sockPill')).toHaveText('joined');
  await expect(pendantFrame.locator('#portPill')).toHaveText('port SIMULATOR');
  const droFrame = page.frameLocator('iframe[name="dro"]');
  // Wait past the startup splash and verify the actual machine coordinate.
  // A fresh EL400 defaults to inches: 5 mm = 0.1969 in at four decimals.
  await expect(droFrame.getByTestId('axis-value-x')).toHaveText('0.1969', { timeout: 10000 });
  await droFrame.getByRole('button', { name: /toggle units/i }).click();
  await expect(droFrame.getByTestId('axis-value-x')).toHaveText('5.0000');
  const movedAgain = event(socket, 'controller:state', (_, state) => Number(state.status?.mpos?.x) === 10 && state.status.activeState === 'Idle');
  new Grbl(pendant).jog('X', 5, 0x10);
  await movedAgain;
  await expect(droFrame.getByTestId('axis-value-x')).toHaveText('10.0000');
  assert.deepEqual(browserErrors, [], 'Mounted widgets must boot without browser errors');
  const jogging = event(socket, 'controller:state', (_, state) => state.status?.activeState === 'Jog');
  const controls = new Grbl(pendant);
  controls.jog('X', 10000, 0x0d);
  await jogging;
  const stopped = event(socket, 'controller:state', (_, state) => state.status?.activeState === 'Idle', 2000);
  controls.stop();
  const [, stoppedState] = await stopped;
  assert.ok(Number(stoppedState.status.mpos.x) < 20, 'Stop must cancel before the jog target');
  const running = event(socket, 'controller:state', (_, state) => state.status?.activeState === 'Run');
  socket.emit('command', 'SIMULATOR', 'gcode', 'G21 G91 G1 X10 F50');
  await running;
  const held = event(socket, 'controller:state', (_, state) => state.status?.activeState === 'Hold', 2000);
  controls.stop();
  const [, heldState] = await held;
  const heldX = Number(heldState.status.mpos.x);
  const nextHeld = event(socket, 'serialport:read', line => line.startsWith('<Hold'), 2000);
  socket.emit('command', 'SIMULATOR', 'statusreport');
  const [nextHeldLine] = await nextHeld;
  assert.equal(Number(nextHeldLine.match(/MPos:([^,]+)/)[1]), heldX, 'Programmed motion must remain held');
  socket.disconnect();
});
