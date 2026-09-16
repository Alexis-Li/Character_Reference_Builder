/**
 * Server-side only logger utilities
 * This file should never be imported on the client side
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type { LogSession } from './logger';
import { resolveRuntimeStateDir } from '@/lib/security/cliAuth.server';
import { redactSecretsDeep } from '@/lib/security/secretRedaction';

/**
 * Check if running on Vercel (read-only filesystem)
 */
function isVercelProduction(): boolean {
  return !!process.env.VERCEL;
}

/**
 * Disposable runtime logs live under `CRB_TEMP_ROOT/runtime/`, never in the
 * repository: they are diagnostics, not project assets, and a session file
 * must not be committed or shipped by accident.
 */
function logsDirectory(): string {
  return path.join(resolveRuntimeStateDir(), 'logs');
}

/**
 * Save session to file (server-side only)
 * Note: Skipped on Vercel due to read-only filesystem
 */
export async function saveSession(session: LogSession): Promise<void> {
  if (isVercelProduction()) {
    console.log(`[Logger] Skipping file save on Vercel (session: ${session.sessionId})`);
    return;
  }

  // Guard against path traversal: sessionId is attacker-controllable and is
  // interpolated into the output file path. Only allow a strict charset so a
  // crafted id (e.g. "../../etc/foo") cannot escape the logs directory.
  if (!/^[A-Za-z0-9_-]+$/.test(session.sessionId)) {
    console.error(`[Logger] Rejecting invalid session id: ${session.sessionId}`);
    return;
  }

  const logsDir = logsDirectory();
  const filename = `session-${session.sessionId}.json`;
  const filepath = path.join(logsDir, filename);

  // Ensure logs directory exists
  try {
    await fs.mkdir(logsDir, { recursive: true });
  } catch (error) {
    console.error('Failed to create logs directory:', error);
    return;
  }

  // Write session to file. The session arrives from an API route, so it is
  // redacted here as well as at the route: a log file is a shareable artifact,
  // and a credential that reaches one has left the machine's trust boundary.
  const sanitized = redactSecretsDeep(session, { secretFields: 'drop' });
  try {
    await fs.writeFile(filepath, JSON.stringify(sanitized, null, 2), 'utf-8');
  } catch (error) {
    console.error('Failed to write log file:', error);
  }
}

/**
 * Rotate log files (keep only last 10 sessions)
 * Note: Skipped on Vercel due to read-only filesystem
 */
export async function rotateLogFiles(): Promise<void> {
  if (isVercelProduction()) {
    return;
  }

  const logsDir = logsDirectory();

  // Ensure logs directory exists
  try {
    await fs.mkdir(logsDir, { recursive: true });
  } catch (error) {
    console.error('Failed to create logs directory:', error);
    return;
  }

  // Get all log files
  let files: string[];
  try {
    files = await fs.readdir(logsDir);
  } catch (error) {
    console.error('Failed to read logs directory:', error);
    return;
  }

  // Filter to only session log files
  const sessionFiles = files
    .filter(f => f.startsWith('session-') && f.endsWith('.json'))
    .sort()
    .reverse(); // Most recent first

  // Delete files beyond the 10 most recent
  const filesToDelete = sessionFiles.slice(10);
  for (const file of filesToDelete) {
    try {
      await fs.unlink(path.join(logsDir, file));
      console.log(`Deleted old log file: ${file}`);
    } catch (error) {
      console.error(`Failed to delete log file ${file}:`, error);
    }
  }
}
