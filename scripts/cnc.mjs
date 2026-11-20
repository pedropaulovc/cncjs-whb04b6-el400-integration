import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Resolve the client through CNCjs so it always matches the server's socket.io version.
const cncRequire = createRequire(createRequire(import.meta.url).resolve('cncjs/package.json'));
const io = cncRequire('socket.io-client');
const jwt = cncRequire('jsonwebtoken');

const USAGE = `Usage: node scripts/cnc.mjs <command> [args] [options]

Talks to the controller through the running CNCjs server. It joins the port
CNCjs already has open, so the controller is not reset.

Commands:
  state                  Print the current status and exit
  watch                  Print status changes and controller output until Ctrl+C
  send <line>...         Send lines one at a time and print the replies
  unlock                 Clear an alarm ($X)
  home [axes]            Home all axes ($H) or the given ones (home y, home x y)
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
const REALTIME = new Set(['?', '!', '~', '\x18']);
const CONNECT_TIMEOUT_MS = 5000;

let opts;

function isRealtime(data) {
  return REALTIME.has(data) || /^[\x80-\xff]$/.test(data);
}

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
    this.id = randomUUID();
    this.serial = null;
    this.status = null;
    this.listeners = new Set();
    this.lastPrinted = '';
    // Every line written to the controller by any client, oldest first. GRBL answers
    // each line with exactly one ok/error, in order, so the head of this queue owns the
    // next reply. Our own entries carry the callbacks that settle send().
    this.inFlight = [];
    this.ownUnsent = [];
    socket.on('controller:state', (type, state) => {
      this.status = state?.status ?? null;
      this.emit({ kind: 'state', status: this.status });
    });
    socket.on('serialport:write', (data, context) => this.trackWrite(data, context));
    socket.on('serialport:read', (line) => this.handleRead(line));
    socket.on('disconnect', (reason) => {
      const error = new Error(`Lost connection to CNCjs (${reason})`);
      for (const entry of [...this.ownUnsent, ...this.inFlight]) entry.settle?.(error);
      this.emit({ kind: 'disconnect', error });
    });
  }

  trackWrite(data, context) {
    const text = String(data);
    if (text.includes('\x18')) {
      this.resync(new Error('Controller was reset'));
      return;
    }
    if (!text.endsWith('\n')) return; // realtime byte or partial raw write: no reply expected
    // The controller acknowledges every line, blank ones included (FluidNC execute_line: "For syncing purposes").
    for (const line of text.slice(0, -1).split('\n')) {
      const own = context?.cncCliId === this.id ? this.ownUnsent.shift() : undefined;
      this.inFlight.push(own ?? { line });
    }
  }

  // A reset or alarm flushes the controller's receive buffer, so queued lines never get a reply.
  resync(error) {
    const lost = this.inFlight;
    this.inFlight = [];
    for (const entry of lost) entry.settle?.(new Error(`${entry.line} -> ${error.message}`));
  }

  handleRead(line) {
    this.emit({ kind: 'read', line });
    if (/^ok$/.test(line)) {
      this.inFlight.shift()?.settle?.();
      return;
    }
    if (/^error/i.test(line)) {
      const entry = this.inFlight.shift();
      entry?.settle?.(new Error(`${entry.line} -> ${line}`));
      return;
    }
    if (/^ALARM/i.test(line) || /^Grbl \d/.test(line)) this.resync(new Error(line));
  }

  on(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event) {
    for (const listener of [...this.listeners]) listener(event);
  }

  write(data) {
    this.socket.emit('write', this.serial, data, { cncCliId: this.id });
  }

  writeln(line) {
    this.socket.emit('writeln', this.serial, line, { cncCliId: this.id });
  }

  printEvents() {
    return this.on((event) => {
      if (event.kind === 'disconnect') return;
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

  // Resolves on the ok that answers this line, rejects on its error, an alarm, or a disconnect.
  send(line, timeoutMs = 10000) {
    return new Promise((done, fail) => {
      const entry = { line };
      const timer = setTimeout(() => entry.settle(new Error(`No reply to ${line} within ${timeoutMs / 1000} s`)), timeoutMs);
      entry.settle = (error) => {
        entry.settle = null;
        clearTimeout(timer);
        if (error) return fail(error);
        done();
      };
      this.ownUnsent.push(entry);
      this.writeln(line);
    });
  }

  // CNCjs only emits controller:state on change, so a move too short to be seen as
  // Jog/Run is detected by a changed MPos, or by settling Idle with no change.
  waitMotionDone(start, timeoutMs) {
    const startPos = JSON.stringify(start?.mpos);
    const startedInAlarm = start?.activeState === 'Alarm';
    return new Promise((done, fail) => {
      let sawActive = false;
      const check = () => {
        const status = this.status;
        if (!status) return;
        if (status.activeState === 'Alarm') {
          // A stale Alarm from before homing is not a failure; a new ALARM line is caught below.
          if (!startedInAlarm || sawActive) finish(new Error('Controller entered Alarm'));
          return;
        }
        if (status.activeState !== 'Idle') { sawActive = true; return; }
        if (sawActive || startedInAlarm || JSON.stringify(status.mpos) !== startPos) finish();
      };
      const settle = setTimeout(() => { if (!sawActive && this.status?.activeState === 'Idle') finish(); }, 1500);
      const timer = setTimeout(() => finish(new Error(`Motion did not finish within ${timeoutMs / 1000} s`)), timeoutMs);
      const off = this.on((event) => {
        if (event.kind === 'disconnect') { finish(event.error); return; }
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
  try {
    const ports = await new Promise((done, fail) => {
      const timer = setTimeout(() => fail(new Error(`No answer from CNCjs on port ${httpPort} within ${CONNECT_TIMEOUT_MS / 1000} s`)), CONNECT_TIMEOUT_MS);
      const settle = (fn) => (value) => { clearTimeout(timer); fn(value); };
      socket.on('connect_error', settle((error) => fail(new Error(`Cannot reach CNCjs on port ${httpPort}: ${error.message}`))));
      // socket.io v2 reports a handshake rejected by CNCjs's auth middleware as "error".
      socket.on('error', settle((error) => fail(new Error(
        `CNCjs rejected the connection (${error?.message ?? error}). The token is signed with the secret in ${configPath}; `
        + 'make sure that file belongs to the running server. CNCjs user accounts are not supported.'))));
      socket.on('disconnect', settle((reason) => fail(new Error(`CNCjs closed the connection (${reason})`))));
      socket.on('startup', () => socket.emit('list'));
      socket.on('serialport:list', settle(done));
    });
    return { machine, socket, ports };
  } catch (error) {
    socket.close();
    throw error;
  }
}

function choosePort(ports, command) {
  if (ports.length === 0) throw new Error('CNCjs lists no serial ports.');
  const names = ports.map((p) => `${p.port}${p.inuse ? ' (open)' : ''}`).join(', ');
  if (opts.serial) {
    const port = ports.find((p) => p.port.toLowerCase() === opts.serial.toLowerCase());
    if (!port) throw new Error(`Serial port ${opts.serial} not found. Ports: ${names}`);
    if (command !== 'open' && !port.inuse) throw new Error(`${port.port} is not open in CNCjs. Open it in CNCjs or run "open" (resets the controller).`);
    return port;
  }
  const open = ports.filter((p) => p.inuse);
  if (open.length > 1) throw new Error(`Several ports are open (${names}); pick one with --serial.`);
  if (open.length === 1) return open[0];
  if (command !== 'open') throw new Error(`No serial port is open in CNCjs (ports: ${names}). Open it in CNCjs or run "open" (resets the controller).`);
  if (ports.length === 1) return ports[0];
  throw new Error(`Several serial ports (${names}); pick one with --serial.`);
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
    await new Promise((done, fail) => machine.on((event) => { if (event.kind === 'disconnect') fail(event.error); }));
  },

  async send(machine, args) {
    if (args.length === 0) throw new Error('send needs at least one line');
    if (args.some((line) => /^\$limits/i.test(line))) throw new Error('Use the "limits" command; $Limits loops until "!".');
    if (args.some((line) => /^\$H[XYZABC]*$/i.test(line))) throw new Error('Use the "home" command; $H runs longer than send waits.');
    // During a CNCjs program run, CNCjs consumes every ok for its own sender, so replies cannot be matched.
    if (args.some((line) => !isRealtime(line))) requireState(machine, ['Idle', 'Alarm', 'Jog', 'Check', 'Sleep'], 'Wait for the program to finish.');
    machine.printEvents();
    for (const line of args) {
      console.log(`> ${JSON.stringify(line).slice(1, -1)}`);
      if (isRealtime(line)) { machine.write(line); continue; }
      await machine.send(line);
    }
    await sleep(300);
    if (args.includes('?')) console.log(formatStatus(machine.status));
  },

  async unlock(machine) {
    machine.printEvents();
    await machine.send('$X');
    await sleep(500);
    console.log(formatStatus(machine.status));
  },

  async home(machine, args) {
    const axes = args.join('').toUpperCase();
    if (!/^[XYZABC]*$/.test(axes)) throw new Error(`Bad axes "${args.join(' ')}"; use e.g. "home", "home y" or "home x y"`);
    requireState(machine, ['Idle', 'Alarm']);
    const start = machine.status;
    machine.printEvents();
    interruptAction = () => { console.log('Interrupted: resetting controller'); machine.write('\x18'); };
    console.log(`> $H${axes}`);
    await machine.send(`$H${axes}`, 180000);
    await machine.waitMotionDone(start, 10000);
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
    requireState(machine, ['Idle', 'Alarm']);
    let last = '';
    let replyState = 'pending';
    let looping = false;
    let markSampling;
    const sampling = new Promise((done) => { markSampling = done; });
    const reply = machine.send('$Limits', (seconds + 5) * 1000);
    const replyDone = reply.then(() => { replyState = 'ok'; return 'ended'; }, (error) => { replyState = 'failed'; return error; });
    const off = machine.on((event) => {
      if (event.kind !== 'read') return;
      if (!event.line.startsWith(':')) {
        if (!QUIET_READ.test(event.line)) console.log(event.line);
        return;
      }
      looping = true;
      markSampling();
      const decoded = decodeLimits(event.line);
      if (decoded === last) return;
      last = decoded;
      console.log(decoded);
    });
    // "!" ends the loop, but outside it is a real feed hold: send it only while the loop is still running.
    const endLoop = () => { if (looping && replyState === 'pending') machine.write('!'); };
    interruptAction = endLoop;
    try {
      const first = await Promise.race([sampling.then(() => 'sampling'), replyDone, sleep(2000).then(() => 'silent')]);
      if (first instanceof Error) throw first;
      if (first === 'ended') throw new Error('$Limits ended before sampling (another client sent "!"?).');
      if (first === 'silent') throw new Error('No $Limits samples within 2 s; this controller may not support $Limits (FluidNC only). If it is looping silently, end it with: send "!"');
      await Promise.race([sleep(seconds * 1000), replyDone]);
      endLoop();
      await reply;
    } finally {
      off();
    }
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

async function openPort(machine, socket, port) {
  if (port.inuse) {
    await join(machine, socket, port.port);
    console.log(`${port.port} is already open.`);
    return;
  }
  const baudrate = Number(opts.baud);
  if (!Number.isInteger(baudrate) || baudrate <= 0) throw new Error('--baud must be a positive integer.');
  console.log(`Opening ${port.port}; this resets ESP32 controllers.`);
  machine.printEvents();
  await join(machine, socket, port.port, { controllerType: 'Grbl', baudrate });
  await sleep(7000);
  console.log(formatStatus(machine.status));
}

async function main() {
  const parsed = parseArgs({ allowPositionals: true, options: {
    in: { type: 'boolean' },
    feed: { type: 'string' },
    serial: { type: 'string' },
    baud: { type: 'string', default: '115200' },
    mode: { type: 'string', default: 'machine' },
    port: { type: 'string' },
    verbose: { type: 'boolean', short: 'v' },
    help: { type: 'boolean', short: 'h' },
  } });
  opts = parsed.values;
  const [command, ...args] = parsed.positionals;
  if (opts.help || !command) {
    console.log(USAGE);
    return;
  }
  if (!['machine', 'simulator'].includes(opts.mode)) throw new Error('--mode must be machine or simulator.');
  if (opts.port !== undefined && (!/^\d+$/.test(opts.port) || +opts.port < 1 || +opts.port > 65535)) throw new Error('--port must be an integer from 1 to 65535.');
  if (command !== 'open' && !commands[command]) throw new Error(`Unknown command "${command}". Run with --help.`);
  const { machine, socket, ports } = await connect();
  try {
    const port = choosePort(ports, command);
    if (command === 'open') {
      await openPort(machine, socket, port);
      return;
    }
    await join(machine, socket, port.port);
    await sleep(300);
    await commands[command](machine, args);
  } finally {
    socket.close();
  }
}

main().then(() => process.exit(0), (error) => {
  console.error(`Error: ${error.message}${error.code?.startsWith('ERR_PARSE_ARGS') ? ' Run with --help.' : ''}`);
  process.exit(1);
});
