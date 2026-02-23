import { config } from "./config.js";

const WORK_SELECT_FIELDS = [
  "id",
  "display_name",
  "publication_year",
  "cited_by_count",
  "referenced_works",
  "authorships",
  "primary_location",
  "doi"
].join(",");

function withMailto(url) {
  if (!config.openAlexMailto) {
    return url;
  }

  const next = new URL(url);
  next.searchParams.set("mailto", config.openAlexMailto);
  return next;
}

async function requestOpenAlex(url) {
  const finalUrl = withMailto(url);
  const response = await fetch(finalUrl, {
    headers: {
      "User-Agent": config.openAlexUserAgent
    }
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAlex request failed (${response.status}): ${body.slice(0, 400)}`);
  }

  return response.json();
}

function normalizeId(id) {
  if (!id || typeof id !== "string") {
    return null;
  }

  const trimmed = id.trim();
  const match = trimmed.match(/(?:openalex\.org\/|works\/)?(W\d{4,})/i);
  if (!match) {
    return null;
  }

  return `https://openalex.org/${match[1].toUpperCase()}`;
}

function normalizeDoi(input) {
  if (!input || typeof input !== "string") {
    return null;
  }

  const trimmed = input.trim();
  const doiUrlMatch = trimmed.match(/doi\.org\/(10\.[^\s?#]+)/i);
  if (doiUrlMatch) {
    return `https://doi.org/${doiUrlMatch[1].toLowerCase()}`;
  }

  const rawMatch = trimmed.match(/^(10\.[^\s?#]+)$/i);
  if (rawMatch) {
    return `https://doi.org/${rawMatch[1].toLowerCase()}`;
  }

  return null;
}

export function normalizeWork(work) {
  if (!work?.id) {
    return null;
  }

  return {
    id: work.id,
    title: work.display_name || "Untitled",
    year: work.publication_year || null,
    cited_by_count: Number.isFinite(work.cited_by_count) ? work.cited_by_count : 0,
    authors: (work.authorships || [])
      .map((entry) => entry?.author?.display_name)
      .filter(Boolean)
      .slice(0, 8),
    venue: work.primary_location?.source?.display_name || "Unknown venue",
    openalex_url: work.id,
    referenced_works: Array.isArray(work.referenced_works) ? work.referenced_works : [],
    doi: work.doi || null
  };
}

export async function getWorkById(workId) {
  const normalized = normalizeId(workId);
  if (!normalized) {
    return null;
  }

  const worksUrl = new URL(config.openAlexBaseUrl);
  worksUrl.searchParams.set("filter", `openalex_id:${normalized}`);
  worksUrl.searchParams.set("per-page", "1");
  worksUrl.searchParams.set("select", WORK_SELECT_FIELDS);

  const data = await requestOpenAlex(worksUrl.toString());
  const work = data?.results?.[0];
  return work ? normalizeWork(work) : null;
}

function tokenize(text) {
  return (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function titleMatchScore(query, title) {
  const qTokens = new Set(tokenize(query));
  const tTokens = new Set(tokenize(title));

  if (!qTokens.size || !tTokens.size) {
    return 0;
  }

  let overlap = 0;
  for (const token of qTokens) {
    if (tTokens.has(token)) {
      overlap += 1;
    }
  }

  return overlap / qTokens.size;
}

function chooseBestMatch(query, works) {
  return [...works]
    .map((work) => {
      const titleScore = titleMatchScore(query, work.display_name || "");
      const score = titleScore * 10000 + (work.cited_by_count || 0);
      return { work, score };
    })
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return (b.work.cited_by_count || 0) - (a.work.cited_by_count || 0);
    })[0]?.work;
}

export async function resolveWork(query) {
  const trimmed = (query || "").trim();
  if (!trimmed) {
    return null;
  }

  const openAlexId = normalizeId(trimmed);
  if (openAlexId) {
    return getWorkById(openAlexId);
  }

  const doi = normalizeDoi(trimmed);
  if (doi) {
    const doiUrl = new URL(config.openAlexBaseUrl);
    doiUrl.searchParams.set("filter", `doi:${doi}`);
    doiUrl.searchParams.set("per-page", "1");
    doiUrl.searchParams.set("select", WORK_SELECT_FIELDS);

    const doiData = await requestOpenAlex(doiUrl.toString());
    const match = doiData?.results?.[0];
    if (match) {
      return normalizeWork(match);
    }
  }

  const searchUrl = new URL(config.openAlexBaseUrl);
  searchUrl.searchParams.set("search", trimmed);
  searchUrl.searchParams.set("per-page", "5");
  searchUrl.searchParams.set("select", WORK_SELECT_FIELDS);

  const searchData = await requestOpenAlex(searchUrl.toString());
  const candidates = searchData?.results || [];
  if (!candidates.length) {
    return null;
  }

  const best = chooseBestMatch(trimmed, candidates);
  return best ? normalizeWork(best) : null;
}

function chunkArray(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

export async function getWorksByIds(ids) {
  const normalizedIds = [...new Set(ids.map((id) => normalizeId(id)).filter(Boolean))];
  if (!normalizedIds.length) {
    return [];
  }

  const chunks = chunkArray(normalizedIds, 40);
  const responses = await Promise.all(
    chunks.map(async (chunk) => {
      const url = new URL(config.openAlexBaseUrl);
      url.searchParams.set("filter", `openalex_id:${chunk.join("|")}`);
      url.searchParams.set("per-page", String(chunk.length));
      url.searchParams.set("select", WORK_SELECT_FIELDS);
      const data = await requestOpenAlex(url.toString());
      return (data?.results || []).map(normalizeWork).filter(Boolean);
    })
  );

  return responses.flat();
}

export async function getCitingWorks(workId, limit, page = 1) {
  const normalized = normalizeId(workId);
  if (!normalized) {
    return [];
  }

  const url = new URL(config.openAlexBaseUrl);
  url.searchParams.set("filter", `cites:${normalized}`);
  url.searchParams.set("sort", "cited_by_count:desc");
  url.searchParams.set("per-page", String(limit));
  url.searchParams.set("page", String(page));
  url.searchParams.set("select", WORK_SELECT_FIELDS);

  const data = await requestOpenAlex(url.toString());
  return (data?.results || []).map(normalizeWork).filter(Boolean);
}

export function toOpenAlexId(value) {
  return normalizeId(value);
}
