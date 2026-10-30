'use strict';

const { createRequire } = require('node:module');
const { GrblSimulator } = require('./grbl.cjs');
const PORT = 'SIMULATOR';

// Call before loading CNCjs. Replacement is confined to this Node process.
function install() {
  const cncRequire = createRequire(require.resolve('cncjs/package.json'));
  const serialPath = cncRequire.resolve('serialport');
  const original = cncRequire('serialport');
  const { SerialPortStream } = require('@serialport/stream');
  const { MockBinding } = require('@serialport/binding-mock');
  MockBinding.reset();
  MockBinding.createPort(PORT, { manufacturer: 'GRBL simulator (no hardware)', readyData: "Grbl 1.1h ['$' for help]\r\n" });
  const binding = {
    list: () => MockBinding.list(),
    async open(options) {
      if (options.path !== PORT) throw new Error('Simulation mode cannot open physical serial ports');
      const port = await MockBinding.open(options);
      const simulator = new GrblSimulator(line => { if (port.isOpen) port.emitData(Buffer.from(line + '\r\n')); });
      let last = performance.now();
      const timer = setInterval(() => {
        const now = performance.now();
        simulator.tick((now - last) / 1000);
        last = now;
      }, 20);
      timer.unref();
      const close = port.close.bind(port);
      port.close = async () => { clearInterval(timer); return close(); };
      port.write = async data => {
        if (!port.isOpen) throw new Error('Port is closed');
        simulator.input(data);
      };
      return port;
    }
  };
  class SimulatedSerialPort extends SerialPortStream {
    static list = binding.list;
    static binding = binding;
    constructor(options, callback) { super({ ...options, binding }, callback); }
  }
  require.cache[serialPath].exports = { ...original, SerialPort: SimulatedSerialPort };
  return { port: PORT, SerialPort: SimulatedSerialPort };
}

module.exports = { install, PORT };
