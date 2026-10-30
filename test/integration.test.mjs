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
  const socket = io(base, { query: { token }, transports: ['websocket'], reconnection: false });
  const serialTrace = [];
  let workflowState;
  let latestState;
  let senderState;
  const writes = [];
  socket.on('sender:status', state => { senderState = state; });
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

  const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || undefined, headless: process.env.PW_DISPLAY !== 'headed' });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.addInitScript(() => {
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
  assert.deepEqual(browserErrors, [], 'Mounted widgets must boot without browser errors');
  const widgetJogging = event(socket, 'controller:state', (_, state) => state.status?.activeState === 'Jog');
  assert.equal(new Grbl(pendant, undefined, message => t.diagnostic(message)).jog('X', 10, 50), 'sent');
  await widgetJogging;
  const widgetStopped = event(socket, 'controller:state', (_, state) => state.status?.activeState === 'Idle');
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
  socket.disconnect();
});
