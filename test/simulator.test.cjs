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
  for (const text of ['G28', 'G2 X10 I5', 'G1 A10', '$J=G91 X10', 'G1 Xoops', '$13=1', 'G90 G91 X10', 'G1 X10 X20', 'G53 G91 X10', '$J=M3 X1 F100', '$J=G38.2 Z-1 F100']) {
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

test('G38.2 stops on the virtual probe surface and reports FluidNC PRB and Pn', () => {
  const { sim, command, lines } = machine();
  command('$SIM/probe=-50,50,-40,40,-20');
  assert.deepEqual(lines.slice(-2), ['[SIM/PROBE:-50.000,50.000,-40.000,40.000,-20.000]', 'ok']);
  command('G21 G91');
  command('G38.2 Z-30 F600');
  const acks = lines.filter(line => line === 'ok').length;
  sim.tick(1); sim.input('?');
  assert.match(lines.at(-1), /^<Run\|MPos:0.000,0.000,-10.000\|WCO:0.000,0.000,0.000\|FS:600,0\|Ov:/);
  assert.equal(lines.filter(line => line === 'ok').length, acks, 'G38.2 holds its ACK until the cycle ends');
  sim.tick(5);
  assert.deepEqual(lines.slice(-2), ['[PRB:0.000,0.000,-20.000:1]', 'ok']);
  sim.input('?');
  assert.match(lines.at(-1), /^<Idle\|MPos:0.000,0.000,-20.000\|WCO:0.000,0.000,0.000\|FS:0,0\|Pn:P\|Ov:100,100,100>$/);
  command('$G');
  assert.match(lines.at(-2), /^\[GC:G38.2 G54 /);
  command('G10 L20 P0 Z10');
  command('G91 G0 Z2'); sim.tick(1); sim.input('?');
  assert.doesNotMatch(lines.at(-1), /Pn:/);
  command('$#');
  assert.ok(lines.includes('[G54:0.000,0.000,-30.000]'));
  assert.ok(lines.includes('[PRB:0.000,0.000,-20.000:1]'));
});

test('a probe cycle waits for queued motion and probes sideways into the box', () => {
  const { sim, command, lines } = machine();
  command('$SIM/probe=10,60,0,40,-5');
  command('G90 G1 Y20 Z-10 F600'); command('G38.2 X30 F600');
  assert.equal(lines.filter(line => line === 'ok').length, 2);
  sim.tick(5);
  assert.deepEqual(sim.position.map(n => +n.toFixed(6)), [10, 20, -10]);
  assert.deepEqual(lines.slice(-2), ['[PRB:10.000,20.000,-10.000:1]', 'ok']);
});

test('a missed G38.2 raises ALARM:5 and G38.3 reports the miss without alarm', () => {
  const { sim, command, lines } = machine();
  command('G38.2 Z-5 F600'); sim.tick(1);
  assert.deepEqual(lines.slice(-4), ['[MSG:INFO: ALARM: Probe Fail Contact]', 'ALARM:5', '[PRB:0.000,0.000,0.000:0]', 'ok']);
  assert.equal(sim.state, 'Alarm');
  assert.equal(sim.position[2], -5);
  command('G0 Z0');
  assert.equal(lines.at(-1), 'error:9');
  command('$X');
  command('G38.3 Z-10 F600'); sim.tick(1);
  assert.deepEqual(lines.slice(-2), ['[PRB:0.000,0.000,-10.000:0]', 'ok']);
  assert.equal(sim.state, 'Idle');
});

test('probing from contact raises ALARM:4 and G38.4 stops when contact opens', () => {
  const { sim, command, lines } = machine();
  command('$SIM/probe=-10,10,-10,10,0');
  for (const text of ['G38.2 Z-1 F600', 'G38.3 Z-1 F600']) {
    command('$X'); command(text);
    assert.deepEqual(lines.slice(-3), ['[MSG:INFO: ALARM: Probe Fail Initial]', 'ALARM:4', 'ok'], text);
    assert.equal(sim.motion, null);
  }
  command('$X');
  command('G38.4 Z5 F600'); sim.tick(1);
  assert.deepEqual(lines.slice(-2), ['[PRB:0.000,0.000,0.000:1]', 'ok']);
  assert.equal(sim.inputs(), '');
  command('G38.5 Z5 F600');
  assert.deepEqual(lines.slice(-3), ['[MSG:INFO: ALARM: Probe Fail Initial]', 'ALARM:4', 'ok']);
  command('$X');
  command('G38.2 Z-1 F600'); sim.tick(1);
  assert.deepEqual(lines.slice(-2), ['[PRB:0.000,0.000,0.000:1]', 'ok']);
  command('$SIM/probe=off');
  command('$X'); command('G38.4 Z1 F600'); sim.tick(1);
  assert.equal(lines.at(-2), 'ALARM:4');
});

test('the toolsetter reports Pn:T and stops G38.2 like the probe input', () => {
  const { sim, command, lines } = machine();
  command('$SIM/toolsetter=100,50,-10');
  assert.equal(lines.at(-2), '[SIM/TOOLSETTER:100.000,50.000,-10.000,10.000]');
  command('$SIM/probe=0,200,0,100,-15');
  command('G53 G0 X104 Y46'); command('G38.2 Z-30 F600'); sim.tick(5);
  assert.deepEqual(lines.slice(-2), ['[PRB:104.000,46.000,-10.000:1]', 'ok']);
  sim.input('?');
  assert.match(lines.at(-1), /\|FS:0,0\|Pn:T\|Ov:/);
  command('G38.2 Z-30 F600');
  assert.equal(lines.at(-2), 'ALARM:4', 'Touching the toolsetter counts as a triggered probe');
  command('$X'); command('G91 G0 Z-5'); sim.tick(1); sim.input('?');
  assert.match(lines.at(-1), /\|Pn:PT\|/);
  command('$SIM/toolsetter');
  assert.equal(lines.at(-2), '[SIM/TOOLSETTER:100.000,50.000,-10.000,10.000]');
  for (const text of ['$SIM/toolsetter=1,2', '$SIM/probe=1,0,0,1,0', '$SIM/probe=a,b,c,d,e', '$SIM/spindle=1']) {
    command(text);
    assert.equal(lines.at(-1), 'error:3', text);
  }
});

test('feed hold pauses a probe cycle and soft reset abandons it', () => {
  const { sim, command, lines } = machine();
  command('$SIM/probe=-10,10,-10,10,-20');
  command('G38.2 Z-30 F600'); sim.tick(1);
  sim.input('!'); sim.tick(10);
  assert.equal(sim.position[2], -10);
  sim.input('~'); sim.tick(2);
  assert.deepEqual(lines.slice(-2), ['[PRB:0.000,0.000,-20.000:1]', 'ok']);
  command('G91 G0 Z5'); sim.tick(1);
  command('G38.2 Z-30 F600'); sim.tick(0.1);
  sim.input(Buffer.from([0x18])); sim.tick(10);
  assert.equal(sim.commandState, 'ready');
  assert.equal(sim.motion, null);
  assert.ok(sim.position[2] > -20);
});

test('G10 L20 P0-P6, G54-G59 selection, G43.1 and G49 shape the work frame', () => {
  const { sim, command, lines } = machine();
  command('G0 X10 Y20 Z-5'); sim.tick(1);
  command('G10 L20 P2 X1 Y2 Z3');
  assert.deepEqual(sim.offset, [0, 0, 0], 'P2 writes G55 without selecting it');
  command('G55');
  assert.deepEqual(sim.offset, [9, 18, -8]);
  command('G10 L20 P0 X0');
  assert.equal(sim.offsets[1][0], 10, 'P0 writes the active system');
  command('G43.1 Z2.5');
  assert.deepEqual(sim.offset, [10, 18, -5.5]);
  command('G10 L20 P0 Z0');
  assert.deepEqual(sim.offsets[1], [10, 18, -7.5], 'L20 accounts for the tool length offset');
  assert.deepEqual(sim.offset, [10, 18, -5]);
  command('$#');
  assert.ok(lines.includes('[G55:10.000,18.000,-7.500]'));
  assert.ok(lines.includes('[TLO:2.500]'));
  command('$G');
  assert.match(lines.at(-2), /^\[GC:G0 G55 /);
  sim.input('?');
  assert.match(lines.at(-1), /\|WCO:10.000,18.000,-5.000\|/);
  command('G90 G0 Z0'); sim.tick(1);
  assert.equal(sim.position[2], -5);
  command('G49');
  assert.deepEqual(sim.offset, [10, 18, -7.5]);
  command('G53 G0 Z0'); sim.tick(1);
  assert.equal(sim.position[2], 0);
  for (const [text, code] of [['G10 L20 P7 X0', 29], ['G10 L20 X0', 28], ['G10 L2 P1 X0', 20], ['G43.1 X1', 37], ['G43.1', 37], ['G53 G38.2 Z-1 F100', 30], ['G54 G55', 21], ['G91 G38.2 Z0 F100', 33]]) {
    command(text);
    assert.equal(lines.at(-1), `error:${code}`, text);
  }
  assert.equal(sim.distance, 'G90', 'A rejected line leaves modal state unchanged');
  sim.input(Buffer.from([0x18]));
  assert.equal(sim.wcs, 0);
  assert.equal(sim.toolLengthOffset, 0);
  assert.deepEqual(sim.offsets[1], [10, 18, -7.5], 'Work offsets persist across soft reset');
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
