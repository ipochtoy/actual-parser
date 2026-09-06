import { spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { join } from 'node:path';

export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

// The coordinator may own a long-running cabinet child. Do not kill it on a
// watchdog timeout: wake it once, let its existing lease/deadlines control work.
// The caller persists a per-slot attempt BEFORE invoking this function.
export async function wakeCoordinator({ dryRun, repo, node = process.execPath }, {
  launch = spawn, open = openSync, close = closeSync,
} = {}) {
  if (dryRun) return { started: false, reason: 'dry-run' };
  const fd = open('/tmp/parser-watchdog-coordinator.log', 'a', 0o600);
  try {
    return await new Promise(resolve => {
      const child = launch(node, [join(repo, 'agent', 'night-cabinet-coordinator.mjs'), '--wake=watchdog'], {
        cwd: repo, detached: true, stdio: ['ignore', fd, fd],
      });
      child.once('error', error => resolve({ started: false, reason: error.message }));
      child.once('spawn', () => {
        child.unref();
        resolve({ started: true, pid: child.pid });
      });
    });
  } finally { close(fd); }
}
