import { readFile, mkdir, access } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

async function main() {
  const { values } = parseArgs({ options: {
    mode: { type: 'string', default: 'simulator' },
    port: { type: 'string' },
    config: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) {
    console.log('Usage: node scripts/start.mjs [--mode simulator|machine] [--port 8000]');
    return;
  }
  if (!['simulator', 'machine'].includes(values.mode)) throw new Error('Mode must be simulator or machine.');
  const port = values.port ?? (values.mode === 'simulator' ? '8000' : '8001');
  if (!/^\d+$/.test(port) || +port < 1 || +port > 65535) throw new Error('Port must be an integer from 1 to 65535.');
  const configPath = resolve(root, '.runtime/install.json');
  let installed;
  try { installed = JSON.parse(await readFile(configPath, 'utf8')); }
  catch (cause) { throw new Error('Run the setup script first; .runtime/install.json could not be read.', { cause }); }
  if (installed.schemaVersion !== 1) throw new Error('Unsupported installation manifest; rerun setup.');
  await access(resolve(installed.el400.mountPath, 'index.html'));
  await access(resolve(installed.pendant.mountPath, 'widget/index.html'));
  await mkdir(resolve(root, '.runtime'), { recursive: true });
  if (values.mode === 'simulator') {
    require('../simulator/register.cjs').install();
    console.log('SIMULATION: only the SIMULATOR port is available. No physical serial ports can be opened.');
  }
  console.log(`CNCjs ${values.mode}: http://localhost:${port}`);
  console.log('Widgets: /whb04b/widget/index.html and /el400/?source=cncjs');
  console.log('Select Grbl and open the desired port in CNCjs. Ctrl+C stops the server.');
  process.argv = [process.execPath, require.resolve('cncjs'),
    '--host', '127.0.0.1', '--port', port,
    '--config', values.config ? resolve(values.config) : resolve(root, `.runtime/cncjs-${values.mode}.json`),
    '--mount', `/el400:${installed.el400.mountPath}`,
    '--mount', `/whb04b:${installed.pendant.mountPath}`,
  ];
  await require('cncjs')();
}

main().catch((error) => {
  console.error(`Startup failed: ${error.message}`);
  process.exitCode = 1;
});
