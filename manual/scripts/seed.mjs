#!/usr/bin/env node
// Starts the manual's local demo instance (manual/demo/server.ts) and seeds it (manual/demo/seed.ts + events.ts).
//   npm run manual:seed            → http://127.0.0.1:3199 (PORT=… to change); log in manual/reports/demo-server.log
// The demo runs the real git-sync code on a throwaway in-memory database. Its demo data (workspace acme, project WEB,
// repo acme/website, users Alex/Sam/Jordan/Riley) lives only in that process: stopping the server undoes everything.
// It never writes to a real Plane, a real GitHub repository or any Plane container. See manual/notes/demo-data.md.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '../..');
execFileSync('sh', [resolve(root, 'manual/demo/restart.sh')], { stdio: 'inherit', env: { ...process.env, LOG: process.env.LOG ?? resolve(root, 'manual/reports/demo-server.log') } });
console.log(`demo instance running on 127.0.0.1:${process.env.PORT ?? 3199}; open it with Chromium --host-resolver-rules="MAP plane.example.com:80 127.0.0.1:${process.env.PORT ?? 3199}" and a session-id cookie (admin|alex|sam|riley) or admin-session-id=god.`);
