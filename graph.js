import { getCitingWorks, getWorkById, getWorksByIds, toOpenAlexId } from "./openalex.js";

const SIDE_LIMIT_CAP = 20;

function clampInteger(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

function sortByInfluence(works) {
  return [...works].sort((a, b) => {
    const aCitedBy = Number.isFinite(a?.cited_by_count) ? a.cited_by_count : 0;
    const bCitedBy = Number.isFinite(b?.cited_by_count) ? b.cited_by_count : 0;
    if (bCitedBy !== aCitedBy) {
      return bCitedBy - aCitedBy;
    }

    const aYear = Number.isFinite(a?.year) ? a.year : -Infinity;
    const bYear = Number.isFinite(b?.year) ? b.year : -Infinity;
    if (bYear !== aYear) {
      return bYear - aYear;
    }

    return a.id.localeCompare(b.id);
  });
}

function computeNodeSize(citedByCount) {
  const safeCount = Math.max(0, Number(citedByCount) || 0);
  const scaled = Math.log10(safeCount + 1) * 2.6 + 1.2;
  return Number(scaled.toFixed(3));
}

export function parseGraphParams(depth, limit) {
  return {
    depth: clampInteger(depth, 1, 3, 2),
    limit: clampInteger(limit, 1, 30, 20)
  };
}

export async function buildGraph(workIdInput, requestedDepth, requestedLimit) {
  const workId = toOpenAlexId(workIdInput);
  if (!workId) {
    throw new Error("Invalid workId. Use an OpenAlex Work ID (for example W2741809807).", {
      cause: "BAD_WORK_ID"
    });
  }

  const { depth, limit } = parseGraphParams(requestedDepth, requestedLimit);
  const sideLimit = Math.min(SIDE_LIMIT_CAP, limit);

  const center = await getWorkById(workId);
  if (!center) {
    throw new Error("Center work not found in OpenAlex.", { cause: "NOT_FOUND" });
  }

  const nodeMap = new Map();
  const linkMap = new Map();

  function addNode(work, side, nodeDepth) {
    const existing = nodeMap.get(work.id);
    const next = {
      id: work.id,
      title: work.title,
      year: work.year,
      cited_by_count: work.cited_by_count,
      authors: work.authors,
      venue: work.venue,
      openalex_url: work.openalex_url,
      side,
      depth: nodeDepth,
      size: computeNodeSize(work.cited_by_count)
    };

    if (!existing) {
      nodeMap.set(work.id, next);
      return;
    }

    let mergedSide = existing.side;
    if (existing.side === "center" || side === "center") {
      mergedSide = "center";
    } else if (existing.side !== side) {
      mergedSide = "both";
    }

    nodeMap.set(work.id, {
      ...existing,
      ...next,
      side: mergedSide,
      depth: Math.min(existing.depth, nodeDepth)
    });
  }

  function addLink(source, target, type, direction) {
    const key = `${source}->${target}:${type}`;
    if (linkMap.has(key)) {
      return;
    }

    linkMap.set(key, {
      source,
      target,
      type,
      direction
    });
  }

  addNode(center, "center", 0);

  const [referenceCandidates, citationCandidates] = await Promise.all([
    getWorksByIds(center.referenced_works || []),
    getCitingWorks(center.id, sideLimit)
  ]);

  const topReferences = sortByInfluence(referenceCandidates).slice(0, sideLimit);
  const topCitations = sortByInfluence(citationCandidates).slice(0, sideLimit);

  for (const referenceWork of topReferences) {
    addNode(referenceWork, "backward", 1);
    addLink(center.id, referenceWork.id, "references", "backward");
  }

  for (const citingWork of topCitations) {
    addNode(citingWork, "forward", 1);
    addLink(center.id, citingWork.id, "cited_by", "forward");
  }

  const nodes = [...nodeMap.values()];
  const links = [...linkMap.values()];

  return {
    meta: {
      centerWorkId: center.id,
      depth: 1,
      requestedDepth: depth,
      limit: sideLimit
    },
    nodes,
    links
  };
}
