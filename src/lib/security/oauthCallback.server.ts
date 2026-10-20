/** Short-lived loopback transport. OAuth state and tokens belong to the adapter. */
import { createServer } from "node:http";

export interface CallbackReply {
  status: number;
  message: string;
  complete?: boolean;
}

export async function listenOAuthCallback(
  redirectUri: string,
  receive: (url: URL) => Promise<CallbackReply>,
  signal: AbortSignal,
): Promise<{ redirectUri: string }> {
  const redirect = new URL(redirectUri);
  if (redirect.protocol !== "http:" || redirect.hostname !== "127.0.0.1" ||
      redirect.username || redirect.password || redirect.search || redirect.hash) {
    throw new Error("invalid-loopback-redirect");
  }
  signal.throwIfAborted();
  const server = createServer({ maxHeaderSize: 8192 }, async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    response.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Connection", "close");
    const reply = (status: number, message: string) => { response.statusCode = status; response.end(message); };
    if (request.method !== "GET" || request.headers.host !== redirect.host ||
        !request.url?.startsWith("/") || request.url.startsWith("//")) {
      reply(400, "Invalid login callback."); return;
    }
    let url: URL;
    try { url = new URL(request.url, redirect.origin); }
    catch { reply(400, "Invalid login callback."); return; }
    if (url.pathname !== redirect.pathname || url.origin !== redirect.origin) {
      reply(404, "Not found."); return;
    }
    try {
      const result = await receive(url);
      // Never echo the URL, code, state or Provider error text.
      reply(result.status, result.message);
      if (result.complete) close();
    } catch { reply(500, "Login could not complete. Return to Character Reference Builder and retry."); }
  });
  server.requestTimeout = 20_000;
  server.headersTimeout = 10_000;
  server.unref();
  const close = () => {
    signal.removeEventListener("abort", close);
    server.close();
    server.closeIdleConnections();
  };
  signal.addEventListener("abort", close, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(Number(redirect.port || 80), "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    signal.throwIfAborted();
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("callback-listener-unavailable");
    redirect.port = String(address.port);
    return { redirectUri: redirect.toString() };
  } catch (error) { close(); throw error; }
}
