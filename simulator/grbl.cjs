'use strict';

const MAX_AXIS_RATES = [3000, 3000, 1000];
const MAX_SPINDLE_RPM = 1000;
// Stock GRBL 1.1 byte assignments and override limits:
// https://github.com/gnea/grbl/blob/bfb67f0c7963fe3ce4aaf8a97f9009ea5a8db36e/grbl/config.h
const OVERRIDE_COMMANDS = new Map([
  [0x90, ['feedOverride', 'set', 100]], [0x91, ['feedOverride', 'add', 10]],
  [0x92, ['feedOverride', 'add', -10]], [0x93, ['feedOverride', 'add', 1]],
  [0x94, ['feedOverride', 'add', -1]],
  [0x95, ['rapidOverride', 'set', 100]], [0x96, ['rapidOverride', 'set', 50]],
  [0x97, ['rapidOverride', 'set', 25]],
  [0x99, ['spindleOverride', 'set', 100]], [0x9a, ['spindleOverride', 'add', 10]],
  [0x9b, ['spindleOverride', 'add', -10]], [0x9c, ['spindleOverride', 'add', 1]],
  [0x9d, ['spindleOverride', 'add', -1]],
]);

// A deliberately limited GRBL 1.1 protocol simulator, not a machining verifier.
class GrblSimulator {
  constructor(send) {
    this.send = send;
    this.position = [0, 0, 0];
    this.offset = [0, 0, 0];
    this.buffer = '';
    this.inputState = 'collecting';
    this.reset();
  }

  reset() {
    this.motion = null;
    this.queue = [];
    this.pendingCommands = [];
    this.commandState = 'ready';
    this.state = 'Idle';
    this.units = 'G21';
    this.distance = 'G90';
    this.mode = 'G0';
    this.feed = 100;
    this.spindle = 0;
    this.spindleMode = 'M5';
    this.feedOverride = 100;
    this.rapidOverride = 100;
    this.spindleOverride = 100;
    this.buffer = '';
    this.inputState = 'collecting';
    this.send("Grbl 1.1h ['$' for help]");
  }

  status() {
    const feed = this.state === 'Run' || this.state === 'Jog' ? this.motionFeed() : 0;
    const spindle = this.spindleMode === 'M5' ? 0 : Math.min(MAX_SPINDLE_RPM, this.spindle * this.spindleOverride / 100);
    this.send(`<${this.state}|MPos:${this.position.map(n => n.toFixed(3)).join(',')}|WCO:${this.offset.map(n => n.toFixed(3)).join(',')}|FS:${feed},${spindle}|Ov:${this.feedOverride},${this.rapidOverride},${this.spindleOverride}>`);
  }

  motionFeed() {
    if (!this.motion || this.motion.kind === 'Idle') return 0;
    if (this.motion.rateMode === 'rapid') return this.motion.rapidRate * this.rapidOverride / 100;
    // GRBL jog.c sets PL_COND_FLAG_NO_FEED_OVERRIDE for every jog block.
    // https://github.com/gnea/grbl/blob/bfb67f0c7963fe3ce4aaf8a97f9009ea5a8db36e/grbl/jog.c#L30
    const override = this.motion.kind === 'Jog' ? 100 : this.feedOverride;
    return Math.min(this.motion.rapidRate, this.motion.feed * override / 100);
  }

  input(data) {
    for (const byte of Buffer.from(data)) this.byte(byte);
  }

  cancelJog() {
    if (this.motion?.kind !== 'Jog') return;
    this.motion = null;
    this.queue = [];
    this.pendingCommands = [];
    this.commandState = 'ready';
    this.state = 'Idle';
  }

  byte(byte) {
    if (byte === 0x18) return this.reset();
    if (byte === 0x3f) return this.status();
    // GRBL protocol.c: a hold cancels jogging, but Idle enters Hold:0.
    // https://github.com/gnea/grbl/blob/bfb67f0c7963fe3ce4aaf8a97f9009ea5a8db36e/grbl/protocol.c#L257-L288
    if (byte === 0x21) {
      if (this.state === 'Alarm') return;
      if (this.motion?.kind === 'Jog') return this.cancelJog();
      this.state = 'Hold:0';
      return;
    }
    if (byte === 0x7e) { if (this.state.startsWith('Hold')) this.state = this.motion?.kind || 'Idle'; return; }
    if (byte === 0x85) return this.cancelJog();
    const override = OVERRIDE_COMMANDS.get(byte);
    if (override) {
      const [field, operation, value] = override;
      this[field] = operation === 'set' ? value : Math.min(200, Math.max(10, this[field] + value));
      return;
    }
    if (byte >= 0x80) return; // Other extended realtime commands are not modeled.
    if (byte === 10 || byte === 13) {
      if (this.inputState === 'overflow') { this.inputState = 'collecting'; return; }
      if (!this.buffer) return;
      const line = this.buffer;
      this.buffer = '';
      return this.command(line);
    }
    if (this.inputState === 'overflow') return;
    if (this.buffer.length >= 256) { this.buffer = ''; this.inputState = 'overflow'; this.send('error:11'); return; }
    this.buffer += String.fromCharCode(byte);
  }

  command(raw) {
    if (this.commandState !== 'ready') { this.pendingCommands.push(raw); return; }
    const line = raw.replace(/\([^)]*\)/g, '').replace(/;.*$/, '').replace(/\s/g, '').toUpperCase();
    const ok = () => this.send('ok');
    const error = code => this.send(`error:${code}`);
    if (!line) return ok();
    if (line === '$') { this.send('[HLP:$$ $# $G $I $H $X $J= ~ ! ? ctrl-x]'); return ok(); }
    if (line === '$I') { this.send('[VER:1.1h:MANUAL-MILL-SIMULATOR]'); this.send('[OPT:V,15,128]'); return ok(); }
    if (line === '$$') {
      for (const [key, value] of Object.entries({ 0: 10, 1: 25, 10: 1, 13: 0, 20: 0, 21: 0, 22: 0, 30: MAX_SPINDLE_RPM, 31: 0, 32: 0, 100: 250, 101: 250, 102: 250, 110: MAX_AXIS_RATES[0], 111: MAX_AXIS_RATES[1], 112: MAX_AXIS_RATES[2], 120: 100, 121: 100, 122: 100, 130: 300, 131: 300, 132: 100 })) this.send(`$${key}=${value}`);
      return ok();
    }
    if (line === '$G') { this.send(`[GC:${this.mode} G54 G17 ${this.units} ${this.distance} G94 ${this.spindleMode} M9 T0 F${this.feed} S${this.spindle}]`); return ok(); }
    if (line === '$#') {
      for (const name of ['G54', 'G55', 'G56', 'G57', 'G58', 'G59', 'G28', 'G30', 'G92']) this.send(`[${name}:${(name === 'G54' ? this.offset : [0, 0, 0]).map(n => n.toFixed(3)).join(',')}]`);
      this.send('[TLO:0.000]'); this.send('[PRB:0.000,0.000,0.000:0]'); return ok();
    }
    if (line === '$X') { if (this.state === 'Alarm') this.state = 'Idle'; return ok(); }
    if (line === '$H') {
      if (this.motion) return error(8);
      this.position = [0, 0, 0]; return ok();
    }
    const kind = line.startsWith('$J=') ? 'Jog' : 'Run';
    if (line.startsWith('$') && kind !== 'Jog') return error(3);
    // protocol.c allows normal G-code while held; system.c restricts $J to Idle/Jog.
    if (kind === 'Jog' && !['Idle', 'Jog'].includes(this.state)) return error(8);
    if (kind === 'Run' && ['Alarm', 'Jog'].includes(this.state)) return error(9);
    if (this.queue.length >= 15) return this.defer(raw, 'planner-full');
    const source = kind === 'Jog' ? line.slice(3) : line;
    const words = [...source.matchAll(/([A-Z])([-+]?(?:\d+(?:\.\d*)?|\.\d+))/g)];
    if (words.map(m => m[0]).join('') !== source) return error(2);
    const codes = words.filter(m => 'GM'.includes(m[1])).map(m => m[1] + Number(m[2]));
    if (codes.some(c => !['G0', 'G1', 'G4', 'G10', 'G17', 'G20', 'G21', 'G40', 'G49', 'G53', 'G54', 'G80', 'G90', 'G91', 'G94', 'M3', 'M4', 'M5', 'M8', 'M9'].includes(c))) return error(20);
    if (words.some(m => !'GMXYZFSLPN'.includes(m[1]))) return error(20);
    if (kind === 'Jog' && codes.some(c => !['G20', 'G21', 'G90', 'G91', 'G53'].includes(c))) return error(20);
    const letters = words.filter(m => !'GM'.includes(m[1])).map(m => m[1]);
    if (new Set(letters).size !== letters.length) return error(25);
    for (const group of [['G0', 'G1', 'G80'], ['G20', 'G21'], ['G90', 'G91'], ['M3', 'M4', 'M5']]) {
      if (codes.filter(c => group.includes(c)).length > 1) return error(21);
    }
    const values = Object.fromEntries(words.map(m => [m[1], Number(m[2])]));
    const previous = this.queue.at(-1)?.target || this.motion?.target || this.position;
    if (codes.includes('G4')) {
      // Limited standalone dwell, including CNCjs's trailing G4P0.5 barrier.
      // GRBL mc_dwell synchronizes the planner and completes before its line ACK.
      if (codes.length !== 1 || words.some(m => !'GPN'.includes(m[1]))) return error(20);
      if (values.P === undefined) return error(28);
      if (!Number.isFinite(values.P) || values.P < 0) return error(4);
      this.queue.push({ target: previous, dwellSeconds: values.P, kind: 'Idle' });
      this.commandState = 'dwelling';
      this.next();
      return;
    }
    const units = codes.find(c => c === 'G20' || c === 'G21') || this.units;
    const distance = codes.find(c => c === 'G90' || c === 'G91') || this.distance;
    const scale = units === 'G20' ? 25.4 : 1;
    const feed = values.F === undefined ? this.feed : values.F * scale;
    if (!Number.isFinite(feed) || feed <= 0) return error(22);
    if (kind === 'Jog' && values.F === undefined) return error(22);
    const axes = ['X', 'Y', 'Z'];
    if (codes.includes('G53') && distance !== 'G90') return error(30);
    if (codes.includes('G80') && axes.some(axis => values[axis] !== undefined)) return error(31);
    if (this.motion && this.motion.kind !== kind) return error(8);
    if (values.S !== undefined && values.S < 0) return error(4);
    if (codes.includes('G10')) {
      if (values.L !== 20 || values.P !== 1) return error(20);
      if (this.motion || this.queue.length) return this.defer(raw, 'synchronizing');
      axes.forEach((axis, i) => { if (values[axis] !== undefined) this.offset[i] = this.position[i] - values[axis] * scale; });
    }
    const mode = codes.find(c => c === 'G0' || c === 'G1') || this.mode;
    if (kind === 'Run') {
      this.units = units; this.distance = distance; this.mode = mode; this.feed = feed;
      this.spindleMode = codes.find(c => c === 'M3' || c === 'M4' || c === 'M5') || this.spindleMode;
      if (values.S !== undefined) this.spindle = values.S;
    }
    if (codes.includes('G10')) return ok();
    if (!axes.some(axis => values[axis] !== undefined)) return ok();
    const target = axes.map((axis, i) => {
      if (values[axis] === undefined) return previous[i];
      if (distance === 'G91') return previous[i] + values[axis] * scale;
      return values[axis] * scale + (codes.includes('G53') ? 0 : this.offset[i]);
    });
    if (target.some(n => !Number.isFinite(n))) return error(2);
    const delta = target.map((n, i) => n - previous[i]);
    const length = Math.hypot(...delta);
    const rapidRate = length === 0 ? Math.max(...MAX_AXIS_RATES)
      : Math.min(...delta.map((n, i) => n === 0 ? Infinity : MAX_AXIS_RATES[i] * length / Math.abs(n)));
    this.queue.push({ target, feed, rapidRate, rateMode: kind === 'Run' && mode === 'G0' ? 'rapid' : 'feed', kind });
    this.next();
    ok();
  }

  next() {
    if (this.motion || !this.queue.length) return;
    this.motion = this.queue.shift();
    if (!this.state.startsWith('Hold')) this.state = this.motion.kind;
  }

  defer(raw, reason) {
    this.commandState = reason;
    this.pendingCommands.unshift(raw);
  }

  resumeCommands() {
    if (this.commandState === 'planner-full' && this.queue.length < 15) this.commandState = 'ready';
    if (this.commandState === 'synchronizing' && !this.motion && !this.queue.length) this.commandState = 'ready';
    while (this.pendingCommands.length && this.commandState === 'ready') this.command(this.pendingCommands.shift());
  }

  completeMotion(acknowledgment = 'none') {
    this.motion = null;
    this.state = 'Idle';
    if (acknowledgment === 'send') { this.commandState = 'ready'; this.send('ok'); }
    this.next();
    this.resumeCommands();
  }

  advanceDwell(seconds) {
    if (seconds < this.motion.dwellSeconds) { this.motion.dwellSeconds -= seconds; return null; }
    const remaining = seconds - this.motion.dwellSeconds;
    this.completeMotion('send');
    return remaining;
  }

  advanceLinear(seconds) {
    const delta = this.motion.target.map((n, i) => n - this.position[i]);
    const duration = Math.hypot(...delta) / (this.motionFeed() / 60);
    if (seconds < duration) {
      this.position = this.position.map((n, i) => n + delta[i] * seconds / duration);
      return null;
    }
    this.position = this.motion.target;
    this.completeMotion();
    return seconds - duration;
  }

  tick(seconds) {
    while (this.motion && !this.state.startsWith('Hold')) {
      seconds = this.motion.dwellSeconds !== undefined ? this.advanceDwell(seconds) : this.advanceLinear(seconds);
      if (seconds === null) return;
    }
  }
}

module.exports = { GrblSimulator };
