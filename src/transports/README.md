# Transport boundary

The stdio entry validates the application and live schemas before calling the
SDK's serveStdio with the shared MCP factory. It owns EOF/signal shutdown and
safe stderr diagnostics. Stdout belongs exclusively to the SDK protocol writer.
KAN-10 HTTP reuses the same factory and services, authenticating before body reads
or initialization. Its per-request SDK handler uses stateless legacy serving,
JSON modern responses and no subscriptions, then drains bounded finite output
and closes all contexts. Bearer credentials are verified from SHA-256 digests only.
api/index.ts exposes the Web fetch contract; no socket listener is created.
Health is public liveness; authenticated readiness shares cached initialization.
Hosted Vercel verification remains KAN-11 work.
