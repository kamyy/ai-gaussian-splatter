// A tiny real HTTP server standing in for the FastAPI backend during E2E
// tests. Needed specifically because the gallery/view pages fetch server-side
// during Next.js SSR (see app/gallery/page.tsx's `force-dynamic`) — Playwright's
// browser-level page.route() can't intercept those, since they're made by
// the Node.js server process, not the browser. Started as a second
// `webServer` entry in playwright.config.ts, alongside `pnpm dev`.
import { createServer } from "node:http";

const GALLERY_ITEM = {
  id: "11111111-1111-1111-1111-111111111111",
  title: "Ceramic mug",
  description: "A test splat",
  thumbnail_url: "https://example.com/thumb.png",
  splat_url: "https://example.com/result.ply",
};

const routes = {
  "GET /api/v1/gallery": () => [200, [GALLERY_ITEM]],
  [`GET /api/v1/gallery/${GALLERY_ITEM.id}`]: () => [200, GALLERY_ITEM],
};

const server = createServer((req, res) => {
  const handler = routes[`${req.method} ${req.url}`];
  const [status, body] = handler ? handler() : [404, { detail: "not found" }];
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
});

const port = process.env.MOCK_BACKEND_PORT ?? 8000;
server.listen(port, () => {
  console.log(`Mock backend listening on :${port}`);
});
