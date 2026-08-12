#!/usr/bin/env node

import { spawn } from 'node:child_process';

const NEXT_PORT = process.env.PORT || '3000';
const url = `http://localhost:${NEXT_PORT}`;

console.log(`Starting Next.js dev server...`);
console.log(`Open your browser at: ${url}`);

const child = spawn('next', ['dev', '--port', NEXT_PORT], {
  stdio: ['inherit', 'pipe', 'pipe'],
  env: { ...process.env },
});

child.stdout.on('data', (chunk) => {
  process.stdout.write(chunk);
});

child.stderr.on('data', (chunk) => {
  process.stderr.write(chunk);
});

child.on('close', (code) => {
  process.exit(code ?? 0);
});

process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
