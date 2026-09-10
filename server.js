// Custom loopback-only Next.js server with an extended request timeout.

const { createServer } = require('http');
const next = require('next');

const dev = process.env.NODE_ENV !== 'production';
const hostname = '127.0.0.1';
const parsedPort = Number.parseInt(process.env.CRB_PORT || '3210', 10);
const port = Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort < 65536 ? parsedPort : 3210;

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const server = createServer(async (req, res) => {
    await handle(req, res);
  });

  // Increase timeout to 10 minutes for long-running video generation
  server.requestTimeout = 600000; // 10 minutes
  server.headersTimeout = 610000; // Slightly longer than requestTimeout

  server.on('error', (error) => {
    console.error(`> Unable to start local server on ${hostname}:${port}: ${error.message}`);
    process.exitCode = 1;
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  server.listen(port, hostname, () => {
    console.log(`> Ready on http://${hostname}:${port}`);
    console.log(`> Server timeout set to ${server.requestTimeout / 1000 / 60} minutes`);
  });
});
