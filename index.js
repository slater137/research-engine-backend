import cors from "cors";
import express from "express";

async function loadBackendModules() {
  try {
    const [{ config }, { buildGraph, parseGraphParams }, { resolveWork }] = await Promise.all([
      import("./config.js"),
      import("./graph.js"),
      import("./openalex.js")
    ]);

    return { config, buildGraph, parseGraphParams, resolveWork };
  } catch {
    const [{ config }, { buildGraph, parseGraphParams }, { resolveWork }] = await Promise.all([
      import("./src/config.js"),
      import("./src/graph.js"),
      import("./src/openalex.js")
    ]);

    return { config, buildGraph, parseGraphParams, resolveWork };
  }
}

const { config, buildGraph, parseGraphParams, resolveWork } = await loadBackendModules();
const app = express();

function normalizeOrigin(origin) {
  return `${origin || ""}`
    .trim()
    .replace(/\/$/, "");
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const configuredOrigins = (config.corsOrigins || [])
  .map(normalizeOrigin)
  .filter(Boolean);
const exactOrigins = new Set(configuredOrigins.filter((origin) => !origin.includes("*")));
const wildcardOriginRegexes = configuredOrigins
  .filter((origin) => origin.includes("*"))
  .map((origin) => {
    const pieces = origin.split("*").map(escapeRegex);
    return new RegExp(`^${pieces.join(".*")}$`, "i");
  });

function isAllowedOrigin(origin) {
  const normalized = normalizeOrigin(origin);
  if (!normalized) {
    return false;
  }

  if (exactOrigins.has(normalized)) {
    return true;
  }

  return wildcardOriginRegexes.some((regex) => regex.test(normalized));
}

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || isAllowedOrigin(origin)) {
        callback(null, true);
        return;
      }

      // Reject CORS safely without crashing the process.
      callback(null, false);
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
    `[backend] listening on http://localhost:${config.port} (CORS: ${configuredOrigins.join(", ")})`
  );
});
