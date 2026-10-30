import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtime = path.join(root, '.runtime');
const sources = {
  el400: {
    repository: 'https://github.com/pedropaulovc/el400.git',
    revision: 'b374f49d6f01cfd5c0aac5ccde70ba8e98dd531d',
    directory: path.join(runtime, 'el400'),
  },
  pendant: {
    repository: 'https://github.com/pedropaulovc/cncjs-pendant-whb04b-6.git',
    revision: '34780994e8bd0b5060ffb630f03b208a80fb66eb',
    directory: path.join(runtime, 'pendant'),
  },
};

function run(command, args, cwd = root, output = 'inherit') {
  const result = spawnSync(command, args, { cwd, stdio: output, encoding: 'utf8' });
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

function checkout(source) {
  const { repository, revision, directory } = source;
  if (!existsSync(directory)) {
    run('git', ['clone', repository, directory]);
    run('git', ['checkout', '--detach', revision], directory);
    return;
  }
  if (!existsSync(path.join(directory, '.git'))) {
    throw new Error(`Refusing to overwrite ${directory}: it is not a managed Git checkout.`);
  }
  const origin = run('git', ['remote', 'get-url', 'origin'], directory, 'pipe');
  if (origin !== repository) throw new Error(`Unexpected origin in ${directory}: ${origin}`);
  const status = run('git', ['status', '--porcelain', '--untracked-files=normal'], directory, 'pipe');
  if (status) throw new Error(`Local changes exist in ${directory}. Save them before rerunning setup.`);
  const current = run('git', ['rev-parse', 'HEAD'], directory, 'pipe');
  if (current === revision) return;
  run('git', ['fetch', 'origin', revision], directory);
  run('git', ['checkout', '--detach', revision], directory);
}

try {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 12)) {
    throw new Error('Node.js 22.12 or newer is required. Install a current Node.js LTS release with npm.');
  }
  console.log(`Setting up CNCjs manual milling integration in ${root}`);
  run('git', ['--version']);
  const npm = npmCli();
  run(process.execPath, [npm, '--version']);
  if (!existsSync(path.join(root, 'package-lock.json'))) {
    throw new Error('package-lock.json is missing. Use a complete checkout of this integration repository.');
  }
  run(process.execPath, [npm, 'ci']);
  mkdirSync(runtime, { recursive: true });
  for (const source of Object.values(sources)) checkout(source);
  run(process.execPath, [npm, 'ci'], sources.el400.directory);
  run(process.execPath, [npm, 'run', 'build', '--', '--base=/el400/'], sources.el400.directory);
  const config = {
    schemaVersion: 1,
    cncjsVersion: JSON.parse(readFileSync(path.join(root, 'node_modules/cncjs/package.json'), 'utf8')).version,
    el400: { revision: sources.el400.revision, mountPath: path.join(sources.el400.directory, 'dist') },
    pendant: { revision: sources.pendant.revision, mountPath: path.join(sources.pendant.directory, 'web') },
  };
  for (const filename of [path.join(config.el400.mountPath, 'index.html'),
    path.join(config.pendant.mountPath, 'widget/index.html'),
    path.join(config.pendant.mountPath, 'whb04b-webhid.js')]) {
    if (!existsSync(filename)) throw new Error(`Setup output missing: ${filename}`);
  }
  const temporary = path.join(runtime, 'install.json.tmp');
  writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`);
  renameSync(temporary, path.join(runtime, 'install.json'));
  console.log('Setup complete. Run npm start for simulation, or npm run machine for a physical controller.');
} catch (error) {
  console.error(`Setup failed: ${error.message}`);
  console.error('Prerequisites: Git and Node.js 22.12+ with npm on PATH. See README.md for Windows and Linux installation.');
  process.exitCode = 1;
}
