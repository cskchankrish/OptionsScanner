import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [
    react(),
    {
      name: "api-middleware",
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (!req.url || !req.url.startsWith("/api/")) return next();
          const url = new URL(req.url, "http://localhost:5173");
          const endpoint = url.pathname.replace("/api/", "").replace(/\/$/, "");
          try {
            if (endpoint === "nifty-oi") {
              const mod = await import("./api/nifty-oi.js");
              req.query = Object.fromEntries(url.searchParams);
              res.status = (code) => { res.statusCode = code; return res; };
              res.json = (data) => {
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify(data));
              };
              await mod.default(req, res);
              return;
            } else if (endpoint === "tv-webhook") {
              const mod = await import("./api/tv-webhook.js");
              req.query = Object.fromEntries(url.searchParams);
              res.status = (code) => { res.statusCode = code; return res; };
              res.json = (data) => {
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify(data));
              };
              await mod.default(req, res);
              return;
            }
          } catch (e) {
            console.error("Local dev API error:", e);
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: e.message }));
            return;
          }
          next();
        });
      },
    },
  ],
});
