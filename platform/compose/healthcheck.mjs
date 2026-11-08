// Container health check: GET http://127.0.0.1:<port><path> and succeed on a 2xx.
//   node /app/healthcheck.mjs 8380            -> /healthz
//   node /app/healthcheck.mjs 8390 /.well-known/openid-configuration
// No curl in the image; this is the one thing it needs to ask "are you up".
const [port, path = '/healthz'] = process.argv.slice(2);
try {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(4000) });
  process.exit(res.ok ? 0 : 1);
} catch {
  process.exit(1);
}
