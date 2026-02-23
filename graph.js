import { getCitingWorks, getWorkById, getWorksByIds, toOpenAlexId } from "./openalex.js";

const REFERENCE_CANDIDATE_CAP = 200;

function clampInteger(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

function sortByInfluence(works) {
  return [...works].sort((a, b) => {
    if (b.cited_by_count !== a.cited_by_count) {
      return b.cited_by_count - a.cited_by_count;
    }
    return a.id.localeCompare(b.id);
  });
}

function computeNodeSize(citedByCount) {
  const safeCount = Math.max(0, Number(citedByCount) || 0);
  const scaled = Math.log10(safeCount + 1) * 2.6 + 1.2;
  return Number(scaled.toFixed(3));
}

function isTemporallyConsistent(parent, child, side) {
  const parentYear = Number(parent?.year);
  const childYear = Number(child?.year);
  if (!Number.isFinite(parentYear) || !Number.isFinite(childYear)) {
    return true;
  }

  if (side === "references") {
    return childYear <= parentYear;
  }

  return childYear >= parentYear;
}

function isLinkTemporallyConsistent(link, nodeMap) {
  const source = nodeMap.get(link.source);
  const target = nodeMap.get(link.target);
  if (!source || !target) {
    return false;
  }

  return isTemporallyConsistent(source, target, link.type);
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
  const center = await getWorkById(workId);
  if (!center) {
    throw new Error("Center work not found in OpenAlex.", { cause: "NOT_FOUND" });
  }

  const nodeMap = new Map();
  const linkMap = new Map();
  const workCache = new Map();

  function cacheWork(work) {
    if (work?.id) {
      workCache.set(work.id, work);
    }
  }

  function getCachedWork(id) {
    return workCache.get(id) || null;
  }

  function addNode(work, side, nodeDepth) {
    cacheWork(work);

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

    const mergedSide =
      existing.side === side || existing.side === "center"
        ? existing.side
        : side === "center"
          ? "center"
          : "both";

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

  async function getTopReferences(parentWork, sideLimit) {
    const refs = parentWork.referenced_works || [];
    if (!refs.length) {
      return [];
    }

    const candidates = refs.slice(0, REFERENCE_CANDIDATE_CAP);
    const works = await getWorksByIds(candidates);
    const worksById = new Map(works.map((work) => [work.id, work]));

    const ordered = refs
      .map((id) => worksById.get(id))
      .filter(Boolean);

    return sortByInfluence(ordered).slice(0, sideLimit);
  }

  async function getTopCitations(parentId, sideLimit) {
    const rows = await getCitingWorks(parentId, Math.min(100, sideLimit * 3));
    return sortByInfluence(rows).slice(0, sideLimit);
  }

  async function getWorkOrFetch(id) {
    const cached = getCachedWork(id);
    if (cached) {
      return cached;
    }

    const fetched = await getWorkById(id);
    if (fetched) {
      cacheWork(fetched);
    }
    return fetched;
  }

  async function expandSide(side) {
    let frontier = [center.id];

    for (let level = 1; level <= depth; level += 1) {
      if (!frontier.length) {
        break;
      }

      const perParentLimit = Math.max(1, Math.floor(limit / frontier.length));
      const expansionPromises = frontier.map(async (parentId) => {
        const parent = await getWorkOrFetch(parentId);
        if (!parent) {
          return [];
        }

        const children =
          side === "references"
            ? await getTopReferences(parent, perParentLimit)
            : await getTopCitations(parent.id, perParentLimit);
        const filtered = children.filter((child) => isTemporallyConsistent(parent, child, side));
        return filtered.map((child) => ({ parent, child }));
      });

      const expansionSets = await Promise.all(expansionPromises);
      const flattened = expansionSets.flat();
      const uniqueByChild = new Map();
      for (const entry of flattened) {
        const existing = uniqueByChild.get(entry.child.id);
        if (!existing) {
          uniqueByChild.set(entry.child.id, entry);
          continue;
        }

        if (entry.parent.id < existing.parent.id) {
          uniqueByChild.set(entry.child.id, entry);
        }
      }

      const limited = [...uniqueByChild.values()]
        .sort((a, b) => {
          if (b.child.cited_by_count !== a.child.cited_by_count) {
            return b.child.cited_by_count - a.child.cited_by_count;
          }
          return a.child.id.localeCompare(b.child.id);
        })
        .slice(0, limit);

      const nextFrontier = new Set();

      for (const { parent, child } of limited) {
        addNode(child, side === "references" ? "backward" : "forward", level);
        addLink(
          parent.id,
          child.id,
          side,
          side === "references" ? "backward" : "forward"
        );
        nextFrontier.add(child.id);
      }

      frontier = [...nextFrontier];
    }
  }

  addNode(center, "center", 0);
  await Promise.all([expandSide("references"), expandSide("cited_by")]);
  const nodes = [...nodeMap.values()];
  const linkCandidates = [...linkMap.values()];
  const stableNodeMap = new Map(nodes.map((node) => [node.id, node]));
  const links = linkCandidates.filter((link) => isLinkTemporallyConsistent(link, stableNodeMap));
  const connectedNodeIds = new Set([center.id]);
  for (const link of links) {
    connectedNodeIds.add(link.source);
    connectedNodeIds.add(link.target);
  }
  const connectedNodes = nodes.filter((node) => connectedNodeIds.has(node.id));

  return {
    meta: {
      centerWorkId: center.id,
      depth,
      limit
    },
    nodes: connectedNodes,
    links
  };
}
