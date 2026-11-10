import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtime = path.join(root, '.runtime');

const childEnv = { ...process.env };
if (Object.keys(childEnv).some(key => key.toLowerCase() === 'npm_lifecycle_event' && childEnv[key])) {
  // npm run exports .npmrc's allow-scripts as a CLI-like environment option,
  // which child npm rejects for project installs. Let each child npm read the
  // canonical project/user approval configuration instead; retain every other
  // environment setting, including authentication and config-file locations.
  for (const key of Object.keys(childEnv)) {
    if (key.toLowerCase() === 'npm_config_allow_scripts') delete childEnv[key];
  }
}

function run(command, args, cwd = root, output = 'inherit') {
  const result = spawnSync(command, args, { cwd, stdio: output, encoding: 'utf8', env: childEnv });
  if (result.error) throw new Error(`${command}: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.status}). ${result.stderr || ''}`);
  }
  return (result.stdout || '').trim();
}

function npmCli() {
  // Invoke npm through Node rather than a command shell, including on Windows.
  const candidates = [
    path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'),
    process.env.npm_execpath,
  ].filter(Boolean);
  const lookup = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which',
    [process.platform === 'win32' ? 'npm.cmd' : 'npm'], { encoding: 'utf8' });
  for (const executable of (lookup.stdout || '').trim().split(/\r?\n/).filter(Boolean)) {
    candidates.push(path.join(path.dirname(executable), 'node_modules/npm/bin/npm-cli.js'));
    if (process.platform !== 'win32') candidates.push(executable);
  }
  const candidate = candidates.find(existsSync);
  if (!candidate) throw new Error('npm was not found. Install Node.js with npm, then run setup again.');
  return candidate;
}

try {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 12)) {
    throw new Error('Node.js 22.12 or newer is required. Install a current Node.js LTS release with npm.');
  }
  console.log(`Setting up CNCjs manual milling integration in ${root}`);
  const npm = npmCli();
  run(process.execPath, [npm, '--version']);
  if (!existsSync(path.join(root, 'package-lock.json'))) {
    throw new Error('package-lock.json is missing. Use a complete checkout of this integration repository.');
  }
  run(process.execPath, [npm, 'ci']);
  mkdirSync(runtime, { recursive: true });
  const require = createRequire(import.meta.url);
  const el400PackagePath = require.resolve('el400/package.json');
  const el400Package = JSON.parse(readFileSync(el400PackagePath, 'utf8'));
  const pendantPackagePath = require.resolve('cncjs-pendant-whb04b-6/package.json');
  const pendantPackage = JSON.parse(readFileSync(pendantPackagePath, 'utf8'));
  const conversationalPackagePath = require.resolve('cncjs-conversational/package.json');
  const conversationalPackage = JSON.parse(readFileSync(conversationalPackagePath, 'utf8'));
  const config = {
    schemaVersion: 4,
    cncjsVersion: JSON.parse(readFileSync(path.join(root, 'node_modules/cncjs/package.json'), 'utf8')).version,
    el400: { version: el400Package.version, mountPath: path.join(path.dirname(el400PackagePath), 'web') },
    pendant: { version: pendantPackage.version, mountPath: path.join(path.dirname(pendantPackagePath), 'web') },
    conversational: { version: conversationalPackage.version, mountPath: path.join(path.dirname(conversationalPackagePath), 'web') },
  };
  for (const filename of [path.join(config.el400.mountPath, 'index.html'),
    path.join(config.conversational.mountPath, 'index.html'),
    path.join(config.pendant.mountPath, 'widget/index.html'),
    path.join(config.pendant.mountPath, 'widget/whb04b-widget.js'),
    path.join(config.pendant.mountPath, 'widget/cncjs-session.js'),
    path.join(config.pendant.mountPath, 'widget/grbl.js'),
    path.join(config.pendant.mountPath, 'widget/pendant-controls.js'),
    path.join(config.pendant.mountPath, 'widget/pendant-display.js'),
    path.join(config.pendant.mountPath, 'whb04b-webhid.js')]) {
    if (!existsSync(filename)) throw new Error(`Setup output missing: ${filename}`);
  }
  const temporary = path.join(runtime, 'install.json.tmp');
  writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`);
  renameSync(temporary, path.join(runtime, 'install.json'));
  console.log('Setup complete. Run npm start for simulation, or npm run machine for a physical controller.');
} catch (error) {
  console.error(`Setup failed: ${error.message}`);
  console.error('Prerequisites: Node.js 22.12+ with npm on PATH. See README.md for Windows and Linux installation.');
  process.exitCode = 1;
}
