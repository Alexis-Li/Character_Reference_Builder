import { NextRequest, NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";
import { stat } from "fs/promises";
import path from "path";
import os from "os";
import { withPrivilegedApi } from "@/lib/security/requestGuard.server";
import { authorizedWriteRoots, isInsideDirectory } from "@/lib/security/projectWriteScope.server";

const execFileAsync = promisify(execFile);

export const POST = withPrivilegedApi(["local-file-read"], async (req: NextRequest) => {
    try {
        const body = await req.json();
        const { path: inputPath } = body;

        if (!inputPath || typeof inputPath !== "string") {
            return NextResponse.json(
                { success: false, error: "Path is required" },
                { status: 400 }
            );
        }

        // Normalize and resolve the path to prevent traversal attacks
        const normalizedPath = path.resolve(inputPath);

        // Confine OS-level opens to the user's home directory or an authorized
        // project root, so a compromised page cannot ask the shell to open
        // arbitrary system locations.
        const allowedRoots = [path.resolve(os.homedir()), ...authorizedWriteRoots()];
        if (!allowedRoots.some((root) => isInsideDirectory(normalizedPath, root))) {
            return NextResponse.json(
                {
                    success: false,
                    error: "Directory is outside the user's home directory and authorized project roots",
                },
                { status: 400 }
            );
        }

        // Validate that the path exists and is a directory
        try {
            const stats = await stat(normalizedPath);
            if (!stats.isDirectory()) {
                return NextResponse.json(
                    { success: false, error: "Path is not a directory" },
                    { status: 400 }
                );
            }
        } catch {
            return NextResponse.json(
                { success: false, error: "Directory does not exist" },
                { status: 400 }
            );
        }

        let command = "";
        let args: string[] = [];
        const platform = os.platform();

        switch (platform) {
            case "darwin":
                command = "open";
                args = [normalizedPath];
                break;
            case "win32":
                command = "explorer";
                args = [normalizedPath];
                break;
            case "linux":
                command = "xdg-open";
                args = [normalizedPath];
                break;
            default:
                // Fallback for other Unix-like systems
                command = "xdg-open";
                args = [normalizedPath];
        }

        await execFileAsync(command, args);

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error("Failed to open directory:", error);
        return NextResponse.json(
            { success: false, error: "Failed to open directory" },
            { status: 500 }
        );
    }
});
