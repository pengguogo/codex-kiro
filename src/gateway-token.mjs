import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Invoked by Codex's command-backed provider auth. Only stdout carries the key.
const key = readFileSync(join(homedir(), '.config', 'codex-kiro', 'gateway-key'), 'utf8').trim();
if (!key) throw new Error('Local gateway key is empty.');
process.stdout.write(key + '\n');
