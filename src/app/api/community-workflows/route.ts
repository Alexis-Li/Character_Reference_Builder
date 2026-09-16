import { NextResponse } from "next/server";
import { withPrivilegedApi } from "@/lib/security/requestGuard.server";
import { redactSecretsDeep } from "@/lib/security/secretRedaction";

const COMMUNITY_WORKFLOWS_API_URL =
  "https://nodebananapro.com/api/public/community-workflows";

/**
 * GET: List all community workflows from the remote API
 *
 * This proxies to the node-banana-pro hosted service which stores
 * community workflows in R2 storage.
 *
 * Fixed-host public catalog read: no credential and no caller-controlled
 * target, so no privileged effect is declared beyond the local-session gate.
 */
export const GET = withPrivilegedApi([], async () => {
  try {
    const response = await fetch(COMMUNITY_WORKFLOWS_API_URL, {
      headers: {
        Accept: "application/json",
      },
      // Cache for 5 minutes
      next: { revalidate: 300 },
    });

    if (!response.ok) {
      console.error(
        "Error fetching community workflows:",
        response.status,
        response.statusText
      );
      return NextResponse.json(
        {
          success: false,
          error: "Failed to fetch community workflows",
        },
        { status: response.status }
      );
    }

    const data = await response.json();

    return NextResponse.json(data);
  } catch (error) {
    console.error(
      "Error listing community workflows:",
      redactSecretsDeep(
        error instanceof Error
          ? { ...error, name: error.name, message: error.message, stack: error.stack }
          : error
      )
    );
    return NextResponse.json(
      {
        success: false,
        error: "Failed to list community workflows",
      },
      { status: 500 }
    );
  }
});
