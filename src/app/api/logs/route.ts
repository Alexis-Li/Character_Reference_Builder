/**
 * API route for log management
 *
 * Handles:
 * - Saving log sessions to disk
 * - Manual log rotation
 * - Log file cleanup
 */

import { NextRequest, NextResponse } from 'next/server';
import { saveSession, rotateLogFiles } from '@/utils/logger-server';
import type { LogSession } from '@/utils/logger';
import { withPrivilegedApi } from '@/lib/security/requestGuard.server';
import { redactSecretsDeep, redactSecretsInText } from '@/lib/security/secretRedaction';

/**
 * POST /api/logs - Save a logging session to disk
 */
export const POST = withPrivilegedApi(
  ["log-write", "local-file-write"],
  async (req: NextRequest) => {
  try {
    const body = await req.json();
    const incomingSession = body.session as LogSession | undefined;

    if (!incomingSession || !incomingSession.sessionId) {
      return NextResponse.json(
        {
          success: false,
          error: 'Invalid session data',
        },
        { status: 400 }
      );
    }

    // Redact before persisting: a console session uploaded from the browser
    // must not store a token, cookie, authorization header or key material,
    // even under an ordinary field name.
    const session = redactSecretsDeep(incomingSession, { secretFields: 'drop' });

    // Rotate old log files
    await rotateLogFiles();

    // Save the session
    await saveSession(session);

    return NextResponse.json({
      success: true,
      sessionId: session.sessionId,
    });
  } catch (error) {
    console.error('Failed to save log session:', error);

    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? redactSecretsInText(error.message) : 'Unknown error',
      },
      { status: 500 }
    );
  }
});
