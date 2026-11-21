'use strict';

const MAX_AXIS_RATES = [3000, 3000, 1000];
const MAX_SPINDLE_RPM = 1000;
const COOLANT_CODES = { off: 'M9', mist: 'M7', flood: 'M8', both: 'M7 M8' };
const COOLANT_ACCESSORIES = { off: '', mist: 'M', flood: 'F', both: 'FM' };
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
const WORK_COORDINATE_SYSTEMS = ['G54', 'G55', 'G56', 'G57', 'G58', 'G59'];
// FluidNC 4.1.1 MotionControl.cpp mc_probe_cycle: G38.2/.4 alarm on a miss,
// G38.3/.5 report it; .4/.5 stop when contact is lost instead of made.
// https://github.com/bdring/FluidNC/blob/v4.1.1/FluidNC/src/MotionControl.cpp#L333-L422
const PROBE_CYCLES = {
  'G38.2': { direction: 'toward', miss: 'alarm' },
  'G38.3': { direction: 'toward', miss: 'report' },
  'G38.4': { direction: 'away', miss: 'alarm' },
  'G38.5': { direction: 'away', miss: 'report' },
};
const MOTION_MODES = ['G0', 'G1', 'G80', ...Object.keys(PROBE_CYCLES)];
// FluidNC 4.1.1 Protocol.cpp alarm names, reported as "[MSG:INFO: ALARM: name]" then "ALARM:n".
const ALARMS = { 4: 'Probe Fail Initial', 5: 'Probe Fail Contact' };
// Contact tolerance, in mm, absorbs floating-point error at a computed contact point.
const CONTACT_TOLERANCE = 1e-7;
// An away cycle stops just past the surface, where the switch has opened.
const RELEASE_TRAVEL = 1e-6;
const DEFAULT_TOOLSETTER_SIZE = 10;
const format = position => position.map(n => n.toFixed(3)).join(',');

// Inputs are boxes in machine coordinates with an unbounded bottom: the probe
// tip touches one when it is inside or on the box. `null` disables an input.
function inside(box, point) {
  return point.every((n, i) => n >= box.min[i] - CONTACT_TOLERANCE && n <= box.max[i] + CONTACT_TOLERANCE);
}

// The parameter interval [enter, exit] where start + t * delta is in the box, t >= 0.
function crossing(box, start, delta) {
  let enter = 0;
  let exit = Infinity;
  for (let i = 0; i < 3; i++) {
    if (delta[i] === 0) {
      if (start[i] < box.min[i] - CONTACT_TOLERANCE || start[i] > box.max[i] + CONTACT_TOLERANCE) return null;
      continue;
    }
    const a = (box.min[i] - start[i]) / delta[i];
    const b = (box.max[i] - start[i]) / delta[i];
    enter = Math.max(enter, Math.min(a, b));
    exit = Math.min(exit, Math.max(a, b));
  }
  if (enter > exit) return null;
  return { enter, exit };
}

// "$SIM/probe=xmin,xmax,ymin,ymax,ztop" or "$SIM/toolsetter=x,y,ztop[,size]"; "off" disables.
function parseInput(name, text) {
  if (text === 'OFF') return null;
  const numbers = text.split(',').map(Number);
  if (numbers.some(n => !Number.isFinite(n))) return undefined;
  if (name === 'PROBE') {
    if (numbers.length !== 5) return undefined;
    const [xMin, xMax, yMin, yMax, top] = numbers;
    if (xMin > xMax || yMin > yMax) return undefined;
    return { min: [xMin, yMin, -Infinity], max: [xMax, yMax, top] };
  }
  if (numbers.length !== 3 && numbers.length !== 4) return undefined;
  const [x, y, top, size = DEFAULT_TOOLSETTER_SIZE] = numbers;
  if (size <= 0) return undefined;
  return { min: [x - size / 2, y - size / 2, -Infinity], max: [x + size / 2, y + size / 2, top] };
}

function describeInput(name, box) {
  if (!box) return 'OFF';
  if (name === 'PROBE') return format([box.min[0], box.max[0], box.min[1], box.max[1], box.max[2]]);
  return format([(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, box.max[2], box.max[0] - box.min[0]]);
}

// A deliberately limited GRBL 1.1 protocol simulator, not a machining verifier.
class GrblSimulator {
  constructor(send) {
    this.send = send;
    this.position = [0, 0, 0];
    this.offsets = WORK_COORDINATE_SYSTEMS.map(() => [0, 0, 0]);
    this.probeReport = { position: [0, 0, 0], result: 'missed' };
    // Virtual inputs, reported as FluidNC's Pn:P (probe) and Pn:T (toolsetter).
    this.inputBoxes = { PROBE: null, TOOLSETTER: null };
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
    this.wcs = 0;
    this.toolLengthOffset = 0;
    this.feed = 100;
    this.spindle = 0;
    this.spindleMode = 'M5';
    this.coolantMode = 'off';
    this.feedOverride = 100;
    this.rapidOverride = 100;
    this.spindleOverride = 100;
    this.buffer = '';
    this.inputState = 'collecting';
    this.send("Grbl 1.1h ['$' for help]");
  }

  // The active work coordinate offset, including the Z tool length offset.
  get offset() {
    return this.offsets[this.wcs].map((n, i) => i === 2 ? n + this.toolLengthOffset : n);
  }

  // FluidNC Report.cpp order: probe 'P' first, then toolsetter 'T'.
  inputs() {
    return (this.inputBoxes.PROBE && inside(this.inputBoxes.PROBE, this.position) ? 'P' : '')
      + (this.inputBoxes.TOOLSETTER && inside(this.inputBoxes.TOOLSETTER, this.position) ? 'T' : '');
  }

  status() {
    const feed = this.state === 'Run' || this.state === 'Jog' ? this.motionFeed() : 0;
    const spindle = this.spindleMode === 'M5' ? 0 : Math.min(MAX_SPINDLE_RPM, this.spindle * this.spindleOverride / 100);
    const spindleAccessory = spindle === 0 ? '' : this.spindleMode === 'M3' ? 'S' : 'C';
    const accessories = spindleAccessory + COOLANT_ACCESSORIES[this.coolantMode];
    const pins = this.inputs();
    this.send(`<${this.state}|MPos:${format(this.position)}|WCO:${format(this.offset)}|FS:${feed},${spindle}${pins ? '|Pn:' + pins : ''}|Ov:${this.feedOverride},${this.rapidOverride},${this.spindleOverride}${accessories ? '|A:' + accessories : ''}>`);
  }

  alarm(code) {
    this.send(`[MSG:INFO: ALARM: ${ALARMS[code]}]`);
    this.send(`ALARM:${code}`);
    this.state = 'Alarm';
  }

  simulatorCommand(line) {
    const match = /^\$SIM\/(PROBE|TOOLSETTER)(?:=(.+))?$/.exec(line);
    if (!match) return this.send('error:3');
    const [, name, value] = match;
    if (value !== undefined) {
      const box = parseInput(name, value);
      if (box === undefined) return this.send('error:3');
      this.inputBoxes[name] = box;
    }
    this.send(`[SIM/${name}:${describeInput(name, this.inputBoxes[name])}]`);
    this.send('ok');
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
    if (byte === 0xa0 || byte === 0xa1) {
      if (!['Idle', 'Run', 'Jog'].includes(this.state) && !this.state.startsWith('Hold')) return;
      const transitions = byte === 0xa0
        ? { off: 'flood', flood: 'off', mist: 'both', both: 'mist' }
        : { off: 'mist', mist: 'off', flood: 'both', both: 'flood' };
      this.coolantMode = transitions[this.coolantMode];
      return;
    }
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
    if (line === '$I') { this.send('[VER:1.1h:MANUAL-MILL-SIMULATOR]'); this.send('[OPT:VM,15,128]'); return ok(); }
    if (line === '$$') {
      for (const [key, value] of Object.entries({ 0: 10, 1: 25, 10: 1, 13: 0, 20: 0, 21: 0, 22: 0, 30: MAX_SPINDLE_RPM, 31: 0, 32: 0, 100: 250, 101: 250, 102: 250, 110: MAX_AXIS_RATES[0], 111: MAX_AXIS_RATES[1], 112: MAX_AXIS_RATES[2], 120: 100, 121: 100, 122: 100, 130: 300, 131: 300, 132: 100 })) this.send(`$${key}=${value}`);
      return ok();
    }
    if (line === '$G') { this.send(`[GC:${this.mode} ${WORK_COORDINATE_SYSTEMS[this.wcs]} G17 ${this.units} ${this.distance} G94 ${this.spindleMode} ${COOLANT_CODES[this.coolantMode]} T0 F${this.feed} S${this.spindle}]`); return ok(); }
    if (line === '$#') {
      WORK_COORDINATE_SYSTEMS.forEach((name, i) => this.send(`[${name}:${format(this.offsets[i])}]`));
      for (const name of ['G28', 'G30', 'G92']) this.send(`[${name}:0.000,0.000,0.000]`);
      this.send(`[TLO:${this.toolLengthOffset.toFixed(3)}]`);
      this.send(`[PRB:${format(this.probeReport.position)}:${this.probeReport.result === 'contact' ? 1 : 0}]`);
      return ok();
    }
    if (line === '$X') { if (this.state === 'Alarm') this.state = 'Idle'; return ok(); }
    if (line === '$H') {
      if (this.motion) return error(8);
      this.position = [0, 0, 0]; return ok();
    }
    if (line.startsWith('$SIM/')) return this.simulatorCommand(line);
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
    if (codes.some(c => ![...MOTION_MODES, ...WORK_COORDINATE_SYSTEMS, 'G4', 'G10', 'G17', 'G20', 'G21', 'G40', 'G43.1', 'G49', 'G53', 'G90', 'G91', 'G94', 'M3', 'M4', 'M5', 'M7', 'M8', 'M9'].includes(c))) return error(20);
    if (words.some(m => !'GMXYZFSLPN'.includes(m[1]))) return error(20);
    if (kind === 'Jog' && codes.some(c => !['G20', 'G21', 'G90', 'G91', 'G53'].includes(c))) return error(20);
    const letters = words.filter(m => !'GM'.includes(m[1])).map(m => m[1]);
    if (new Set(letters).size !== letters.length) return error(25);
    for (const group of [MOTION_MODES, WORK_COORDINATE_SYSTEMS, ['G43.1', 'G49'], ['G20', 'G21'], ['G90', 'G91'], ['M3', 'M4', 'M5'], ['M7', 'M8', 'M9']]) {
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
    const mode = codes.find(c => MOTION_MODES.includes(c)) || this.mode;
    if (codes.includes('G53') && distance !== 'G90') return error(30);
    if (codes.includes('G53') && kind === 'Run' && !['G0', 'G1'].includes(mode)) return error(30);
    if (codes.includes('G80') && axes.some(axis => values[axis] !== undefined)) return error(31);
    if (this.motion && this.motion.kind !== kind) return error(8);
    if (values.S !== undefined && values.S < 0) return error(4);
    const wcs = WORK_COORDINATE_SYSTEMS.indexOf(codes.find(c => WORK_COORDINATE_SYSTEMS.includes(c)) || WORK_COORDINATE_SYSTEMS[this.wcs]);
    const lengthOffset = codes.find(c => c === 'G43.1' || c === 'G49');
    // Grbl gcode.c: G43.1 takes exactly the tool length (Z) axis word.
    if (lengthOffset === 'G43.1' && (values.Z === undefined || values.X !== undefined || values.Y !== undefined)) return error(37);
    const toolLengthOffset = lengthOffset === 'G43.1' ? values.Z * scale : lengthOffset === 'G49' ? 0 : this.toolLengthOffset;
    const moves = !codes.includes('G10') && lengthOffset !== 'G43.1' && axes.some(axis => values[axis] !== undefined);
    const target = axes.map((axis, i) => {
      if (values[axis] === undefined) return previous[i];
      if (distance === 'G91') return previous[i] + values[axis] * scale;
      if (codes.includes('G53')) return values[axis] * scale;
      return values[axis] * scale + this.offsets[wcs][i] + (i === 2 ? toolLengthOffset : 0);
    });
    if (moves && target.some(n => !Number.isFinite(n))) return error(2);
    const delta = target.map((n, i) => n - previous[i]);
    const length = Math.hypot(...delta);
    const probe = kind === 'Run' && moves ? PROBE_CYCLES[mode] : undefined;
    if (probe && length === 0) return error(33);
    if (codes.includes('G10')) {
      if (values.L !== 20) return error(20);
      if (values.P === undefined) return error(28);
      if (!Number.isInteger(values.P) || values.P < 0 || values.P > 6) return error(29);
    }
    // G10 writes offsets and a probe cycle starts only after queued motion completes.
    if ((codes.includes('G10') || probe) && (this.motion || this.queue.length)) return this.defer(raw, 'synchronizing');
    if (codes.includes('G10')) {
      // L20: the current position becomes the given work coordinate (P0 = active system).
      const system = values.P === 0 ? wcs : values.P - 1;
      axes.forEach((axis, i) => {
        if (values[axis] === undefined) return;
        this.offsets[system][i] = this.position[i] - values[axis] * scale - (i === 2 ? this.toolLengthOffset : 0);
      });
    }
    if (kind === 'Run') {
      this.units = units; this.distance = distance; this.mode = mode; this.feed = feed;
      this.wcs = wcs; this.toolLengthOffset = toolLengthOffset;
      this.spindleMode = codes.find(c => c === 'M3' || c === 'M4' || c === 'M5') || this.spindleMode;
      if (values.S !== undefined) this.spindle = values.S;
      if (codes.includes('M7')) this.coolantMode = ['flood', 'both'].includes(this.coolantMode) ? 'both' : 'mist';
      if (codes.includes('M8')) this.coolantMode = ['mist', 'both'].includes(this.coolantMode) ? 'both' : 'flood';
      if (codes.includes('M9')) this.coolantMode = 'off';
    }
    if (!moves) return ok();
    const rapidRate = length === 0 ? Math.max(...MAX_AXIS_RATES)
      : Math.min(...delta.map((n, i) => n === 0 ? Infinity : MAX_AXIS_RATES[i] * length / Math.abs(n)));
    const motion = { target, feed, rapidRate, rateMode: kind === 'Run' && mode === 'G0' ? 'rapid' : 'feed', kind };
    if (probe) return this.startProbe(motion, probe);
    this.queue.push(motion);
    this.next();
    ok();
  }

  // The planner is empty here. The line's ACK waits for the cycle to finish.
  startProbe(motion, probe) {
    const touching = this.inputs() !== '';
    if (touching === (probe.direction === 'toward')) {
      this.alarm(4);
      this.send('ok');
      return;
    }
    this.queue.push({ ...motion, probe });
    this.commandState = 'probing';
    this.next();
  }

  // The fraction of the remaining move at which the probe cycle's trigger fires, if any.
  probeTrigger(delta, fraction) {
    const boxes = Object.values(this.inputBoxes).filter(Boolean);
    if (this.motion.probe.direction === 'toward') {
      const enters = boxes.map(box => crossing(box, this.position, delta)).filter(Boolean).map(span => span.enter);
      const enter = Math.min(...enters);
      return enter <= fraction ? enter : undefined;
    }
    const exits = boxes.filter(box => inside(box, this.position)).map(box => crossing(box, this.position, delta)?.exit ?? 0);
    if (!exits.length) return 0;
    const exit = Math.max(...exits) + RELEASE_TRAVEL / Math.hypot(...delta);
    return exit <= fraction ? exit : undefined;
  }

  finishProbe(outcome) {
    const { miss } = this.motion.probe;
    this.motion = null;
    this.state = 'Idle';
    if (outcome === 'contact' || miss === 'report') this.probeReport = { position: [...this.position], result: outcome };
    if (outcome === 'missed' && miss === 'alarm') {
      this.probeReport = { ...this.probeReport, result: 'missed' };
      this.alarm(5);
    }
    this.send(`[PRB:${format(this.probeReport.position)}:${this.probeReport.result === 'contact' ? 1 : 0}]`);
    this.commandState = 'ready';
    this.send('ok');
    this.resumeCommands();
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
    const fraction = duration === 0 ? 1 : Math.min(1, seconds / duration);
    const trigger = this.motion.probe ? this.probeTrigger(delta, fraction) : undefined;
    if (trigger !== undefined) {
      this.position = this.position.map((n, i) => n + delta[i] * trigger);
      this.finishProbe('contact');
      return seconds - duration * trigger;
    }
    if (seconds < duration) {
      this.position = this.position.map((n, i) => n + delta[i] * seconds / duration);
      return null;
    }
    this.position = this.motion.target;
    if (this.motion.probe) this.finishProbe('missed');
    else this.completeMotion();
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
