'use strict';

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
    this.state = 'Idle';
    this.units = 'G21';
    this.distance = 'G90';
    this.mode = 'G0';
    this.feed = 100;
    this.spindle = 0;
    this.spindleMode = 'M5';
    this.buffer = '';
    this.inputState = 'collecting';
    this.send("Grbl 1.1h ['$' for help]");
  }

  status() {
    const feed = this.state === 'Run' || this.state === 'Jog' ? this.motion?.feed || 0 : 0;
    this.send(`<${this.state}|MPos:${this.position.map(n => n.toFixed(3)).join(',')}|WCO:${this.offset.map(n => n.toFixed(3)).join(',')}|FS:${feed},${this.spindleMode === 'M5' ? 0 : this.spindle}|Ov:100,100,100>`);
  }

  input(data) {
    for (const byte of Buffer.from(data)) this.byte(byte);
  }

  byte(byte) {
    if (byte === 0x18) return this.reset();
    if (byte === 0x3f) return this.status();
    if (byte === 0x21) { if (this.motion) this.state = 'Hold:0'; return; }
    if (byte === 0x7e) { if (this.motion) this.state = this.motion.kind; return; }
    if (byte === 0x85) {
      if (this.motion?.kind !== 'Jog') return;
      this.motion = null;
      this.queue = [];
      this.state = 'Idle';
      return;
    }
    if (byte >= 0x80) return; // Extended overrides are not modeled.
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
    const line = raw.replace(/\([^)]*\)/g, '').replace(/;.*$/, '').replace(/\s/g, '').toUpperCase();
    const ok = () => this.send('ok');
    const error = code => this.send(`error:${code}`);
    if (!line) return ok();
    if (line === '$') { this.send('[HLP:$$ $# $G $I $H $X $J= ~ ! ? ctrl-x]'); return ok(); }
    if (line === '$I') { this.send('[VER:1.1h:MANUAL-MILL-SIMULATOR]'); this.send('[OPT:V,15,128]'); return ok(); }
    if (line === '$$') {
      for (const [key, value] of Object.entries({ 0: 10, 1: 25, 10: 1, 13: 0, 20: 0, 21: 0, 22: 0, 30: 1000, 31: 0, 32: 0, 100: 250, 101: 250, 102: 250, 110: 3000, 111: 3000, 112: 1000, 120: 100, 121: 100, 122: 100, 130: 300, 131: 300, 132: 100 })) this.send(`$${key}=${value}`);
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
    if (this.state.startsWith('Hold') || this.state === 'Alarm') return error(9);
    if (this.queue.length >= 15) return error(11);
    const source = kind === 'Jog' ? line.slice(3) : line;
    const words = [...source.matchAll(/([A-Z])([-+]?(?:\d+(?:\.\d*)?|\.\d+))/g)];
    if (words.map(m => m[0]).join('') !== source) return error(2);
    const codes = words.filter(m => 'GM'.includes(m[1])).map(m => m[1] + Number(m[2]));
    if (codes.some(c => !['G0', 'G1', 'G10', 'G17', 'G20', 'G21', 'G40', 'G49', 'G53', 'G54', 'G80', 'G90', 'G91', 'G94', 'M3', 'M4', 'M5', 'M8', 'M9'].includes(c))) return error(20);
    if (words.some(m => !'GMXYZFSLPN'.includes(m[1]))) return error(20);
    if (kind === 'Jog' && codes.some(c => !['G20', 'G21', 'G90', 'G91', 'G53'].includes(c))) return error(20);
    const letters = words.filter(m => !'GM'.includes(m[1])).map(m => m[1]);
    if (new Set(letters).size !== letters.length) return error(25);
    for (const group of [['G0', 'G1', 'G80'], ['G20', 'G21'], ['G90', 'G91'], ['M3', 'M4', 'M5']]) {
      if (codes.filter(c => group.includes(c)).length > 1) return error(21);
    }
    const values = Object.fromEntries(words.map(m => [m[1], Number(m[2])]));
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
      if (values.L !== 20 || values.P !== 1 || this.motion) return error(20);
      axes.forEach((axis, i) => { if (values[axis] !== undefined) this.offset[i] = this.position[i] - values[axis] * scale; });
      return ok();
    }
    const mode = codes.find(c => c === 'G0' || c === 'G1') || this.mode;
    if (kind === 'Run') {
      this.units = units; this.distance = distance; this.mode = mode; this.feed = feed;
      this.spindleMode = codes.find(c => c === 'M3' || c === 'M4' || c === 'M5') || this.spindleMode;
      if (values.S !== undefined) this.spindle = values.S;
    }
    if (!axes.some(axis => values[axis] !== undefined)) return ok();
    const previous = this.queue.at(-1)?.target || this.motion?.target || this.position;
    const target = axes.map((axis, i) => {
      if (values[axis] === undefined) return previous[i];
      if (distance === 'G91') return previous[i] + values[axis] * scale;
      return values[axis] * scale + (codes.includes('G53') ? 0 : this.offset[i]);
    });
    if (target.some(n => !Number.isFinite(n))) return error(2);
    this.queue.push({ target, feed: kind === 'Run' && mode === 'G0' ? 3000 : feed, kind });
    this.next();
    ok();
  }

  next() {
    if (this.motion || !this.queue.length) return;
    this.motion = this.queue.shift();
    this.state = this.motion.kind;
  }

  tick(seconds) {
    if (!this.motion || this.state.startsWith('Hold')) return;
    const delta = this.motion.target.map((n, i) => n - this.position[i]);
    const length = Math.hypot(...delta);
    const step = this.motion.feed / 60 * seconds;
    if (step < length) { this.position = this.position.map((n, i) => n + delta[i] * step / length); return; }
    this.position = this.motion.target;
    this.motion = null;
    this.state = 'Idle';
    this.next();
  }
}

module.exports = { GrblSimulator };
