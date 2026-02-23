import cors from "cors";
import express from "express";
import { buildGraph, parseGraphParams } from "./graph.js";
import { config } from "./config.js";
import { resolveWork } from "./openalex.js";

const app = express();

const allowedOrigins = new Set(config.corsOrigins);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.has(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error(`Origin not allowed by CORS: ${origin}`));
    }
  })
);

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "influence-engine-backend" });
});

app.get("/resolve", async (req, res) => {
  try {
    const query = `${req.query.q || ""}`.trim();
    if (!query) {
      res.status(400).json({ error: "Missing required query param: q" });
      return;
    }

    const work = await resolveWork(query);
    if (!work) {
      res.status(404).json({ error: "No matching work found." });
      return;
    }

    res.json({
      id: work.id,
      title: work.title,
      year: work.year,
      cited_by_count: work.cited_by_count
    });
  } catch (error) {
    res.status(502).json({ error: error.message || "Resolve failed" });
  }
});

app.get("/graph", async (req, res) => {
  try {
    const workId = `${req.query.workId || ""}`.trim();
    if (!workId) {
      res.status(400).json({ error: "Missing required query param: workId" });
      return;
    }

    const { depth, limit } = parseGraphParams(req.query.depth, req.query.limit);
    const graph = await buildGraph(workId, depth, limit);
    res.json(graph);
  } catch (error) {
    if (error.cause === "BAD_WORK_ID") {
      res.status(400).json({ error: error.message });
      return;
    }

    if (error.cause === "NOT_FOUND") {
      res.status(404).json({ error: error.message });
      return;
    }

    res.status(502).json({ error: error.message || "Graph request failed" });
  }
});

app.listen(config.port, () => {
  console.log(
    `[backend] listening on http://localhost:${config.port} (CORS: ${[...allowedOrigins].join(", ")})`
  );
});
