#!/usr/bin/env node
// Stand-in for the claude CLI. Behaviour is chosen by the FAKE_CLAUDE_MODE env var.
import { readFileSync } from 'node:fs';

const mode = process.env.FAKE_CLAUDE_MODE ?? 'ok';
const prompt = readFileSync(0, 'utf8');

if (mode === 'hang') {
  setInterval(() => {}, 1000);
} else if (mode === 'garbage') {
  process.stderr.write('boom');
  process.exit(3);
} else if (mode === 'auth') {
  process.stdout.write(JSON.stringify({ is_error: true, result: 'Failed to authenticate: run `claude auth login`' }));
} else if (mode === 'error') {
  process.stdout.write(JSON.stringify({ is_error: true, result: 'overloaded' }));
} else {
  process.stdout.write(
    JSON.stringify({ is_error: false, result: JSON.stringify({ args: process.argv.slice(2), prompt }) }),
  );
}
