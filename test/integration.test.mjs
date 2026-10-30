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

// Use the client shipped with the pinned CNCjs server so protocol versions agree.
const require = createRequire(import.meta.url);
const cncRequire = createRequire(require.resolve('cncjs/package.json'));
const io = cncRequire('socket.io-client');

function event(socket, name, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off(name, listener); reject(new Error(`Timed out: ${name}`)); }, 15000);
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
  socket.disconnect();
});
