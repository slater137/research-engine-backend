import dotenv from "dotenv";

dotenv.config();

function normalizeOrigin(origin) {
  return `${origin || ""}`
    .trim()
    .replace(/\/$/, "");
}

const defaultOrigins = [
  "http://localhost:5173",
  "http://127.0.0.1:5173"
].map(normalizeOrigin);

const configuredOrigins = (process.env.FRONTEND_ORIGINS || "")
  .split(",")
  .map(normalizeOrigin)
  .filter(Boolean);

export const config = {
  port: Number.parseInt(process.env.PORT || "3000", 10),
  openAlexBaseUrl: process.env.OPENALEX_BASE_URL || "https://api.openalex.org/works",
  openAlexMailto: process.env.OPENALEX_MAILTO || "",
  openAlexUserAgent:
    process.env.OPENALEX_USER_AGENT ||
    "InfluenceEngine/1.0",
  corsOrigins: configuredOrigins.length ? configuredOrigins : defaultOrigins
};
