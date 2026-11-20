import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const io = require('socket.io-client');
const jwt = require('jsonwebtoken');

const USAGE = `Usage: node scripts/cnc.mjs <command> [args] [options]

Talks to the controller through the running CNCjs server. It joins the port
CNCjs already has open, so the controller is not reset.

Commands:
  state                  Print the current status and exit
  watch                  Print status changes and controller output until Ctrl+C
  send <line>...         Send lines one at a time and print the replies
  unlock                 Clear an alarm ($X)
  home [axes]            Home all axes ($H) or the given ones (home y -> $HY)
  jog <axis><dist>...    Relative jog, e.g. "jog y-3 --in" or "jog x10 z-1"
  limits [seconds]       Sample $Limits (default 3 s) and decode the active pins
  stop                   Cancel jog and feed hold
  resume                 Resume after a feed hold (~)
  reset                  Soft-reset the controller (Ctrl-X); position is lost
  open                   Open the serial port in CNCjs (resets ESP32 controllers)

Options:
  --in                   Jog distances and feed in inches (default: mm)
  --feed <rate>          Jog feed per minute (default: 500 mm or 20 in)
  --serial <port>        Serial port (default: the one CNCjs has open)
  --baud <rate>          Baud rate for "open" (default: 115200)
  --mode <mode>          CNCjs server: machine (default) or simulator
  --port <http-port>     CNCjs HTTP port (default: 8001 machine, 8000 simulator)
  -v, --verbose          Also print status reports and ok replies
  -h, --help             Show this help

Quote lines that start with $ in bash: send '$/axes/y' '$#'
Ctrl+C during a jog cancels it; during homing it resets the controller.`;

const QUIET_READ = /^<|^ok$|^\[GC:/;

const { values: opts, positionals } = parseArgs({ allowPositionals: true, options: {
  in: { type: 'boolean' },
  feed: { type: 'string' },
  serial: { type: 'string' },
  baud: { type: 'string', default: '115200' },
  mode: { type: 'string', default: 'machine' },
  port: { type: 'string' },
  verbose: { type: 'boolean', short: 'v' },
  help: { type: 'boolean', short: 'h' },
} });

function formatAxes(pos) {
  if (!pos) return '-';
  return Object.entries(pos).map(([axis, value]) => `${axis.toUpperCase()}${value}`).join(' ');
}

function formatStatus(status) {
  if (!status) return 'no status yet';
  return `${status.activeState} MPos ${formatAxes(status.mpos)} WPos ${formatAxes(status.wpos)} Pn:${status.pinState || '-'}`;
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

class Machine {
  constructor(socket) {
    this.socket = socket;
    this.serial = null;
    this.status = null;
    this.listeners = new Set();
    this.lastPrinted = '';
    socket.on('controller:state', (type, state) => {
      this.status = state?.status ?? null;
      this.emit({ kind: 'state', status: this.status });
    });
    socket.on('serialport:read', (line) => this.emit({ kind: 'read', line }));
  }

  on(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event) {
    for (const listener of [...this.listeners]) listener(event);
  }

  writeln(line) {
    this.socket.emit('writeln', this.serial, line);
  }

  write(data) {
    this.socket.emit('write', this.serial, data);
  }

  printEvents() {
    return this.on((event) => {
      if (event.kind === 'read') {
        if (opts.verbose || !QUIET_READ.test(event.line)) console.log(event.line);
        return;
      }
      const text = formatStatus(event.status);
      if (text === this.lastPrinted) return;
      this.lastPrinted = text;
      console.log(`  ${text}`);
    });
  }

  // Resolves on "ok", rejects on "error:"/"ALARM:"; output in between is printed by printEvents.
  send(line, timeoutMs = 10000) {
    return new Promise((done, fail) => {
      const timer = setTimeout(() => { off(); fail(new Error(`No reply to ${line} within ${timeoutMs / 1000} s`)); }, timeoutMs);
      const off = this.on((event) => {
        if (event.kind !== 'read') return;
        if (/^ok$/.test(event.line)) { clearTimeout(timer); off(); done(); return; }
        if (/^(error|ALARM)/i.test(event.line)) { clearTimeout(timer); off(); fail(new Error(`${line} -> ${event.line}`)); }
      });
      this.writeln(line);
    });
  }

  // CNCjs only emits controller:state on change, so a move too short to be seen as
  // Jog/Run is detected by a changed MPos, or by settling Idle with no change.
  waitMotionDone(start, timeoutMs) {
    const startPos = JSON.stringify(start?.mpos);
    return new Promise((done, fail) => {
      let sawActive = false;
      const check = () => {
        const status = this.status;
        if (!status) return;
        if (status.activeState === 'Alarm') { finish(new Error('Controller entered Alarm')); return; }
        if (status.activeState !== 'Idle') { sawActive = true; return; }
        if (sawActive || JSON.stringify(status.mpos) !== startPos) finish();
      };
      const settle = setTimeout(() => { if (!sawActive && this.status?.activeState === 'Idle') finish(); }, 1500);
      const timer = setTimeout(() => finish(new Error(`Motion did not finish within ${timeoutMs / 1000} s`)), timeoutMs);
      const off = this.on((event) => {
        if (event.kind === 'read' && /^ALARM/i.test(event.line)) { finish(new Error(event.line)); return; }
        if (event.kind === 'state') check();
      });
      function finish(error) {
        clearTimeout(settle);
        clearTimeout(timer);
        off();
        if (error) fail(error);
        else done();
      }
      check();
    });
  }
}

async function connect() {
  const httpPort = opts.port ?? (opts.mode === 'simulator' ? '8000' : '8001');
  const configPath = resolve(root, `.runtime/cncjs-${opts.mode}.json`);
  let config;
  try { config = JSON.parse(await readFile(configPath, 'utf8')); }
  catch (cause) { throw new Error(`Cannot read ${configPath}; start the CNCjs ${opts.mode} server first.`, { cause }); }
  const token = jwt.sign({ id: '', name: 'cnc-cli' }, config.secret, { expiresIn: '1d' });
  const socket = io.connect(`http://127.0.0.1:${httpPort}`, { query: `token=${token}`, reconnection: false });
  const machine = new Machine(socket);
  const ports = await new Promise((done, fail) => {
    socket.on('connect_error', (error) => fail(new Error(`Cannot reach CNCjs on port ${httpPort}: ${error.message}`)));
    socket.on('startup', () => socket.emit('list'));
    socket.on('serialport:list', done);
  });
  return { machine, socket, ports };
}

function choosePort(ports, command) {
  const requested = opts.serial && ports.find((p) => p.port.toLowerCase() === opts.serial.toLowerCase());
  if (opts.serial && !requested) throw new Error(`Serial port ${opts.serial} not found. Ports: ${ports.map((p) => p.port).join(', ')}`);
  const port = requested || ports.find((p) => p.inuse);
  if (command === 'open') {
    if (port) return port;
    if (ports.length === 1) return ports[0];
    throw new Error(`Several serial ports (${ports.map((p) => p.port).join(', ')}); pick one with --serial.`);
  }
  if (!port?.inuse) {
    const list = ports.map((p) => `${p.port}${p.inuse ? ' (open)' : ''}`).join(', ') || 'none';
    throw new Error(`No serial port is open in CNCjs (ports: ${list}). Open it in CNCjs or run "open" (resets the controller).`);
  }
  return port;
}

function join(machine, socket, port, options = {}) {
  machine.serial = port;
  return new Promise((done, fail) => {
    socket.emit('open', port, options, (error) => (error ? fail(new Error(`Cannot open ${port}: ${error.message ?? error}`)) : done()));
  });
}

function parseJog(tokens) {
  if (tokens.length === 0) throw new Error('jog needs at least one <axis><distance>, e.g. y-3');
  const words = tokens.map((token) => {
    const match = /^([xyzabc])([+-]?(?:\d+\.?\d*|\.\d+))$/i.exec(token);
    if (!match) throw new Error(`Bad jog target "${token}"; use e.g. x10, y-3, z0.5`);
    return `${match[1].toUpperCase()}${match[2]}`;
  });
  const feed = opts.feed ?? (opts.in ? '20' : '500');
  if (!(+feed > 0)) throw new Error('--feed must be a positive number');
  return `$J=${opts.in ? 'G20' : 'G21'} G91 ${words.join(' ')} F${feed}`;
}

function requireState(machine, allowed, hint) {
  const state = machine.status?.activeState;
  if (allowed.includes(state)) return;
  throw new Error(`Controller is ${state ?? 'unknown'}, expected ${allowed.join(' or ')}.${hint ? ` ${hint}` : ''}`);
}

function decodeLimits(line) {
  // FluidNC prints ": " + 12-char positive-pin field + " " + 12-char negative-pin field; CNCjs trims trailing spaces.
  const pos = line.slice(2, 14).trim();
  const neg = line.slice(15).trim();
  return `pos: ${pos || '-'}  neg: ${neg || '-'}`;
}

let interruptAction = null;
process.on('SIGINT', () => {
  if (!interruptAction) process.exit(130);
  interruptAction();
  setTimeout(() => process.exit(130), 300);
});

const commands = {
  async state(machine) {
    console.log(formatStatus(machine.status));
  },

  async watch(machine) {
    console.log('Watching; Ctrl+C stops.');
    machine.printEvents();
    await new Promise(() => {});
  },

  async send(machine, args) {
    if (args.length === 0) throw new Error('send needs at least one line');
    if (args.some((line) => /^\$limits/i.test(line))) throw new Error('Use the "limits" command; $Limits loops until "!".');
    machine.printEvents();
    for (const line of args) {
      console.log(`> ${line}`);
      await machine.send(line);
    }
  },

  async unlock(machine) {
    machine.printEvents();
    await machine.send('$X');
    await sleep(500);
    console.log(formatStatus(machine.status));
  },

  async home(machine, args) {
    const axes = (args[0] ?? '').toUpperCase();
    if (!/^[XYZABC]*$/.test(axes)) throw new Error(`Bad axes "${args[0]}"; use e.g. "home" or "home y"`);
    requireState(machine, ['Idle', 'Alarm']);
    machine.printEvents();
    interruptAction = () => { console.log('Interrupted: resetting controller'); machine.write('\x18'); };
    console.log(`> $H${axes}`);
    await machine.send(`$H${axes}`, 180000);
    await machine.waitMotionDone(machine.status, 10000);
  },

  async jog(machine, args) {
    const line = parseJog(args);
    requireState(machine, ['Idle'], 'Run "unlock" first if it is in Alarm.');
    const start = machine.status;
    machine.printEvents();
    interruptAction = () => { console.log('Interrupted: cancelling jog'); machine.write('\x85'); };
    console.log(`> ${line}`);
    await machine.send(line);
    await machine.waitMotionDone(start, 600000);
  },

  async limits(machine, args) {
    const seconds = Number(args[0] ?? 3);
    if (!(seconds > 0)) throw new Error('limits takes a positive number of seconds');
    let last = '';
    const off = machine.on((event) => {
      if (event.kind !== 'read' || !event.line.startsWith(':')) return;
      const decoded = decodeLimits(event.line);
      if (decoded === last) return;
      last = decoded;
      console.log(decoded);
    });
    interruptAction = () => machine.write('!');
    machine.writeln('$Limits');
    await sleep(seconds * 1000);
    machine.write('!');
    await sleep(800);
    off();
  },

  async stop(machine) {
    machine.write('\x85');
    machine.write('!');
    await sleep(500);
    console.log(formatStatus(machine.status));
  },

  async resume(machine) {
    machine.write('~');
    await sleep(500);
    console.log(formatStatus(machine.status));
  },

  async reset(machine) {
    machine.write('\x18');
    await sleep(1500);
    console.log(formatStatus(machine.status));
  },
};

async function main() {
  const [command, ...args] = positionals;
  if (opts.help || !command) {
    console.log(USAGE);
    return;
  }
  if (command !== 'open' && !commands[command]) throw new Error(`Unknown command "${command}". Run with --help.`);
  const { machine, socket, ports } = await connect();
  try {
    const port = choosePort(ports, command);
    if (command !== 'open') {
      await join(machine, socket, port.port);
      await sleep(300);
      await commands[command](machine, args);
      return;
    }
    if (!port) throw new Error('No serial ports found.');
    if (port.inuse) {
      await join(machine, socket, port.port);
      console.log(`${port.port} is already open.`);
      return;
    }
    console.log(`Opening ${port.port}; this resets ESP32 controllers.`);
    machine.printEvents();
    await join(machine, socket, port.port, { controllerType: 'Grbl', baudrate: Number(opts.baud) });
    await sleep(7000);
    console.log(formatStatus(machine.status));
  } finally {
    socket.close();
  }
}

main().then(() => process.exit(0), (error) => {
  console.error(`Error: ${error.message}`);
  process.exit(1);
});
