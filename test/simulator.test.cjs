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

test('hold resumes and jog cancel discards queued motion', () => {
  const { sim, command } = machine();
  command('$J=G91 X10 F60');
  command('$J=G91 X10 F60');
  sim.tick(1);
  sim.input('!'); sim.tick(20);
  assert.equal(sim.position[0], 1);
  sim.input('~'); sim.tick(1);
  assert.equal(sim.position[0], 2);
  sim.input(Buffer.from([0x85])); sim.tick(30);
  assert.equal(sim.state, 'Idle');
  assert.equal(sim.position[0], 2);
  assert.equal(sim.queue.length, 0);
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
