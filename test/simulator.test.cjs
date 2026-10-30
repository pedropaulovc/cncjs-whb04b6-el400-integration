const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { GrblSimulator } = require('../simulator/grbl.cjs');

function machine() {
  const lines = [];
  const sim = new GrblSimulator(line => lines.push(line));
  return { sim, lines, command: line => sim.input(Buffer.from(line + '\n')) };
}

test('G10 applies modal words without queuing a move', () => {
  const { sim, command, lines } = machine();
  command('G20');
  command('G21 G10 L20 P1 X0');
  command('$G');
  assert.match(lines.at(-2), / G21 /);
  assert.equal(sim.motion, null);
  command('G91 G1 X1 F60');
  sim.tick(1);
  assert.equal(sim.position[0], 1);
});

test('fragmented jog stream reports intermediate and completed machine coordinates', () => {
  const { sim, lines } = machine();
  sim.input('$J=G91 G21 X');
  sim.input('10 F600\n?');
  assert.equal(lines.at(-2), 'ok');
  assert.match(lines.at(-1), /^<Jog\|MPos:0.000,0.000,0.000/);
  sim.tick(0.5);
  sim.input('?');
  assert.match(lines.at(-1), /^<Jog\|MPos:5.000,0.000,0.000/);
  sim.tick(0.5);
  sim.input('?');
  assert.match(lines.at(-1), /^<Idle\|MPos:10.000,0.000,0.000/);
});

test('feed hold pauses programmed motion and cycle start resumes it', () => {
  const { sim, command } = machine();
  command('G91 G1 X10 F60');
  sim.tick(1);
  sim.input('!'); sim.tick(20);
  assert.equal(sim.position[0], 1);
  sim.input('~'); sim.tick(1);
  assert.equal(sim.position[0], 2);
  assert.equal(sim.state, 'Run');
});

test('realtime overrides interleave with fragmented G-code without acknowledgments or parser changes', () => {
  const { sim, lines, command } = machine();
  sim.input('G1 X10 F');
  sim.input(Buffer.from([0x91, 0x93, 0x9b, 0x9d]));
  assert.equal(lines.length, 1);
  sim.input('600 M3 S500\n?');
  assert.equal(lines.at(-2), 'ok');
  assert.match(lines.at(-1), /\|FS:666,445\|Ov:111,100,89\|A:S>/);
  command('$G');
  assert.match(lines.at(-2), / M3 .* F600 S500\]/);
  sim.tick(0.5);
  assert.equal(sim.position[0], 5.55);
});

test('feed overrides change active and queued program timing and preserve hold', () => {
  const { sim, command, lines } = machine();
  command('G91 G1 X3 F60'); command('G1 X3');
  sim.tick(1);
  sim.input('!');
  sim.input(Buffer.from(Array(10).fill(0x91)));
  sim.tick(10); sim.input('?');
  assert.equal(sim.position[0], 1);
  assert.match(lines.at(-1), /^<Hold:0.*\|FS:0,0\|Ov:200,100,100>/);
  sim.input('~'); sim.tick(2);
  assert.equal(sim.position[0], 5);
  sim.input(Buffer.from([0x90])); sim.tick(1);
  assert.equal(sim.position[0], 6);
  assert.equal(sim.state, 'Idle');
});

for (const [name, increase, decrease, reset, field] of [
  ['feed', 0x91, 0x92, 0x90, 'feedOverride'],
  ['spindle', 0x9a, 0x9b, 0x99, 'spindleOverride'],
]) test(`${name} overrides clamp at stock GRBL limits and reset independently`, () => {
  const { sim, lines } = machine();
  sim.input(Buffer.from(Array(30).fill(increase)));
  assert.equal(sim[field], 200);
  sim.input(Buffer.from(Array(30).fill(decrease)));
  assert.equal(sim[field], 10);
  sim.input(Buffer.from([reset]));
  assert.equal(sim[field], 100);
  assert.equal(lines.length, 1);
});

test('fine override bytes adjust by one percentage point', () => {
  const { sim } = machine();
  sim.input(Buffer.from([0x93, 0x9c]));
  assert.equal(sim.feedOverride, 101);
  assert.equal(sim.spindleOverride, 101);
  sim.input(Buffer.from([0x94, 0x9d]));
  assert.equal(sim.feedOverride, 100);
  assert.equal(sim.spindleOverride, 100);
});

test('jogging ignores feed and rapid overrides while respecting axis maximum rates', () => {
  const { sim, command, lines } = machine();
  sim.input(Buffer.from([0x92, 0x97]));
  command('$J=G91 X100 F600');
  sim.tick(1); sim.input('?');
  assert.equal(sim.position[0], 10);
  assert.match(lines.at(-1), /\|FS:600,0\|Ov:90,25,100>/);
  sim.input(Buffer.from([0x85]));
  command('$J=G91 Z100 F6000'); sim.tick(3);
  assert.equal(sim.position[2], 50);
});

test('rapid override affects G0 independently of feed override', () => {
  const { sim, command, lines } = machine();
  sim.input(Buffer.from([0x92, 0x97]));
  command('G0 X100'); sim.tick(1); sim.input('?');
  assert.equal(sim.position[0], 12.5);
  assert.match(lines.at(-1), /\|FS:750,0\|Ov:90,25,100>/);
  sim.input(Buffer.from([0x96])); sim.tick(1);
  assert.equal(sim.position[0], 37.5);
  sim.input(Buffer.from([0x95])); sim.tick(1);
  assert.equal(sim.position[0], 87.5);
});

test('feed override cannot exceed the maximum rate of a participating axis', () => {
  const { sim, command, lines } = machine();
  command('G1 Z100 F900');
  sim.input(Buffer.from(Array(10).fill(0x91))); sim.tick(3); sim.input('?');
  assert.equal(sim.position[2], 50);
  assert.match(lines.at(-1), /\|FS:1000,0\|Ov:200,100,100>/);
});

test('diagonal motion caps each participating axis and zero-length moves finish', () => {
  const { sim, command, lines } = machine();
  command('G0 X100 Z100'); sim.tick(3);
  assert.equal(sim.position[0], 50);
  assert.equal(sim.position[2], 50);
  sim.tick(3);
  command('G0 X100 Z100'); sim.input('?');
  assert.doesNotMatch(lines.at(-1), /Infinity|NaN/);
  sim.tick(0);
  assert.equal(sim.state, 'Idle');
});

test('spindle status follows overrides and M3/M4/M5 without changing programmed RPM', () => {
  const { sim, command, lines } = machine();
  command('M3 S600');
  sim.input(Buffer.from([0x9a])); sim.input('?');
  assert.match(lines.at(-1), /\|FS:0,660\|Ov:100,100,110\|A:S>/);
  command('M4'); sim.input('?');
  assert.match(lines.at(-1), /\|FS:0,660\|.*\|A:C>/);
  sim.input(Buffer.from(Array(10).fill(0x9a))); sim.input('?');
  assert.match(lines.at(-1), /\|FS:0,1000\|Ov:100,100,200\|A:C>/);
  command('$G');
  assert.match(lines.at(-2), / M4 .* S600\]/);
  command('M5'); sim.input('?');
  assert.match(lines.at(-1), /\|FS:0,0\|Ov:100,100,200>/);
  command('M3 S0'); sim.input('?');
  assert.match(lines.at(-1), /\|FS:0,0\|/);
});

test('soft reset restores all overrides and stops the spindle', () => {
  const { sim, command, lines } = machine();
  command('M3 S500');
  sim.input(Buffer.from([0x91, 0x97, 0x9a, 0x18])); sim.input('?');
  assert.match(lines.at(-2), /^Grbl 1.1h/);
  assert.match(lines.at(-1), /\|FS:0,0\|Ov:100,100,100>/);
});

test('mist and flood coexist across blocks and M9 clears both', () => {
  const { sim, command, lines } = machine();
  command('$I');
  assert.ok(lines.includes('[OPT:VM,15,128]'));
  command('M7'); command('$G');
  assert.match(lines.at(-2), / M5 M7 T0 /);
  command('M8'); command('$G');
  assert.match(lines.at(-2), / M5 M7 M8 T0 /);
  const Parser = require('cncjs/dist/cncjs/server/controllers/Grbl/GrblLineParserResultParserState').default;
  assert.deepEqual(Parser.parse(lines.at(-2)).payload.modal.coolant, ['M7', 'M8']);
  command('M3 S500'); sim.input('?');
  assert.match(lines.at(-1), /\|A:SFM>/);
  command('M9'); sim.input('?');
  assert.match(lines.at(-1), /\|A:S>/);
  command('M8'); command('M7'); command('$G');
  assert.match(lines.at(-2), / M3 M7 M8 T0 /);
  command('M9'); command('M5'); sim.input('?');
  assert.doesNotMatch(lines.at(-1), /\|A:/);
});

test('realtime coolant toggles update modal state independently and emit no ACK', () => {
  const { sim, command, lines } = machine();
  sim.input(Buffer.from([0xa0, 0xa1]));
  assert.equal(lines.length, 1);
  sim.input('?');
  assert.match(lines.at(-1), /\|A:FM>/);
  sim.input(Buffer.from([0xa0])); command('$G');
  assert.match(lines.at(-2), / M5 M7 T0 /);
  sim.input(Buffer.from([0xa1])); command('$G');
  assert.match(lines.at(-2), / M5 M9 T0 /);
  sim.state = 'Alarm';
  sim.input(Buffer.from([0xa0, 0xa1]));
  assert.equal(sim.coolantMode, 'off');
});

test('conflicting coolant words fail and soft reset turns all accessories off', () => {
  const { sim, command, lines } = machine();
  for (const line of ['M7 M8', 'M7 M9', 'M8 M9']) {
    command(line);
    assert.equal(lines.at(-1), 'error:21');
    assert.equal(sim.coolantMode, 'off');
  }
  command('M4 S500'); command('M8'); command('M7');
  sim.input(Buffer.from([0x18])); command('$G');
  assert.match(lines.at(-2), / M5 M9 T0 /);
  sim.input('?');
  assert.doesNotMatch(lines.at(-1), /\|A:/);
});

for (const byte of [0x21, 0x85]) test(`realtime byte 0x${byte.toString(16)} cancels jogging and discards queued jogs`, () => {
  const { sim, command } = machine();
  command('$J=G91 X10 F60');
  command('$J=G91 X10 F60');
  sim.tick(1);
  sim.input(Buffer.from([byte])); sim.tick(30);
  assert.equal(sim.state, 'Idle');
  assert.equal(sim.position[0], 1);
  assert.equal(sim.queue.length, 0);
});

test('feed hold at Idle enters Hold and cycle start clears it', () => {
  const { sim } = machine();
  sim.input('!');
  assert.equal(sim.state, 'Hold:0');
  sim.input('~');
  assert.equal(sim.state, 'Idle');
});

test('normal G-code queues while held and resumes in order', () => {
  const { sim, command, lines } = machine();
  command('G91 G1 X2 F60'); sim.tick(1);
  sim.input('!');
  command('G1 X3');
  assert.equal(lines.at(-1), 'ok');
  sim.tick(20);
  assert.equal(sim.position[0], 1);
  assert.equal(sim.state, 'Hold:0');
  sim.input('~'); sim.tick(4);
  assert.equal(sim.position[0], 5);
  assert.equal(sim.state, 'Idle');
});

test('a move accepted during idle hold waits for cycle start', () => {
  const { sim, command, lines } = machine();
  sim.input('!'); command('G91 G1 X1 F60');
  assert.equal(lines.at(-1), 'ok');
  assert.equal(sim.state, 'Hold:0');
  sim.tick(10);
  assert.equal(sim.position[0], 0);
  sim.input('~'); sim.tick(1);
  assert.equal(sim.position[0], 1);
});

test('jogs outside Idle and Jog return error:8 without changing the held program', () => {
  const { sim, command, lines } = machine();
  command('G91 G1 X2 F60');
  command('$J=G91 X10 F60');
  assert.equal(lines.at(-1), 'error:8');
  sim.input('!'); command('$J=G91 X10 F60');
  assert.equal(lines.at(-1), 'error:8');
  sim.input('~'); sim.tick(2);
  assert.equal(sim.position[0], 2);
});

test('standalone G4 delays its ACK until preceding motion and the dwell complete', () => {
  const { sim, command, lines } = machine();
  command('G91 G1 X1 F60'); command('G4 P0.5');
  assert.equal(lines.filter(line => line === 'ok').length, 1);
  sim.tick(1.25);
  assert.equal(sim.position[0], 1);
  sim.input('?');
  assert.match(lines.at(-1), /^<Idle\|/);
  assert.equal(lines.filter(line => line === 'ok').length, 1);
  sim.tick(0.25);
  assert.equal(lines.filter(line => line === 'ok').length, 2);
  assert.equal(sim.state, 'Idle');
});

test('a numbered dwell is accepted and reports Idle while waiting', () => {
  const { sim, command, lines } = machine();
  command('N10 G4 P0.5'); sim.input('?');
  assert.match(lines.at(-1), /^<Idle\|/);
  assert.equal(lines.includes('ok'), false);
  sim.tick(0.5);
  assert.equal(lines.at(-1), 'ok');
});

test('a full planner defers commands and acknowledgments until space is available', () => {
  const { sim, command, lines } = machine();
  for (let index = 0; index < 20; index++) command('G91 G1 X1 F60');
  assert.equal(lines.filter(line => line === 'ok').length, 16);
  assert.equal(lines.some(line => line.startsWith('error:')), false);
  sim.tick(1);
  assert.equal(lines.filter(line => line === 'ok').length, 17);
  sim.tick(19);
  assert.equal(lines.filter(line => line === 'ok').length, 20);
  assert.equal(sim.position[0], 20);
  assert.equal(sim.state, 'Idle');
});

test('G10 waits for queued motion and subsequent moves use the resulting work offset', () => {
  const { sim, command, lines } = machine();
  command('G91 G1 X2 F60'); command('G1 X3');
  command('G10 L20 P1 X0'); command('G90 G1 X2');
  assert.equal(lines.filter(line => line === 'ok').length, 2);
  sim.tick(4);
  assert.equal(sim.position[0], 4);
  assert.equal(sim.offset[0], 0);
  assert.equal(lines.filter(line => line === 'ok').length, 2);
  sim.tick(1);
  assert.equal(sim.offset[0], 5);
  assert.equal(lines.filter(line => line === 'ok').length, 4);
  sim.tick(2);
  assert.equal(sim.position[0], 7);
  assert.equal(sim.state, 'Idle');
});

test('jog cancel discards commands deferred by a full planner', () => {
  const { sim, command, lines } = machine();
  for (let index = 0; index < 20; index++) command('$J=G91 X1 F60');
  sim.tick(0.5); sim.input(Buffer.from([0x85])); sim.tick(30);
  assert.equal(sim.position[0], 0.5);
  assert.equal(sim.state, 'Idle');
  assert.equal(sim.pendingCommands.length, 0);
  const ackCount = lines.filter(line => line === 'ok').length;
  sim.tick(30);
  assert.equal(lines.filter(line => line === 'ok').length, ackCount);
  command('$J=G91 X1 F60'); sim.tick(1);
  assert.equal(sim.position[0], 1.5);
});

test('dwell preserves response order and realtime hold/reset remain available', () => {
  const { sim, command, lines } = machine();
  command('G4 P1'); command('$I');
  assert.equal(lines.some(line => line.startsWith('[VER:')), false);
  sim.tick(0.5); sim.input('!'); sim.tick(5);
  assert.equal(lines.includes('ok'), false);
  sim.input('~'); sim.tick(0.5);
  assert.equal(lines.at(-4), 'ok');
  assert.match(lines.at(-3), /^\[VER:/);
  assert.match(lines.at(-2), /^\[OPT:/);
  assert.equal(lines.at(-1), 'ok');
  command('G4 P10'); command('G1 X100');
  sim.input(Buffer.from([0x18])); sim.tick(20);
  assert.equal(sim.position[0], 0);
  assert.equal(sim.commandState, 'ready');
  assert.deepEqual(sim.pendingCommands, []);
});

test('unsupported dwell combinations and invalid durations fail without motion', () => {
  const { sim, command, lines } = machine();
  for (const line of ['G4', 'G4 P-1', 'G4 P1 X1', 'G4 G1 P1', '$J=G4 P1 F60']) {
    command(line);
    assert.match(lines.at(-1), /^error:/);
    assert.equal(sim.motion, null);
  }
  command('G4 P0'); sim.tick(0);
  assert.equal(lines.at(-1), 'ok');
});

test('soft reset cancels motion and restores modes without teleporting position', () => {
  const { sim, command, lines } = machine();
  command('G20 G91 G1 X1 F60');
  sim.tick(0.5);
  sim.input(Buffer.from([0x18])); sim.tick(10);
  assert.equal(sim.position[0], 12.7);
  assert.equal(sim.units, 'G21');
  assert.equal(sim.distance, 'G90');
  assert.match(lines.at(-1), /^Grbl 1.1h/);
});

test('work offsets change the work frame and G53 uses machine coordinates', () => {
  const { sim, command, lines } = machine();
  command('G0 X10'); sim.tick(1);
  command('G10 L20 P1 X0');
  assert.equal(sim.offset[0], 10);
  command('G90 G0 X5'); sim.tick(1);
  assert.equal(sim.position[0], 15);
  command('G53 G0 X0'); sim.tick(1);
  assert.equal(sim.position[0], 0);
  command('$#');
  assert.ok(lines.includes('[G54:10.000,0.000,0.000]'));
});

test('unsupported commands and malformed jogs fail without motion', () => {
  const { sim, command, lines } = machine();
  for (const text of ['G38.2 Z-10 F100', 'G2 X10 I5', 'G1 A10', '$J=G91 X10', 'G1 Xoops', '$13=1', 'G90 G91 X10', 'G1 X10 X20', 'G53 G91 X10', '$J=M3 X1 F100']) {
    command(text);
    assert.match(lines.at(-1), /^error:/, text);
    assert.deepEqual(sim.position, [0, 0, 0]);
    assert.equal(sim.motion, null);
  }
});

test('overflow discards the entire line, including a valid-looking suffix', () => {
  const { sim, lines } = machine();
  sim.input(' '.repeat(257) + 'G0X10\n');
  sim.tick(10);
  assert.deepEqual(sim.position, [0, 0, 0]);
  assert.equal(lines.filter(line => line === 'error:11').length, 1);
  sim.input('G0X1\n'); sim.tick(1);
  assert.equal(sim.position[0], 1);
});

test('CNCjs serial binding enumerates only simulator and rejects physical ports', async () => {
  const { install } = require('../simulator/register.cjs');
  const { SerialPort } = install();
  assert.deepEqual((await SerialPort.list()).map(p => p.path), ['SIMULATOR']);
  const port = new SerialPort({ path: 'SIMULATOR', baudRate: 115200 });
  await once(port, 'open');
  let received = '';
  port.on('data', data => { received += data.toString(); });
  port.write('$I\n?');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.match(received, /MANUAL-MILL-SIMULATOR/);
  assert.match(received, /<Idle\|MPos:/);
  await new Promise((resolve, reject) => port.close(err => err ? reject(err) : resolve()));
  const physical = new SerialPort({ path: 'COM1', baudRate: 115200, autoOpen: false });
  await assert.rejects(new Promise((resolve, reject) => physical.open(err => err ? reject(err) : resolve())), /cannot open physical/);
});
