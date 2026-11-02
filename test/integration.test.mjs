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
const GrblRunner = cncRequire('./dist/cncjs/server/controllers/Grbl/GrblRunner.js').default;

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

for (const frame of ['MPos', 'WPos']) {
  test(`pendant preserves ${frame} completion through real CNCjs coordinate broadcasts`, async t => {
    const installed = JSON.parse(await readFile('.runtime/install.json', 'utf8'));
    const { CncjsSession } = await import(pathToFileURL(resolve(installed.pendant.mountPath, 'widget/cncjs-session.js')));
    const { Grbl } = await import(pathToFileURL(resolve(installed.pendant.mountPath, 'widget/grbl.js')));
    const listeners = new Map(), commands = [];
    const socket = { connected: true, on: (event, handler) => listeners.set(event, handler),
      emit: (...args) => commands.push(args), disconnect() {} };
    const session = new CncjsSession({ io: () => socket, origin: 'http://localhost', schedule: () => 0, cancel() {} });
    t.after(() => session.disconnect());
    session.connect('test-token');
    session.status = { phase: 'joined', port: 'SIMULATOR', controller: 'Grbl' };
    session.workflowState = 'idle';
    listeners.get('controller:settings')('Grbl', { settings: { $13: '0', $100: '250', $101: '250', $110: '3000', $111: '3000' } });
    const grbl = new Grbl(session, () => 20, () => {}, { schedule: () => 0, cancel() {} });
    const runner = new GrblRunner();
    runner.parse('[GC:G0 G54 G17 G21 G90 G94 M5 M9 T0 F0 S0]');
    const initial = `<Idle|${frame}:0.000,0.000,0.000|WCO:10.000,0.000,0.000|FS:0,0>`;
    runner.parse(initial);
    // CNCjs derives both coordinate frames even when GRBL reports only one.
    assert.equal(Number(runner.state.status.mpos.x) - Number(runner.state.status.wpos.x), 10);
    listeners.get('controller:state')('Grbl', structuredClone(runner.state));
    listeners.get('serialport:read')(initial);
    assert.equal(grbl.jog('X', 0.04, 250), 'sent');
    const completed = `<Idle|${frame}:0.040,0.000,0.000|FS:0,0>`;
    runner.parse(completed);
    listeners.get('serialport:read')(completed);
    // Completion now disposes its tracking immediately. Check the consumer
    // behavior after CNCjs echoes the derived frame, not the disposed predicate.
    listeners.get('controller:state')('Grbl', structuredClone(runner.state));
    grbl.cancelJog();
    assert.equal(grbl.jog('Y', 0.04, 250), 'sent', 'The first input on another axis must work');
    assert.ok(commands.every(args => args[2] !== 'jogCancel'), 'A completed move must not trigger cancellation');
  });
}

async function withRealWidgets(t, scenario) {
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
  const macroApi = async (path = '', method = 'GET', body) => {
    const response = await fetch(`${base}/api/macros${path}`, {
      method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  await macroApi('', 'POST', { name: 'Pendant units', content: 'G20' });
  const savedMacro = (await macroApi()).records.find(record => record.name === 'Pendant units');
  assert.ok(savedMacro?.id);
  const socket = io(base, { query: { token }, transports: ['websocket'], reconnection: false });
  const serialTrace = [];
  let workflowState;
  let latestState;
  let senderState;
  let feederState;
  const writes = [];
  socket.on('sender:status', state => { senderState = state; });
  socket.on('feeder:status', state => { feederState = state; });
  socket.on('serialport:write', line => writes.push(line));
  socket.on('controller:state', (_, state) => { latestState = state; });
  socket.on('workflow:state', state => { workflowState = state; });
  const trace = entry => { serialTrace.push(entry); if (serialTrace.length > 50) serialTrace.shift(); };
  socket.on('controller:state', (_, state) => trace(state.status?.activeState));
  socket.on('serialport:read', trace);
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
  await expect.poll(() => pendant.state.parserstate?.modal?.units).toBe('G20');
  const moved = event(socket, 'controller:state', (_, state) => Number(state.status?.mpos?.x) === 5 && state.status.activeState === 'Idle');
  assert.equal(new Grbl(pendant, undefined, message => t.diagnostic(message)).jog('X', 5, 750), 'sent');
  await moved;
  const zeroed = event(socket, 'controller:state', (_, state) => Number(state.status?.wpos?.x) === 0 && Number(state.status?.mpos?.x) === 5);
  socket.emit('command', 'SIMULATOR', 'gcode', 'G21 G10 L20 P1 X0');
  await zeroed;
  await expect.poll(() => pendant.state.parserstate?.modal?.units).toBe('G21');
  const rejected = await new Promise(resolve => socket.emit('open', 'COM1', { controllerType: 'Grbl', baudrate: 115200 }, resolve));
  assert.ok(rejected, 'Simulation must reject hardware even when directly requested');

  const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || undefined, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.addInitScript(() => {
    // Observe the widget's own socket, rather than assuming the Node client and
    // browser have received the same controller broadcast at the same time.
    let socketIo;
    Object.defineProperty(window, 'io', {
      configurable: true,
      get: () => socketIo,
      set: io => {
        socketIo = new Proxy(io, {
          apply(target, receiver, args) {
            const socket = Reflect.apply(target, receiver, args);
            socket.on('controller:state', (_, state) => { window.testControllerState = state; });
            return socket;
          },
        });
      },
    });
    // Exercise the real LCD encoder and transport against a USB test double.
    const device = new EventTarget();
    Object.assign(device, {
      vendorId: 0x10ce, productId: 0xeb93, opened: false,
      async open() { this.opened = true; },
      async close() { this.opened = false; },
      async sendFeatureReport(reportId, bytes) {
        window.testLcdReports.push({ reportId, bytes: Array.from(bytes) });
        if (window.testLcdReports.length > 300) window.testLcdReports.splice(0, 3);
      },
    });
    window.testLcdReports = [];
    const hid = new EventTarget();
    hid.getDevices = async () => [device];
    hid.requestDevice = async () => [device];
    window.testHid = hid;
    window.testHidDevice = device;
    Object.defineProperty(navigator, 'hid', { configurable: true, value: hid });
    // Capture the real driver's EventTarget to inject pendant input without USB.
    const add = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (type, ...args) {
      if (type === 'use' && this.constructor.name === 'WHB04BWebHID') window.testPendant = this;
      return add.call(this, type, ...args);
    };
  });
  const browserErrors = [];
  page.on('pageerror', error => {
    browserErrors.push(error.message);
    t.diagnostic(`Browser exception: ${error.stack || error.message}`);
  });
  page.on('requestfailed', request => t.diagnostic(
    `Browser request failed: ${new URL(request.url()).pathname}: ${request.failure()?.errorText}`));
  page.on('response', response => {
    if (response.status() >= 400) t.diagnostic(`Browser HTTP ${response.status()}: ${new URL(response.url()).pathname}`);
  });
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
  try {
    // The static HTML pills exist before the module graph has loaded and boot's
    // DOMContentLoaded handler has run. Give document loading its own deadline,
    // then keep the normal socket/HID assertion deadlines. Exclude about:blank.
    await page.waitForFunction(() => ['pendant', 'dro'].every(name => {
      const frame = document.querySelector(`iframe[name="${name}"]`);
      return frame?.contentDocument?.readyState === 'complete'
        && frame.contentWindow.location.href === frame.src;
    }), null, { timeout: 15000 });
    assert.deepEqual(browserErrors, [], 'Widget documents must load without browser exceptions');
    await expect(pendantFrame.locator('#sockPill')).toHaveText('joined');
  } catch (error) {
    t.diagnostic(`Widget startup browser exceptions: ${JSON.stringify(browserErrors)}`);
    try {
      const frames = await page.evaluate(() => [...document.querySelectorAll('iframe')].map(frame => ({
        name: frame.name,
        path: frame.contentWindow.location.pathname,
        readyState: frame.contentDocument?.readyState,
        socketIo: typeof frame.contentWindow.io,
        pendantBooted: Boolean(frame.contentWindow.testPendant),
        pills: ['sockPill', 'portPill', 'hidPill', 'tokenPill'].map(id => [id, frame.contentDocument?.getElementById(id)?.textContent]),
        log: frame.contentDocument?.getElementById('log')?.textContent?.slice(-2000),
      })));
      t.diagnostic(`Widget startup frames: ${JSON.stringify(frames)}`);
    } catch (diagnosticError) {
      t.diagnostic(`Cannot inspect widget startup: ${diagnosticError.message}`);
    }
    t.diagnostic(`Widget startup CNCjs output: ${output}`);
    throw error;
  }
  const lcdFrame = async () => page.frame({ name: 'pendant' }).evaluate(() => {
    const reports = window.testLcdReports;
    const count = reports.length - reports.length % 3;
    if (count < 3) return null;
    const chunks = reports.slice(count - 3, count);
    if (chunks.some(chunk => chunk.reportId !== 6 || chunk.bytes.length !== 7)) throw new Error('Invalid LCD feature report framing');
    return chunks.flatMap(chunk => chunk.bytes);
  });
  await expect.poll(async () => (await lcdFrame())?.slice(0, 3)).toEqual([0xfe, 0xfd, 0xfe]);
  const droFrame = page.frameLocator('iframe[name="dro"]');
  // CNCjs parser units are authoritative, not EL400's standalone inch default.
  await expect(droFrame.getByTestId('axis-value-x')).toHaveText('5.0000', { timeout: 10000 });
  if (scenario === 'controls') {
    await exerciseUnitSync({ page, pendantFrame, droFrame, socket, writes, pendant, Grbl,
      state: () => latestState });
    await exerciseControls({ page, pendantFrame, socket, writes, macroApi, savedMacro,
      base, browserErrors, state: () => latestState });
    const portClosed = event(socket, 'serialport:close');
    socket.emit('close', 'SIMULATOR');
    await portClosed;
    await expect(pendantFrame.locator('#sockPill')).not.toHaveText('joined');
    await expect(pendantFrame.locator('#sockPill')).toBeVisible();
    await expect(pendantFrame.locator('#portPill')).toBeVisible();
    const disconnectedStart = writes.length;
    await droFrame.getByTestId('btn-toggle-unit').click();
    await expect(droFrame.getByTestId('controller-unit-status')).toBeVisible();
    assert.deepEqual(writes.slice(disconnectedStart).map(line => line.trim()).filter(line => /^(G20|G21)$/.test(line)), [],
      'Disconnected EL400 must not enqueue a unit change');
    return;
  }
  const movedAgain = event(socket, 'controller:state', (_, state) => Number(state.status?.mpos?.x) === 10 && state.status.activeState === 'Idle');
  assert.equal(new Grbl(pendant, undefined, message => t.diagnostic(message)).jog('X', 5, 750), 'sent');
  await movedAgain;
  await expect(droFrame.getByTestId('axis-value-x')).toHaveText('10.0000');
  // LinuxCNC's packed LCD report: FE FD FE, relative+Step flags, integer/fraction
  // coordinate pairs, then 16-bit feed/spindle override percentages.
  await expect.poll(lcdFrame).toEqual([
    0xfe, 0xfd, 0xfe, 0x81,
    5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    100, 0, 100, 0, 0,
  ]);
  // A fresh pendant must jog on its first wheel report without a Step button press.
  // Use the HID boundary here so parsing and dispatch are exercised too.
  const startupWheel = (jog, rate = 0x0e) => page.frame({ name: 'pendant' }).evaluate(({ jog, rate }) => {
    const bytes = Uint8Array.of(0, 0, 0, rate, 0x11, jog & 0xff, 0);
    const event = new Event('inputreport');
    Object.defineProperties(event, {
      reportId: { value: 0x04 },
      data: { value: new DataView(bytes.buffer) },
    });
    window.testHidDevice.dispatchEvent(event);
  }, { jog, rate });
  const stepWriteStart = writes.length;
  const axisMaxFeed = Number(pendant.settings.settings.$110).toFixed(3);
  await startupWheel(4);
  await expect.poll(() => Number(latestState.status?.mpos?.x)).toBe(10.04);
  await expect.poll(() => latestState.status.activeState).toBe('Idle');
  await expect(droFrame.getByTestId('axis-value-x')).toHaveText('10.0400');
  assert.equal(latestState.status.ov[0], 100, 'Startup Step must not adjust feed override');
  assert.ok(writes.slice(stepWriteStart).some(line => line.trim() === `$J=G21 G91 X0.0400 F${axisMaxFeed}`),
    'Step speed must use the selected axis maximum, not a pendant-only feed setting');
  const stepOverride = new Grbl(pendant);
  t.after(() => stepOverride.clearOverrides());
  assert.equal(stepOverride.overrideTarget('feed', 50), 'sent');
  await expect.poll(() => latestState.status.ov[0]).toBe(50);
  await expect.poll(() => stepOverride.pendingOverrides.size).toBe(0);
  const reducedOverrideWrites = writes.length;
  await startupWheel(-4);
  await expect.poll(() => Number(latestState.status?.mpos?.x)).toBe(10);
  await expect.poll(() => latestState.status.activeState).toBe('Idle');
  await expect(droFrame.getByTestId('axis-value-x')).toHaveText('10.0000');
  assert.ok(writes.slice(reducedOverrideWrites).some(line => line.trim() === `$J=G21 G91 X-0.0400 F${axisMaxFeed}`),
    'Program Feed % must not change LinuxCNC-style Step speed');
  assert.equal(stepOverride.overrideTarget('feed', 100), 'sent');
  await expect.poll(() => latestState.status.ov[0]).toBe(100);
  await expect.poll(() => stepOverride.pendingOverrides.size).toBe(0);
  // The printed .1 selector follows program units, not GRBL's $13 report units.
  // Reuse this server and HID receiver; every phase finishes before changing units.
  assert.equal(Number(pendant.settings.settings.$13), 0);
  const readProgramUnits = async units => {
    // CNCjs consumes routine [GC:] replies; use its native parser-state contract.
    socket.emit('command', 'SIMULATOR', 'gcode', '$G');
    await expect.poll(() => latestState.parserstate?.modal?.units).toBe(units);
    await expect.poll(() => pendant.state.parserstate?.modal?.units).toBe(units);
    await expect.poll(() => page.frame({ name: 'pendant' }).evaluate(() =>
      window.testControllerState?.parserstate?.modal?.units)).toBe(units);
  };
  for (const [units, scale, label, feedResolution] of [
    ['G20', 25.4, 'in', 0.000001], ['G21', 1, 'mm', 0.001],
  ]) {
    socket.emit('command', 'SIMULATOR', 'gcode', units);
    await readProgramUnits(units);
    await startupWheel(0, 0x0f);
    assert.equal(stepOverride.overrideTarget('feed', 50), 'sent');
    await expect.poll(() => latestState.status.ov[0]).toBe(50);
    await expect.poll(() => stepOverride.pendingOverrides.size).toBe(0);
    for (const direction of [1, -1]) {
      const unitStepStart = writes.length;
      await startupWheel(direction, 0x0f);
      await expect.poll(() => ({
        x: Number(latestState.status?.mpos?.x), state: latestState.status.activeState,
        units: latestState.parserstate?.modal?.units,
      })).toEqual({ x: direction === 1 ? 10 + 0.1 * scale : 10, state: 'Idle', units });
      const jogs = writes.slice(unitStepStart).map(line => line.trim()).filter(line => line.startsWith('$J='));
      assert.equal(jogs.length, 1, 'One .1 detent must produce one completed jog');
      const words = jogs[0].match(/^\$J=(G20|G21) G91 X(-?[\d.]+) F([\d.]+)$/);
      assert.ok(words, `Unexpected Step command: ${jogs[0]}`);
      assert.equal(words[1], units);
      assert.equal(Number(words[2]), direction * 0.1);
      const physicalFeed = Number(words[3]) * scale;
      assert.ok(physicalFeed <= Number(axisMaxFeed) && Number(axisMaxFeed) - physicalFeed < feedResolution * scale,
        `Step must use the axis maximum in ${label}/min despite 50% program feed: ${jogs[0]}`);
      assert.equal(latestState.status.ov[0], 50);
    }
    await expect(pendantFrame.locator('#mode')).toHaveText(`step (${label})`);
    await expect(pendantFrame.locator('#rd')).toHaveText(`0.1 ${label}`);
    await readProgramUnits(units);
  }
  await startupWheel(0);
  assert.equal(stepOverride.overrideTarget('feed', 100), 'sent');
  await expect.poll(() => latestState.status.ov[0]).toBe(100);
  await expect.poll(() => stepOverride.pendingOverrides.size).toBe(0);
  await expect(droFrame.getByTestId('axis-value-x')).toHaveText('10.0000');
  // Connected INC is CNCjs WPos; zeroing changes the work offset, not motion.
  await droFrame.getByRole('button', { name: 'Abs/Inc', exact: true }).click();
  await droFrame.getByRole('button', { name: 'Zero X axis', exact: true }).click();
  await expect(droFrame.getByTestId('axis-value-x')).toHaveText('0.0000');
  await expect.poll(() => Number(latestState.status.wpos.x)).toBe(0);
  assert.equal(Number(latestState.status.mpos.x), 10, 'EL400 INC zero must not move the machine');
  const incrementalJog = event(socket, 'controller:state', (_, state) => Number(state.status?.mpos?.x) === 15 && state.status.activeState === 'Idle');
  assert.equal(new Grbl(pendant).jog('X', 5, 750), 'sent');
  await incrementalJog;
  await expect(droFrame.getByTestId('axis-value-x')).toHaveText('5.0000');
  await droFrame.getByRole('button', { name: 'Abs/Inc', exact: true }).click();
  await expect(droFrame.getByTestId('axis-value-x')).toHaveText('15.0000');
  // Motion in ABS must also be reflected when returning to INC.
  const returnJog = event(socket, 'controller:state', (_, state) => Number(state.status?.mpos?.x) === 10 && state.status.activeState === 'Idle');
  assert.equal(new Grbl(pendant).jog('X', -5, 750), 'sent');
  await returnJog;
  await expect(droFrame.getByTestId('axis-value-x')).toHaveText('10.0000');
  await droFrame.getByRole('button', { name: 'Abs/Inc', exact: true }).click();
  await expect(droFrame.getByTestId('axis-value-x')).toHaveText('0.0000');
  await droFrame.getByRole('button', { name: 'Abs/Inc', exact: true }).click();
  await expect(droFrame.getByTestId('axis-value-x')).toHaveText('10.0000');
  // Restore the original physical work offset for the unchanged LCD/Step checks.
  socket.emit('command', 'SIMULATOR', 'gcode', 'G21 G10 L20 P1 X5');
  await expect.poll(() => Number(latestState.status.wpos.x)).toBe(5);
  await expect.poll(() => page.frame({ name: 'pendant' }).evaluate(() =>
    Number(window.testControllerState?.status?.wpos?.x))).toBe(5);
  // CNCjs already reports progress: ordinary queued jogs must not add console
  // status queries. Exercise the reported +7/-1 sequence against the real server.
  const nativeJog = new Grbl(pendant);
  t.after(() => nativeJog.clearJog());
  const queryStart = writes.length;
  assert.equal(nativeJog.jog('X', 7, 250), 'sent');
  assert.equal(nativeJog.jog('X', -1, 250), 'buffered');
  await expect.poll(() => Number(latestState.status?.mpos?.x)).toBe(16);
  await expect.poll(() => nativeJog.jogPhase).toBe('idle');
  await expect(droFrame.getByTestId('axis-value-x')).toHaveText('16.0000');
  assert.deepEqual(writes.slice(queryStart).filter(line => line.trim() === '?'), [],
    'Native CNCjs progress must complete a normal queued jog without pendant status polling');
  assert.equal(nativeJog.jog('X', -6, 750), 'sent');
  await expect.poll(() => Number(latestState.status?.mpos?.x)).toBe(10);
  await expect.poll(() => nativeJog.jogPhase).toBe('idle');
  await expect(droFrame.getByTestId('axis-value-x')).toHaveText('10.0000');
  const displayInches = event(socket, 'controller:state', (_, state) => state.parserstate?.modal?.units === 'G20');
  socket.emit('command', 'SIMULATOR', 'gcode', 'G20');
  await displayInches;
  // GRBL still reports millimetres ($13=0); the LCD must show 5/25.4 = 0.1969 in.
  await expect.poll(async () => (await lcdFrame())?.slice(4, 8)).toEqual([0, 0, 177, 7]);
  const displayMillimetres = event(socket, 'controller:state', (_, state) => state.parserstate?.modal?.units === 'G21');
  socket.emit('command', 'SIMULATOR', 'gcode', 'G21');
  await displayMillimetres;
  await expect.poll(async () => (await lcdFrame())?.slice(4, 8)).toEqual([5, 0, 0, 0]);
  const toggleLcdCoordinates = () => page.frame({ name: 'pendant' }).evaluate(() => {
    for (const key of [0x10, 0]) window.testPendant.dispatchEvent(new CustomEvent('use', {
      detail: { firstKeyCode: key, secondKeyCode: 0, leftDialCode: 0x11, rightDialCode: 0x0f, jog: 0 },
    }));
  });
  await toggleLcdCoordinates();
  await expect.poll(async () => (await lcdFrame())?.slice(3, 8)).toEqual([0x01, 10, 0, 0, 0]);
  await toggleLcdCoordinates();
  await expect.poll(async () => (await lcdFrame())?.slice(3, 8)).toEqual([0x81, 5, 0, 0, 0]);
  const hidEvent = type => page.frame({ name: 'pendant' }).evaluate(type => {
    const event = new Event(type);
    Object.defineProperty(event, 'device', { value: window.testHidDevice });
    window.testHid.dispatchEvent(event);
  }, type);
  await hidEvent('disconnect');
  await page.frame({ name: 'pendant' }).evaluate(() => { window.testLcdReports = []; });
  await toggleLcdCoordinates();
  await toggleLcdCoordinates();
  assert.equal(await page.frame({ name: 'pendant' }).evaluate(() => window.testLcdReports.length), 0,
    'Disconnected receiver must not receive even a partial LCD frame');
  await hidEvent('connect');
  await expect.poll(async () => (await lcdFrame())?.slice(3, 8)).toEqual([0x81, 5, 0, 0, 0]);
  assert.deepEqual(browserErrors, [], 'Mounted widgets must boot without browser errors');
  const widgetJogging = event(socket, 'controller:state', (_, state) => state.status?.activeState === 'Jog');
  assert.equal(new Grbl(pendant, undefined, message => t.diagnostic(message)).jog('X', 10, 50), 'sent');
  await widgetJogging;
  const widgetStopped = event(socket, 'controller:state', (_, state) => state.status?.activeState === 'Idle');
  await pendantFrame.locator('#log').evaluate(element => { element.textContent = ''; });
  await page.frame({ name: 'pendant' }).evaluate(() => {
    if (!window.testPendant) throw new Error('The widget did not register its pendant input handler');
    window.testPendant.dispatchEvent(new CustomEvent('use', { detail: { firstKeyCode: 0x02, secondKeyCode: 0, leftDialCode: 0x11, rightDialCode: 0x0f, jog: 0 } }));
  });
  await widgetStopped;
  await expect(pendantFrame.locator('#log')).toContainText('Stop completed.');
  assert.deepEqual(browserErrors, [], 'The actual widget Stop handler must work');
  const jogging = event(socket, 'controller:state', (_, state) => state.status?.activeState === 'Jog');
  const controls = new Grbl(pendant, undefined, message => t.diagnostic(message));
  assert.equal(controls.jog('X', 10, 50), 'sent');
  await jogging;
  const stopped = event(socket, 'controller:state', (_, state) => state.status?.activeState === 'Idle', 2000);
  controls.stop();
  const [, stoppedState] = await stopped;
  assert.ok(Number(stoppedState.status.mpos.x) < 20, 'Stop must cancel before the jog target');
  await expect.poll(() => pendant.stopPhase).toBe('idle');
  const idleReplies = [];
  const recordIdle = line => idleReplies.push(line);
  socket.on('serialport:read', recordIdle);
  controls.stop();
  await expect.poll(() => pendant.stopPhase).toBe('idle');
  socket.off('serialport:read', recordIdle);
  assert.ok(idleReplies.some(line => line.startsWith('<Idle|')));
  assert.ok(idleReplies.filter(line => line.startsWith('<')).every(line => line.startsWith('<Idle|')),
    'Stop at Idle must not put GRBL into Hold');
  assert.ok(idleReplies.every(line => !line.startsWith('Grbl ')), 'Stop at Idle must not reset the controller');
  t.diagnostic('Stop at Idle and Jog verified');
  const running = event(socket, 'controller:state', (_, state) => state.status?.activeState === 'Run');
  const loaded = event(socket, 'gcode:load');
  socket.emit('command', 'SIMULATOR', 'gcode:load', 'stop-regression.nc', 'G21 G91\nG1 X10 F50\nG1 X10 F50');
  await loaded;
  const workflowStarted = event(socket, 'workflow:state', state => state === 'running');
  socket.emit('command', 'SIMULATOR', 'gcode:start');
  await workflowStarted;
  await running;
  const reset = event(socket, 'serialport:read', line => line.startsWith('Grbl'), 3000);
  const cancelled = event(socket, 'controller:state', (_, state) => state.status?.activeState === 'Idle', 3000);
  const workflowStopped = event(socket, 'workflow:state', state => state === 'idle', 3000);
  controls.stop();
  await Promise.all([reset, cancelled, workflowStopped]).catch(error => { throw new Error(`${error.message}; recent GRBL replies: ${JSON.stringify(serialTrace)}; server: ${output}`); });
  await expect.poll(() => pendant.stopPhase).toBe('idle');
  pendant.command('cyclestart');
  // Confirm twice to exclude one status reply already in flight before Start.
  for (let report = 0; report < 2; report++) {
    const afterStart = event(socket, 'serialport:read', line => line.startsWith('<'), 2000);
    pendant.command('statusreport');
    assert.match((await afterStart)[0], /^<Idle\|/, 'Start must not resume the canceled program');
    assert.equal(workflowState, 'idle', 'Start must not restart the stopped sender');
  }
  // GRBL reports Idle while dwelling, even though later program moves are buffered.
  const dwellLoaded = event(socket, 'gcode:load');
  socket.emit('command', 'SIMULATOR', 'gcode:load', 'dwell-stop.nc', 'G4 P2\nG91 G1 X10 F50');
  await dwellLoaded;
  const dwellSent = event(socket, 'sender:status', state => state.name === 'dwell-stop.nc' && state.sent > 0);
  socket.emit('command', 'SIMULATOR', 'gcode:start');
  await dwellSent;
  const dwellReset = event(socket, 'serialport:read', line => line.startsWith('Grbl'), 3000);
  const dwellWorkflowStopped = event(socket, 'workflow:state', state => state === 'idle', 3000);
  controls.stop();
  await Promise.all([dwellReset, dwellWorkflowStopped]);
  await expect.poll(() => pendant.stopPhase).toBe('idle');
  pendant.command('cyclestart');
  for (let report = 0; report < 2; report++) {
    const afterDwellStart = event(socket, 'serialport:read', line => line.startsWith('<'), 2000);
    pendant.command('statusreport');
    assert.match((await afterDwellStart)[0], /^<Idle\|/, 'Start must not resume a program canceled during dwell');
    assert.equal(workflowState, 'idle', 'Start must not restart the sender after dwell cancellation');
  }
  // CNCjs's feeder sends one line per acknowledgment, unlike its program sender.
  // Stop must remove the move still queued behind this MDI dwell.
  const mdiDwellSent = event(socket, 'serialport:write', line => line.replace(/\s/g, '').includes('G4P1'));
  socket.emit('command', 'SIMULATOR', 'gcode', 'G4 P1\nG91 G1 X10 F50');
  await mdiDwellSent;
  controls.stop();
  await expect.poll(() => pendant.stopPhase).toBe('idle');
  // Observing G20 establishes that GRBL processed commands after the dwell.
  const mdiDrained = event(socket, 'controller:state', (_, state) => state.parserstate?.modal?.units === 'G20');
  pendant.command('gcode', 'G20');
  await mdiDrained;
  for (let report = 0; report < 2; report++) {
    const mdiStatus = event(socket, 'serialport:read', line => line.startsWith('<'), 2000);
    pendant.command('statusreport');
    assert.match((await mdiStatus)[0], /^<Idle\|/, 'The queued MDI move must not run after Stop');
  }
  // A dwell reports Idle while CNCjs still owns unsent feeder commands.
  // Out-and-back jogs must remain cancellable until they actually reach GRBL.
  const queuedJog = new Grbl(pendant, undefined, message => t.diagnostic(message));
  t.after(() => queuedJog.clearJog());
  assert.equal(pendant.replyTracking, 'synchronized', 'Earlier Stop reset must establish acknowledgement tracking');
  const queuedDwell = event(socket, 'serialport:write', line => line.includes('G4 P5'));
  pendant.command('gcode', ['G4 P5', 'G4 P0']);
  await queuedDwell;
  const writeStart = writes.length;
  assert.equal(queuedJog.jog('X', 0.04, 250), 'sent');
  // The pendant holds later Steps until GRBL acknowledges the first.
  assert.equal(queuedJog.jog('X', -0.04, 250), 'buffered');
  const issuedSequence = pendant.reportSequence;
  // Another client may explicitly request Idle while the jog is still queued.
  // Native CNCjs suppresses unchanged frames; the pendant no longer polls here.
  for (let report = 0; report < 2; report++) {
    const status = event(socket, 'serialport:read', line => line.startsWith('<'), 2000);
    socket.emit('command', 'SIMULATOR', 'statusreport');
    assert.match((await status)[0], /^<Idle\|/);
  }
  await Promise.all([
    expect.poll(() => pendant.reportSequence, { intervals: [50], timeout: 2000 }).toBeGreaterThanOrEqual(issuedSequence + 2),
    expect.poll(() => feederState?.queue, { intervals: [50], timeout: 2000 }).toBeGreaterThanOrEqual(2),
  ]);
  assert.ok(!writes.slice(writeStart).some(line => line.startsWith('$J=')), 'Regression setup must leave the jog queued behind the dwell');
  assert.equal(queuedJog.jogCompleted(), false, 'Idle before queued jog acknowledgements must not complete the jog');
  const cancelWrite = event(socket, 'serialport:write', line => line.includes('\x85'));
  queuedJog.cancelJog();
  await cancelWrite;
  await expect.poll(() => queuedJog.jogPhase).toBe('idle');
  // A subsequent acknowledged modal command proves the dwell/feeder drained.
  const queuedDrained = event(socket, 'controller:state', (_, state) => state.parserstate?.modal?.units === 'G21');
  pendant.command('gcode', 'G21');
  await queuedDrained;
  // Socket.IO clients receive modal broadcasts independently.
  await expect.poll(() => pendant.state.parserstate?.modal?.units).toBe('G21');
  assert.ok(!writes.slice(writeStart).some(line => line.startsWith('$J=')), 'Canceled queued jogs must never be sent');
  const completedWrites = writes.length;
  assert.equal(queuedJog.jog('X', 0.04, 250), 'sent');
  assert.equal(queuedJog.jog('X', -0.04, 250), 'buffered');
  await expect.poll(() => queuedJog.jogPhase).toBe('idle');
  assert.deepEqual(writes.slice(completedWrites).filter(line => line.startsWith('$J=')).map(line => line.trim()),
    ['$J=G21 G91 X0.0400 F250.000', '$J=G21 G91 X-0.0400 F250.000'],
    'An acknowledged out-and-back pair must finish without leaving the pendant locked');
  // A widget joining an open controller cannot correlate pre-join replies.
  // Keep its cancellation armed without polling forever or deleting later MDI work.
  const lateSession = new CncjsSession({ io, origin: base });
  t.after(() => lateSession.disconnect());
  lateSession.connect(token);
  await expect.poll(() => lateSession.status.phase).toBe('joined');
  await expect.poll(() => lateSession.state.parserstate?.modal?.units).toBe('G21');
  const uncertainJog = new Grbl(lateSession, undefined, message => t.diagnostic(message));
  t.after(() => uncertainJog.clearJog());
  assert.equal(uncertainJog.jog('X', 0.001, 250), 'sent');
  await expect.poll(() => uncertainJog.jogReceipt?.state).toBe('uncertain');
  await expect.poll(() => uncertainJog.jogTimer).toBe(null);
  assert.equal(uncertainJog.jogPhase, 'armed', 'Ambiguous motion must retain cancellation ownership');
  assert.equal(uncertainJog.jogCompleted(), false, 'Unknown history must not manufacture completion');
  const laterDwell = event(socket, 'serialport:write', line => line.includes('G4 P1'));
  pendant.command('gcode', ['G4 P1', 'G20']);
  await laterDwell;
  const laterMacro = event(socket, 'controller:state', (_, state) => state.parserstate?.modal?.units === 'G20');
  const passiveCancel = event(socket, 'serialport:write', line => line.includes('\x85'));
  uncertainJog.cancelJog();
  await Promise.all([laterMacro, passiveCancel]);
  await expect.poll(() => uncertainJog.jogPhase).toBe('idle');
  lateSession.disconnect();
  const restoredUnits = event(socket, 'controller:state', (_, state) => state.parserstate?.modal?.units === 'G21');
  pendant.command('gcode', 'G21');
  await restoredUnits;
  // Exercise the mounted widget, real CNCjs directives, and GRBL parser together.
  // Input reports replace USB only; command routing and machine replies are real.
  const report = async detail => {
    await page.frame({ name: 'pendant' }).evaluate(detail => {
      window.testPendant.dispatchEvent(new CustomEvent('use', { detail }));
    }, { firstKeyCode: 0, secondKeyCode: 0, leftDialCode: 0x11, rightDialCode: 0x0f, jog: 0, ...detail });
  };
  const press = async (code, modifier = 0, rightDialCode = 0x0f) => {
    const expectedParser = structuredClone(latestState.parserstate);
    await expect.poll(() => page.frame({ name: 'pendant' }).evaluate(() => window.testControllerState?.parserstate))
      .toEqual(expectedParser);
    await report({ firstKeyCode: code, secondKeyCode: modifier, rightDialCode });
    await report({ rightDialCode });
  };
  const getPosition = () => ['x', 'y', 'z'].map(axis => Number(latestState.status.mpos[axis]));
  const stationary = getPosition();
  await pendantFrame.getByText('Pendant settings', { exact: true }).click();
  await pendantFrame.locator('#thickness').fill('');
  await press(0x0d);
  await expect(pendantFrame.locator('#log')).toContainText('Enter a valid nonnegative probe plate thickness.');
  assert.deepEqual(getPosition(), stationary, 'A blank probe thickness must not start a probe');
  // Leaving Lead selects MPG; startup now selects Step instead.
  await report({ rightDialCode: 0x9b });
  await report({ rightDialCode: 0x1b });
  await expect.poll(() => latestState.status.ov?.[0]).toBe(100);
  await report({ rightDialCode: 0x1b, jog: -2 });
  await expect.poll(() => latestState.status.ov?.[0]).toBe(98);
  await report({ rightDialCode: 0x9b, jog: 3 });
  await expect.poll(() => latestState.status.ov?.[2]).toBe(103);
  assert.deepEqual(getPosition(), stationary, 'Lead must adjust spindle override without jogging');
  await report({ rightDialCode: 0x1b });
  await expect.poll(() => latestState.status.ov?.[0]).toBe(100);
  await report({ rightDialCode: 0x1b, jog: -2 });
  await expect.poll(() => latestState.status.ov?.[0]).toBe(98);
  assert.deepEqual(getPosition(), stationary, 'Returning from Lead must select MPG feed override');
  await press(0x04, 0, 0x1b);
  await expect.poll(() => latestState.status.ov?.[0]).toBe(99);

  const spindlePrepared = event(socket, 'controller:state', (_, state) => Number(state.parserstate?.spindle) === 500);
  pendant.command('gcode', 'S500');
  await spindlePrepared;
  await press(0x0b, 0, 0x1b);
  await expect.poll(() => latestState.parserstate?.modal?.spindle).toBe('M3').catch(async error => {
    t.diagnostic(JSON.stringify(await page.frame({ name: 'pendant' }).evaluate(() => ({
      controller: window.testControllerState,
      log: document.querySelector('#log').textContent,
    }))));
    throw error;
  });
  await expect.poll(() => Number(latestState.status.spindle)).toBe(515);
  await press(0x07, 0, 0x1b);
  await expect.poll(() => latestState.status.ov?.[2]).toBe(102);
  await expect.poll(() => Number(latestState.status.spindle)).toBe(510);
  await expect.poll(async () => (await lcdFrame())?.slice(16, 20)).toEqual([99, 0, 102, 0]);
  await press(0x0b, 0, 0x1b);
  await expect.poll(() => latestState.parserstate?.modal?.spindle).toBe('M5');
  await press(0x06, 0x0c, 0x1b); // Fn + Spindle+: programmed RPM.
  await expect.poll(() => Number(latestState.parserstate?.spindle)).toBe(600);
  await press(0x0b, 0x0c, 0x1b); // Fn + spindle: next start direction.
  await press(0x0b, 0, 0x1b);
  await expect.poll(() => latestState.parserstate?.modal?.spindle).toBe('M4');
  await press(0x0b, 0, 0x1b);
  await expect.poll(() => latestState.parserstate?.modal?.spindle).toBe('M5');
  await press(0x0e, 0x0c, 0x1b); // Fn + Continuous: flood coolant.
  await expect.poll(() => latestState.parserstate?.modal?.coolant).toBe('M8');
  await press(0x0f, 0x0c, 0x1b); // Fn + Step: mist coolant.
  await expect.poll(() => latestState.parserstate?.modal?.coolant).toEqual(['M7', 'M8']);
  await press(0x0e, 0x0c, 0x1b);
  await expect.poll(() => latestState.parserstate?.modal?.coolant).toBe('M7');
  await press(0x0f, 0x0c, 0x1b);
  await expect.poll(() => latestState.parserstate?.modal?.coolant).toBe('M9');

  await press(0x0f, 0, 0x0e); // Step, 0.01 mm per detent.
  await expect.poll(async () => (await lcdFrame())?.[3]).toBe(0x81);
  await report({ rightDialCode: 0x0e, jog: 4 });
  await expect.poll(() => Number(latestState.status.mpos.x)).toBeCloseTo(stationary[0] + 0.04, 3);
  await expect.poll(() => latestState.status.activeState).toBe('Idle');
  // CNCjs's automatic status broadcasts must suffice; the test sends no extra
  // raw status requests to make the pendant's cancellation guard recover.
  await report({ leftDialCode: 0x12, rightDialCode: 0x0e, jog: 4 });
  await expect.poll(() => Number(latestState.status.mpos.y)).toBeCloseTo(stationary[1] + 0.04, 3);
  await expect.poll(() => latestState.status.activeState).toBe('Idle');
  const stepped = getPosition();
  await press(0x0e, 0, 0x0d); // Continuous at 2% of the controller maximum.
  const beforeContinuous = writes.length;
  await report({ rightDialCode: 0x0d, jog: 1 });
  // A short jog can finish between CNCjs status polls; verify actual travel.
  await expect.poll(() => Number(latestState.status.mpos.x)).toBeGreaterThan(stepped[0]).catch(async error => {
    throw new Error(`${error.message}; pendant log: ${await pendantFrame.locator('#log').textContent()}; recent status: ${JSON.stringify(serialTrace)}`);
  });
  await expect.poll(() => latestState.status.activeState).toBe('Idle');
  await expect.poll(() => writes.slice(beforeContinuous).some(line => line.includes('\x85'))).toBe(true);
  assert.ok(writes.slice(beforeContinuous).some(line => /\$J=.*F60(?:\.000)?\b/.test(line)), 'Continuous must use 2% of the X maximum, 60 mm/min');
  const continuousDistance = Number(latestState.status.mpos.x) - stepped[0];
  assert.ok(continuousDistance > 0 && continuousDistance < 1, `Continuous jog must stop after wheel inactivity, moved ${continuousDistance} mm`);
  await expect(pendantFrame.locator('#log')).toContainText('GRBL override minimum is 10%');
  await expect.poll(() => latestState.status.ov?.[0], { timeout: 10000 }).toBe(10);
  const beforeUnsupportedAxis = writes.length;
  const beforeUnsupportedPosition = getPosition();
  await report({ leftDialCode: 0x14, rightDialCode: 0x0d, jog: 5 });
  await expect(pendantFrame.locator('#log')).toContainText('GRBL supports XYZ; A/B/C wheel input ignored.');
  await expect.poll(lcdFrame).toEqual([0xfe, 0xfd, 0xfe, 0x40, ...Array(17).fill(0)]);
  for (let confirmation = 0; confirmation < 2; confirmation++) {
    const status = event(socket, 'serialport:read', line => line.startsWith('<'));
    pendant.command('statusreport');
    await status;
  }
  assert.ok(writes.slice(beforeUnsupportedAxis).every(line => !line.includes('$J=')), 'Unsupported axes must not emit a jog command');
  assert.deepEqual(getPosition(), beforeUnsupportedPosition, 'The A selector must not move a vanilla three-axis GRBL machine');

  // Start/Pause must also update CNCjs's sender, so resume sends pending lines.
  const pauseLoaded = event(socket, 'gcode:load');
  socket.emit('command', 'SIMULATOR', 'gcode:load', 'pause-resume.nc', ['G21 G91', ...Array(80).fill('G1 X0.5 F300')].join('\n'));
  await pauseLoaded;
  await press(0x03, 0, 0x0d);
  await expect.poll(() => workflowState).toBe('running');
  await expect.poll(() => latestState.status.activeState).toBe('Run');
  await press(0x03, 0, 0x0d);
  await expect.poll(() => workflowState).toBe('paused');
  await expect.poll(() => latestState.status.activeState).toBe('Hold');
  const sentBeforeResume = senderState.sent;
  assert.ok(sentBeforeResume < senderState.total, 'The test program must leave unsent lines in CNCjs');
  await press(0x03, 0, 0x0d);
  await expect.poll(() => workflowState).toBe('running');
  await expect.poll(() => latestState.status.activeState).toBe('Run');
  await expect.poll(() => senderState.sent).toBeGreaterThan(sentBeforeResume);
  await pendantFrame.locator('#log').evaluate(element => { element.textContent = ''; });
  await press(0x02, 0, 0x0d);
  await expect.poll(() => workflowState).toBe('idle');
  await expect.poll(() => latestState.status.activeState).toBe('Idle');
  await expect(pendantFrame.locator('#log')).toContainText('Stop completed.');
  assert.deepEqual(browserErrors, [], 'LinuxCNC-style pendant controls must run without browser errors');
  const portClosed = event(socket, 'serialport:close');
  socket.emit('close', 'SIMULATOR');
  await portClosed;
  await expect(pendantFrame.locator('#sockPill')).not.toHaveText('joined');
  await expect.poll(lcdFrame).toEqual([0xfe, 0xfd, 0xfe, 0x40, ...Array(17).fill(0)]);
  socket.disconnect();
}

test('real CNCjs motion, unit-aware steps and stop safety', { timeout: 90000 }, async t => {
  await withRealWidgets(t, 'motion');
});

test('real CNCjs autosaved controls and bidirectional display units', { timeout: 90000 }, async t => {
  await withRealWidgets(t, 'controls');
});

async function exerciseControls({ page, pendantFrame, socket, writes, macroApi, savedMacro,
  base, browserErrors, state }) {
  const macroButton = (key, modifier = 0) => page.frame({ name: 'pendant' }).evaluate(({ key, modifier }) => {
    for (const pressed of [key, 0]) window.testPendant.dispatchEvent(new CustomEvent('use', {
      detail: { firstKeyCode: pressed ? modifier || key : 0, secondKeyCode: pressed && modifier ? key : 0,
        leftDialCode: 0x11, rightDialCode: 0x0f, jog: 0 },
    }));
  }, { key, modifier });
  const storedMacros = () => page.frame({ name: 'pendant' }).evaluate(() =>
    JSON.parse(localStorage.getItem('whb04b-controls')).macros);
  const reloadPendant = async () => {
    await page.frame({ name: 'pendant' }).evaluate(() => location.reload());
    await expect(pendantFrame.locator('#sockPill')).toHaveText('joined');
    await expect.poll(() => page.frame({ name: 'pendant' }).evaluate(() => Boolean(window.testPendant))).toBe(true);
    await pendantFrame.getByText('Macro buttons', { exact: true }).click();
  };
  await expect(pendantFrame.locator('#saveConfig')).toHaveCount(0);
  for (const pill of ['sockPill', 'tokenPill', 'portPill']) await expect(pendantFrame.locator(`#${pill}`)).toBeHidden();
  await expect(pendantFrame.locator('#hidPill')).toBeVisible();
  const help = pendantFrame.getByRole('button', { name: 'Mode help', exact: true });
  await help.hover();
  await expect(pendantFrame.locator('#modeHelp')).toBeVisible();
  await help.click();
  await expect(help).toHaveAttribute('aria-expanded', 'true');
  await help.press('Escape');
  await expect(pendantFrame.locator('#modeHelp')).toBeHidden();
  await help.blur();
  await help.focus();
  await expect(pendantFrame.locator('#modeHelp')).toBeVisible();
  await help.press('Escape');
  await expect(pendantFrame.locator('#modeHelp')).toBeHidden();
  await expect(pendantFrame.locator('#reconnectSock')).toBeHidden();
  await pendantFrame.getByText('Diagnostics', { exact: true }).click();
  await expect(pendantFrame.locator('#reconnectSock')).toBeVisible();
  await pendantFrame.getByText('Diagnostics', { exact: true }).click();
  await pendantFrame.getByText('Pendant settings', { exact: true }).click();
  await pendantFrame.locator('#spindleIncrement').fill('125');
  await pendantFrame.locator('#largeSteps').selectOption('enabled');
  await expect(pendantFrame.locator('#settingsStatus')).toHaveAttribute('data-state', 'saved');
  await page.frame({ name: 'pendant' }).evaluate(() => location.reload());
  await expect(pendantFrame.locator('#sockPill')).toHaveText('joined');
  await pendantFrame.getByText('Pendant settings', { exact: true }).click();
  await expect(pendantFrame.locator('#spindleIncrement')).toHaveValue('125');
  await expect(pendantFrame.locator('#largeSteps')).toHaveValue('enabled');
  await pendantFrame.locator('#largeSteps').selectOption('disabled');
  await pendantFrame.getByText('Pendant settings', { exact: true }).click();
  await pendantFrame.getByText('Macro buttons', { exact: true }).click();
  await expect(pendantFrame.locator('#thickness')).not.toBeVisible();
  await expect(pendantFrame.locator('.macro-assignment')).toHaveCount(0);
  const unusedMacroButton = pendantFrame.getByRole('combobox', { name: 'Unused Fn combination', exact: true });
  await expect(unusedMacroButton.locator('option[value="1"]')).toHaveCount(1);
  assert.deepEqual(await unusedMacroButton.locator('option').evaluateAll(options =>
    options.filter(option => option.value).map(option => Number(option.value))), [1, 2, 5, 6, 7, 9, 11, 12, 13, 14],
  'Human-readable macro labels must preserve existing noncontiguous stored identifiers');
  await unusedMacroButton.selectOption('1');
  await pendantFrame.getByRole('button', { name: 'Add macro button', exact: true }).click();
  await expect(pendantFrame.locator('.macro-assignment')).toHaveCount(1);
  await expect(unusedMacroButton.locator('option[value="1"]')).toHaveCount(0);
  const assignment = pendantFrame.getByRole('combobox', { name: 'Assignment for Macro-1 (Fn+Feed+)', exact: true });
  await expect(assignment).toHaveValue('disabled');
  await expect.poll(storedMacros).toEqual({ 1: { source: 'disabled' } });
  await reloadPendant();
  await expect(assignment).toHaveValue('disabled');
  const disabledStart = writes.length;
  await macroButton(0x04, 0x0c);
  await expect(pendantFrame.locator('#log')).toContainText('Macro-1 (Fn+Feed+) is disabled.');
  assert.deepEqual(writes.slice(disabledStart).map(line => line.trim()).filter(line => !['$G', '$$', '?'].includes(line)), [],
    'A newly added disabled mapping must not execute any machine command');
  await expect(assignment.locator('option', { hasText: 'Pendant units' })).toHaveCount(1);
  await assignment.selectOption(`cncjs:${savedMacro.id}`);
  await expect(pendantFrame.locator('#settingsStatus')).toHaveAttribute('data-state', 'saved');
  await reloadPendant();
  await expect(pendantFrame.locator('.macro-assignment')).toHaveCount(1);
  await expect(assignment).toHaveValue(`cncjs:${savedMacro.id}`);
  await pendantFrame.getByText('Default button reference', { exact: true }).click();
  await expect(pendantFrame.locator('#buttonReference input, #buttonReference select, #buttonReference textarea')).toHaveCount(0);
  await pendantFrame.getByText('Default button reference', { exact: true }).click();
  await macroButton(0x04, 0x0c);
  await expect.poll(() => state().parserstate?.modal?.units).toBe('G20');
  await macroApi(`/${savedMacro.id}`, 'PUT', { name: 'Updated units', content: '%units=21\nG[units]' });
  // CNCjs configstore uses fs.watchFile's ~5 s polling interval.
  await expect(assignment.locator('option', { hasText: 'Updated units' })).toHaveCount(1, { timeout: 12000 });
  await macroButton(0x04, 0x0c);
  await expect.poll(() => state().parserstate?.modal?.units).toBe('G21');
  await unusedMacroButton.selectOption('2');
  await pendantFrame.getByRole('button', { name: 'Add macro button', exact: true }).click();
  await expect(pendantFrame.locator('.macro-assignment')).toHaveCount(2);
  const customAssignment = pendantFrame.getByRole('combobox', { name: 'Assignment for Macro-2 (Fn+Feed-)', exact: true });
  await customAssignment.selectOption('custom');
  const customCode = pendantFrame.getByRole('textbox', { name: 'G-code for Macro-2 (Fn+Feed-)', exact: true });
  await customCode.fill('G20\nG21');
  await pendantFrame.getByRole('button', { name: 'Refresh CNCjs macros' }).click();
  await expect(pendantFrame.locator('#macroStatus')).toContainText('available');
  await expect(customCode).toHaveValue('G20\nG21');
  await expect(pendantFrame.locator('#settingsStatus')).toHaveAttribute('data-state', 'saved');
  const validMacros = await storedMacros();
  await customCode.fill('');
  await expect(pendantFrame.locator('#settingsStatus')).toHaveAttribute('data-state', 'error');
  assert.deepEqual(await storedMacros(), validMacros, 'Invalid drafts must not replace the saved assignment');
  await reloadPendant();
  await expect(customAssignment).toHaveValue('custom');
  await expect(customCode).toHaveValue('G20\nG21');
  await expect(assignment).toHaveValue(`cncjs:${savedMacro.id}`);
  // Start in a distinct mode so the final G21 proves the custom macro drained.
  const customBaseline = event(socket, 'controller:state', (_, state) => state.parserstate?.modal?.units === 'G20');
  socket.emit('command', 'SIMULATOR', 'gcode', 'G20');
  await customBaseline;
  const customWrites = writes.length;
  const customCompleted = event(socket, 'controller:state', (_, state) => state.parserstate?.modal?.units === 'G21');
  await macroButton(0x05, 0x0c);
  await expect.poll(() => writes.slice(customWrites).map(line => line.trim()).filter(line => ['G20', 'G21'].includes(line)))
    .toEqual(['G20', 'G21']);
  await customCompleted;
  // A response arriving after Stop must never turn into delayed macro execution.
  await macroApi(`/${savedMacro.id}`, 'PUT', { content: 'G20' });
  let releaseRead;
  const readGate = new Promise(resolve => { releaseRead = resolve; });
  const macroUrl = `${base}/api/macros/${savedMacro.id}`;
  await page.route(macroUrl, async route => { await readGate; await route.continue(); });
  try {
    const waitingRead = page.waitForRequest(macroUrl, { timeout: 5000 });
    await macroButton(0x04, 0x0c);
    await waitingRead;
    await pendantFrame.locator('#log').evaluate(element => { element.textContent = ''; });
    await macroButton(0x02);
    releaseRead();
    await expect(pendantFrame.locator('#log')).toContainText('Saved macro request canceled.');
    await expect(pendantFrame.locator('#log')).toContainText('Stop completed.');
    assert.equal(state().parserstate?.modal?.units, 'G21');
  } finally { releaseRead(); await page.unroute(macroUrl); }
  await macroApi(`/${savedMacro.id}`, 'PUT', { content: 'G0 X[xmin]' });
  await expect(pendantFrame.locator('#macro-1-note')).toContainText('uses xmin', { timeout: 12000 });
  await macroButton(0x04, 0x0c);
  await expect(pendantFrame.locator('#log')).toContainText('uses xmin');
  await macroApi(`/${savedMacro.id}`, 'DELETE');
  await expect(assignment.locator('option:checked')).toContainText(/unavailable/i, { timeout: 12000 });
  await macroButton(0x04, 0x0c);
  await expect(pendantFrame.locator('#log')).toContainText('no longer exists');
  await page.route(`${base}/api/macros`, route => route.fulfill({ status: 401, body: '{}' }));
  await pendantFrame.getByRole('button', { name: 'Refresh CNCjs macros' }).click();
  await expect(pendantFrame.locator('#macroStatus')).toContainText('HTTP 401');
  await expect(assignment).toHaveValue(`cncjs:${savedMacro.id}`);
  await page.unroute(`${base}/api/macros`);
  await pendantFrame.getByRole('button', { name: 'Refresh CNCjs macros' }).click();
  await pendantFrame.getByRole('button', { name: 'Remove macro for Macro-1 (Fn+Feed+)', exact: true }).click();
  await expect(assignment).toHaveCount(0);
  await expect(customAssignment).toHaveValue('custom');
  await pendantFrame.getByRole('button', { name: 'Remove macro for Macro-2 (Fn+Feed-)', exact: true }).click();
  await expect(pendantFrame.locator('.macro-assignment')).toHaveCount(0);
  assert.deepEqual(await page.frame({ name: 'pendant' }).evaluate(() =>
    JSON.parse(localStorage.getItem('whb04b-controls')).macros), {});
  await reloadPendant();
  await expect(pendantFrame.locator('.macro-assignment')).toHaveCount(0);
  assert.deepEqual(await storedMacros(), {});
  const removedStart = writes.length;
  await macroButton(0x04, 0x0c);
  await expect(pendantFrame.locator('#log')).toContainText('Macro-1 (Fn+Feed+) is not configured.');
  assert.deepEqual(writes.slice(removedStart).map(line => line.trim()).filter(line => !['$G', '$$', '?'].includes(line)), []);
  assert.deepEqual(browserErrors, [], 'Autosaved controls must run without browser exceptions');
}

async function exerciseUnitSync({ page, pendantFrame, droFrame, socket, writes, pendant, Grbl, state }) {
  const unitWrites = start => writes.slice(start).map(line => line.trim()).filter(line => /^(G20|G21)$/.test(line));
  const position = () => ['x', 'y', 'z'].map(axis => Number(state().status.mpos[axis]));
  const confirmed = async (units, readout) => {
    await expect.poll(() => state().parserstate?.modal?.units).toBe(units);
    await expect.poll(() => pendant.state.parserstate?.modal?.units).toBe(units);
    await expect.poll(() => page.frame({ name: 'pendant' }).evaluate(() =>
      window.testControllerState?.parserstate?.modal?.units)).toBe(units);
    await expect(droFrame.getByTestId('axis-value-x')).toHaveText(readout);
    await expect(pendantFrame.locator('#mode')).toHaveText(`step (${units === 'G20' ? 'in' : 'mm'})`);
    await expect(pendantFrame.locator('#largeStepsLabel')).toHaveText(
      units === 'G20' ? '5/10 in steps (127/254 mm)' : '5/10 mm steps');
    // Cross two real controller replies before counting writes, including any
    // echo caused by observing the first confirmation.
    for (let report = 0; report < 2; report++) {
      const replied = event(socket, 'serialport:read', line => line.startsWith('<'));
      socket.emit('command', 'SIMULATOR', 'statusreport');
      await replied;
    }
  };
  const stationary = position();
  for (const [units, readout] of [['G20', '0.1969'], ['G21', '5.0000']]) {
    const start = writes.length;
    await droFrame.getByTestId('btn-toggle-unit').click();
    await confirmed(units, readout);
    assert.deepEqual(unitWrites(start), [units], 'EL400 must request one native unit change without echo');
    assert.deepEqual(position(), stationary, 'Changing program units must not move the machine');
  }
  for (const [units, readout] of [['G20', '0.1969'], ['G21', '5.0000']]) {
    const start = writes.length;
    socket.emit('command', 'SIMULATOR', 'gcode', units);
    await confirmed(units, readout);
    assert.deepEqual(unitWrites(start), [units], 'External CNCjs units must update EL400 without writing back');
  }
  assert.equal(Number(pendant.settings.settings.$13), 0, 'Program inch mode must not change physical report units');
  await droFrame.getByRole('button', { name: 'Abs/Inc', exact: true }).click();
  await droFrame.getByRole('button', { name: 'Zero X axis', exact: true }).click();
  await expect(droFrame.getByTestId('axis-value-x')).toHaveText('0.0000');
  await expect.poll(() => Number(state().status.wpos.x)).toBe(0);
  assert.equal(position()[0], 5);
  const motion = new Grbl(pendant);
  assert.equal(motion.jog('X', 5, 750), 'sent');
  await expect.poll(() => ({ x: position()[0], phase: state().status.activeState })).toEqual({ x: 10, phase: 'Idle' });
  await expect.poll(() => Number(state().status.wpos.x)).toBe(5);
  await expect(droFrame.getByTestId('axis-value-x')).toHaveText('5.0000');
  // Controller report units stay millimetres while the display is inches. Both
  // toggle directions and an external change must preserve the physical datum.
  await droFrame.getByTestId('btn-toggle-unit').click();
  await confirmed('G20', '0.1969');
  await droFrame.getByTestId('btn-toggle-unit').click();
  await confirmed('G21', '5.0000');
  socket.emit('command', 'SIMULATOR', 'gcode', 'G20');
  await confirmed('G20', '0.1969');
  await droFrame.getByRole('button', { name: 'Abs/Inc', exact: true }).click();
  await expect(droFrame.getByTestId('axis-value-x')).toHaveText('0.3937');
  socket.emit('command', 'SIMULATOR', 'gcode', 'G21');
  await confirmed('G21', '10.0000');
  await droFrame.getByRole('button', { name: 'Abs/Inc', exact: true }).click();
  await expect(droFrame.getByTestId('axis-value-x')).toHaveText('5.0000');
  const offsetStart = writes.length;
  socket.emit('command', 'SIMULATOR', 'gcode', 'G21 G10 L20 P1 X2.54');
  await expect.poll(() => Number(state().status.wpos.x)).toBe(2.54);
  await expect(droFrame.getByTestId('axis-value-x')).toHaveText('2.5400');
  assert.equal(position()[0], 10, 'External work-offset changes must not move MPos');
  assert.deepEqual(writes.slice(offsetStart).map(line => line.trim()).filter(line => line.includes('G10')),
    ['G21 G10 L20 P1 X2.54'], 'Observing a new WPos must not echo the work-offset command');
  socket.emit('command', 'SIMULATOR', 'gcode', 'G20');
  await confirmed('G20', '0.1000');
  const zeroStart = writes.length;
  await droFrame.getByRole('button', { name: 'Zero X axis', exact: true }).click();
  await expect.poll(() => Number(state().status.wpos.x)).toBe(0);
  await expect(droFrame.getByTestId('axis-value-x')).toHaveText('0.0000');
  assert.equal(position()[0], 10, 'EL400 inch-mode zero must change WPos without motion');
  const zeroCommands = writes.slice(zeroStart).map(line => line.trim()).filter(line => line.includes('G10'));
  assert.equal(zeroCommands.length, 1, 'One INC zero must request exactly one work-offset change');
  assert.match(zeroCommands[0], /\bG10\b/);
  const preset = async keys => {
    await droFrame.getByTestId('axis-select-x').click();
    for (const key of keys) await droFrame.getByTestId(`key-${key}`).click();
    await droFrame.getByTestId('key-enter').click();
  };
  const inchPresetStart = writes.length;
  await preset(['0', 'decimal', '1']);
  await expect.poll(() => Number(state().status.wpos.x)).toBe(2.54);
  await expect(droFrame.getByTestId('axis-value-x')).toHaveText('0.1000');
  assert.equal(position()[0], 10, 'A 0.1-inch INC preset must set WPos to 2.54 mm, not move the machine');
  assert.equal(writes.slice(inchPresetStart).filter(line => line.includes('G10')).length, 1,
    'One preset must issue one G10, without echo or duplicate conversion');
  socket.emit('command', 'SIMULATOR', 'gcode', 'G21');
  await confirmed('G21', '2.5400');
  await preset(['3', 'decimal', '2', '5']);
  await expect.poll(() => Number(state().status.wpos.x)).toBe(3.25);
  await expect(droFrame.getByTestId('axis-value-x')).toHaveText('3.2500');
  assert.equal(position()[0], 10, 'Millimetre INC preset must preserve MPos');
  const jogging = event(socket, 'controller:state', (_, value) => value.status?.activeState === 'Jog');
  assert.equal(motion.jog('X', 10, 50), 'sent');
  await jogging;
  const busyStart = writes.length;
  await droFrame.getByTestId('btn-toggle-unit').click();
  await expect(droFrame.getByTestId('controller-unit-status')).toBeVisible();
  assert.deepEqual(unitWrites(busyStart), [], 'Busy controller must reject unit requests');
  assert.equal(state().parserstate.modal.units, 'G21');
  motion.cancelJog();
  await expect.poll(() => state().status.activeState).toBe('Idle');
  motion.clearJog();
}
