#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const production = process.argv.includes('--production');
const envPath = resolve(root, '.env');
const replacements = {
  POSTGRES_PASSWORD: randomBytes(32).toString('base64url'),
  SESSION_SECRET: randomBytes(32).toString('base64url'),
  CREATION_KEY: randomBytes(32).toString('base64url'),
  LIVEKIT_API_KEY: `MP${randomBytes(12).toString('hex')}`,
  LIVEKIT_API_SECRET: randomBytes(48).toString('base64url'),
  REDIS_PASSWORD: randomBytes(32).toString('base64url'),
  RECORDING_KEK: randomBytes(32).toString('base64'),
  RECORDING_DIR: JSON.stringify(resolve(root, 'runtime/recordings')),
  LOCAL_UID: String(process.getuid?.() ?? 1000),
  LOCAL_GID: String(process.getgid?.() ?? 1000),
};

try {
  const template = await readFile(resolve(root, '.env.example'), 'utf8');
  const contents = template.replace(/__([A-Z_]+)__/g, (_, key) => {
    if (!(key in replacements)) throw new Error(`Unknown environment placeholder: ${key}`);
    return replacements[key];
  });
  await writeFile(envPath, contents, { flag: 'wx', mode: 0o600 });
  console.log('Created .env with unique secrets. Existing secrets are never overwritten.');
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.log('Kept existing .env.');
}

await chmod(envPath, 0o600);
const env = parseEnv(await readFile(envPath, 'utf8'));
for (const key of ['POSTGRES_PASSWORD', 'SESSION_SECRET', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET', 'REDIS_PASSWORD', 'RECORDING_KEK']) {
  if (!env[key] || env[key].includes('__')) throw new Error(`Set ${key} in .env before rendering configuration.`);
}
if (Buffer.from(env.RECORDING_KEK, 'base64').length !== 32) throw new Error('RECORDING_KEK must encode exactly 32 bytes.');
if (!isIP(env.LIVEKIT_NODE_IP)) throw new Error('LIVEKIT_NODE_IP must be a literal IP address.');
if (production && ['127.0.0.1', '::1', '0.0.0.0'].includes(env.LIVEKIT_NODE_IP)) {
  throw new Error('Set LIVEKIT_NODE_IP to this media host\'s reachable IP before generating a production template.');
}
for (const directory of ['runtime', 'runtime/recordings', 'runtime/recordings/raw', 'runtime/recordings/encrypted']) {
  await mkdir(resolve(root, directory), { recursive: true, mode: 0o700 });
  await chmod(resolve(root, directory), 0o700);
}
const quote = JSON.stringify;
const livekit = `# Generated from .env. Do not commit.\nport: 7880\nbind_addresses:\n  - 0.0.0.0\nrtc:\n  tcp_port: 7881\n  udp_port: 7882\n  use_external_ip: false\n  node_ip: ${quote(env.LIVEKIT_NODE_IP)}\n  advertise_internal_ip: true\n  enable_loopback_candidate: ${!production}\nredis:\n  address: redis:6379\n  password: ${quote(env.REDIS_PASSWORD)}\nkeys:\n  ${quote(env.LIVEKIT_API_KEY)}: ${quote(env.LIVEKIT_API_SECRET)}\nlogging:\n  level: warn\n`;
const configPath = resolve(root, `runtime/livekit${production ? '.production' : ''}.yaml`);
await writeFile(configPath, livekit, { mode: 0o600 });
await chmod(configPath, 0o600);
console.log(`Rendered ${production ? 'production' : 'local'} LiveKit configuration. No secrets were printed.`);
if (production) console.log('This renders configuration only. Complete docs/security-controls.md gates before external use.');
