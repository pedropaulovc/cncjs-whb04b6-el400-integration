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
    assert.equal(grbl.jogCompleted(), true, 'Raw endpoint must confirm completion');
    listeners.get('controller:state')('Grbl', structuredClone(runner.state));
    assert.equal(grbl.jogCompleted(), true, 'The derived coordinate frame must not invalidate completion');
    grbl.cancelJog();
    assert.equal(grbl.jog('Y', 0.04, 250), 'sent', 'The first input on another axis must work');
    assert.ok(commands.every(args => args[2] !== 'jogCancel'), 'A completed move must not trigger cancellation');
  });
}

test('real CNCjs serves widgets and reports simulated jog/offset through its controller parser', { timeout: 90000 }, async t => {
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
  const moved = event(socket, 'controller:state', (_, state) => Number(state.status?.mpos?.x) === 5 && state.status.activeState === 'Idle');
  assert.equal(new Grbl(pendant, undefined, message => t.diagnostic(message)).jog('X', 5, 750), 'sent');
  await moved;
  const zeroed = event(socket, 'controller:state', (_, state) => Number(state.status?.wpos?.x) === 0 && Number(state.status?.mpos?.x) === 5);
  socket.emit('command', 'SIMULATOR', 'gcode', 'G21 G10 L20 P1 X0');
  await zeroed;
  const rejected = await new Promise(resolve => socket.emit('open', 'COM1', { controllerType: 'Grbl', baudrate: 115200 }, resolve));
  assert.ok(rejected, 'Simulation must reject hardware even when directly requested');

  const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || undefined, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.addInitScript(() => {
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
  await expect(pendantFrame.locator('#hidPill')).toHaveText('pendant ✓');
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
  // Wait past the startup splash and verify the actual machine coordinate.
  // A fresh EL400 defaults to inches: 5 mm = 0.1969 in at four decimals.
  await expect(droFrame.getByTestId('axis-value-x')).toHaveText('0.1969', { timeout: 10000 });
  await droFrame.getByRole('button', { name: /toggle units/i }).click();
  await expect(droFrame.getByTestId('axis-value-x')).toHaveText('5.0000');
  const movedAgain = event(socket, 'controller:state', (_, state) => Number(state.status?.mpos?.x) === 10 && state.status.activeState === 'Idle');
  assert.equal(new Grbl(pendant, undefined, message => t.diagnostic(message)).jog('X', 5, 750), 'sent');
  await movedAgain;
  await expect(droFrame.getByTestId('axis-value-x')).toHaveText('10.0000');
  // LinuxCNC's packed LCD report: FE FD FE, relative+MPG flags, integer/fraction
  // coordinate pairs, then 16-bit feed/spindle override percentages.
  await expect.poll(lcdFrame).toEqual([
    0xfe, 0xfd, 0xfe, 0x82,
    5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    100, 0, 100, 0, 0,
  ]);
  const displayInches = event(socket, 'controller:state', (_, state) => state.parserstate?.modal?.units === 'G20');
  socket.emit('command', 'SIMULATOR', 'gcode', 'G20');
  await displayInches;
  // GRBL still reports millimetres ($13=0); the LCD must show 5/25.4 = 0.1969 in.
  await expect.poll(async () => (await lcdFrame())?.slice(4, 8)).toEqual([0, 0, 177, 7]);
  const displayMillimetres = event(socket, 'controller:state', (_, state) => state.parserstate?.modal?.units === 'G21');
  socket.emit('command', 'SIMULATOR', 'gcode', 'G21');
  await displayMillimetres;
  await expect.poll(async () => (await lcdFrame())?.slice(4, 8)).toEqual([5, 0, 0, 0]);
  await pendantFrame.getByText('Pendant settings', { exact: true }).click();
  await pendantFrame.getByText('Macro buttons', { exact: true }).click();
  const assignment = pendantFrame.getByRole('combobox', { name: 'Assignment for Fn + Feed+' });
  await expect(assignment.locator('option', { hasText: 'Pendant units' })).toHaveCount(1);
  await assignment.selectOption(`cncjs:${savedMacro.id}`);
  await pendantFrame.getByRole('button', { name: 'Save settings', exact: true }).click();
  await expect(pendantFrame.locator('#settingsStatus')).toContainText('Settings saved');
  const macroButton = (key, modifier = 0) => page.frame({ name: 'pendant' }).evaluate(({ key, modifier }) => {
    for (const pressed of [key, 0]) window.testPendant.dispatchEvent(new CustomEvent('use', {
      detail: { firstKeyCode: pressed ? modifier || key : 0, secondKeyCode: pressed && modifier ? key : 0,
        leftDialCode: 0x11, rightDialCode: 0x0f, jog: 0 },
    }));
  }, { key, modifier });
  await macroButton(0x04, 0x0c);
  await expect.poll(() => latestState.parserstate?.modal?.units).toBe('G20');
  await macroApi(`/${savedMacro.id}`, 'PUT', { name: 'Updated units', content: '%units=21\nG[units]' });
  // CNCjs configstore uses fs.watchFile's ~5 s polling interval.
  await expect(assignment.locator('option', { hasText: 'Updated units' })).toHaveCount(1, { timeout: 12000 });
  await macroButton(0x04, 0x0c);
  await expect.poll(() => latestState.parserstate?.modal?.units).toBe('G21');
  const customAssignment = pendantFrame.getByRole('combobox', { name: 'Assignment for Fn + Feed-' });
  await customAssignment.selectOption('custom');
  await pendantFrame.getByRole('textbox', { name: 'G-code for Fn + Feed-', exact: true }).fill('G20\nG21');
  await pendantFrame.getByRole('button', { name: 'Refresh CNCjs macros' }).click();
  await expect(pendantFrame.locator('#macroStatus')).toContainText('available');
  await expect(pendantFrame.getByRole('textbox', { name: 'G-code for Fn + Feed-', exact: true })).toHaveValue('G20\nG21');
  await pendantFrame.getByRole('button', { name: 'Save settings', exact: true }).click();
  const customWrites = writes.length;
  await macroButton(0x05, 0x0c);
  await expect.poll(() => writes.slice(customWrites).map(line => line.trim()).filter(line => ['G20', 'G21'].includes(line)))
    .toEqual(['G20', 'G21']);
  await expect.poll(() => latestState.parserstate?.modal?.units).toBe('G21');
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
    assert.equal(latestState.parserstate?.modal?.units, 'G21');
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
  await assignment.selectOption('disabled');
  await customAssignment.selectOption('disabled');
  await pendantFrame.getByRole('button', { name: 'Save settings', exact: true }).click();
  const toggleLcdCoordinates = () => page.frame({ name: 'pendant' }).evaluate(() => {
    for (const key of [0x10, 0]) window.testPendant.dispatchEvent(new CustomEvent('use', {
      detail: { firstKeyCode: key, secondKeyCode: 0, leftDialCode: 0x11, rightDialCode: 0x0f, jog: 0 },
    }));
  });
  await toggleLcdCoordinates();
  await expect.poll(async () => (await lcdFrame())?.slice(3, 8)).toEqual([0x02, 10, 0, 0, 0]);
  await toggleLcdCoordinates();
  await expect.poll(async () => (await lcdFrame())?.slice(3, 8)).toEqual([0x82, 5, 0, 0, 0]);
  const hidEvent = type => page.frame({ name: 'pendant' }).evaluate(type => {
    const event = new Event(type);
    Object.defineProperty(event, 'device', { value: window.testHidDevice });
    window.testHid.dispatchEvent(event);
  }, type);
  await hidEvent('disconnect');
  await expect(pendantFrame.locator('#hidPill')).toHaveText('pendant ✗');
  await page.frame({ name: 'pendant' }).evaluate(() => { window.testLcdReports = []; });
  await toggleLcdCoordinates();
  await toggleLcdCoordinates();
  assert.equal(await page.frame({ name: 'pendant' }).evaluate(() => window.testLcdReports.length), 0,
    'Disconnected receiver must not receive even a partial LCD frame');
  await hidEvent('connect');
  await expect(pendantFrame.locator('#hidPill')).toHaveText('pendant ✓');
  await expect.poll(async () => (await lcdFrame())?.slice(3, 8)).toEqual([0x82, 5, 0, 0, 0]);
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
  assert.equal(queuedJog.jog('X', -0.04, 250), 'sent');
  const issuedSequence = pendant.reportSequence;
  await Promise.all([
    expect.poll(() => pendant.reportSequence, { intervals: [50], timeout: 2000 }).toBeGreaterThanOrEqual(issuedSequence + 2),
    expect.poll(() => feederState?.queue, { intervals: [50], timeout: 2000 }).toBeGreaterThanOrEqual(3),
  ]);
  assert.ok(!writes.slice(writeStart).some(line => line.startsWith('$J=')), 'Regression setup must leave both jogs queued behind the dwell');
  assert.equal(queuedJog.jogCompleted(), false, 'Idle before queued jog acknowledgements must not complete the jog');
  const cancelWrite = event(socket, 'serialport:write', line => line.includes('\x85'));
  queuedJog.cancelJog();
  await cancelWrite;
  await expect.poll(() => queuedJog.jogPhase).toBe('idle');
  // A subsequent acknowledged modal command proves the dwell/feeder drained.
  const queuedDrained = event(socket, 'controller:state', (_, state) => state.parserstate?.modal?.units === 'G21');
  pendant.command('gcode', 'G21');
  await queuedDrained;
  assert.ok(!writes.slice(writeStart).some(line => line.startsWith('$J=')), 'Canceled queued jogs must never be sent');
  const completedWrites = writes.length;
  assert.equal(queuedJog.jog('X', 0.04, 250), 'sent');
  assert.equal(queuedJog.jog('X', -0.04, 250), 'sent');
  await expect.poll(() => queuedJog.jogPhase).toBe('idle');
  assert.equal(writes.slice(completedWrites).filter(line => line.startsWith('$J=')).length, 2,
    'An acknowledged out-and-back pair must finish without leaving the pendant locked');
  // A widget joining an open controller cannot correlate pre-join replies.
  // Keep its cancellation armed without polling forever or deleting later MDI work.
  const lateSession = new CncjsSession({ io, origin: base });
  t.after(() => lateSession.disconnect());
  lateSession.connect(token);
  await expect.poll(() => lateSession.status.phase).toBe('joined');
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
    await report({ firstKeyCode: code, secondKeyCode: modifier, rightDialCode });
    await report({ rightDialCode });
  };
  const getPosition = () => ['x', 'y', 'z'].map(axis => Number(latestState.status.mpos[axis]));
  const stationary = getPosition();
  await pendantFrame.locator('#thickness').fill('');
  await press(0x0d);
  await expect(pendantFrame.locator('#log')).toContainText('Enter a valid nonnegative probe plate thickness.');
  assert.deepEqual(getPosition(), stationary, 'A blank probe thickness must not start a probe');
  await report({ jog: -2 });
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
  await expect.poll(() => latestState.parserstate?.modal?.spindle).toBe('M3');
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
});
