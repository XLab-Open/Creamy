/**
 * Run `build` or `dev` with `SKIP_ENV_VALIDATION` to skip env validation. This is especially useful
 * for Docker builds.
 */
import "./src/env.js";

function getInternalServiceURL(envKey, fallbackURL) {
  const configured = process.env[envKey]?.trim();
  return configured && configured.length > 0
    ? configured.replace(/\/+$/, "")
    : fallbackURL;
}
/** @type {import("next").NextConfig} */
const config = {
  devIndicators: false,
  async rewrites() {
    const rewrites = [];
    // Creamy serves both the LangGraph-compatible runtime and the gateway
    // resource API from a single WebChannel (default 127.0.0.1:8000). There is
    // no nginx in front, so the frontend proxies /api/* to it directly here.
    const langgraphURL = getInternalServiceURL(
      "DEER_FLOW_INTERNAL_LANGGRAPH_BASE_URL",
      "http://127.0.0.1:8000",
    );
    const gatewayURL = getInternalServiceURL(
      "DEER_FLOW_INTERNAL_GATEWAY_BASE_URL",
      "http://127.0.0.1:8000",
    );

    if (!process.env.NEXT_PUBLIC_LANGGRAPH_BASE_URL) {
      // The SDK base URL is /api/langgraph; strip that prefix so requests hit
      // the gateway's LangGraph-native paths (/threads, /assistants, ...).
      rewrites.push({
        source: "/api/langgraph",
        destination: langgraphURL,
      });
      rewrites.push({
        source: "/api/langgraph/:path*",
        destination: `${langgraphURL}/:path*`,
      });
    }

    if (!process.env.NEXT_PUBLIC_BACKEND_BASE_URL) {
      // Forward gateway resource endpoints, keeping the /api prefix. These are
      // listed explicitly (not a broad /api/:path*) because afterFiles rewrites
      // take precedence over dynamic routes — a catch-all would hijack
      // Next-local routes like /api/auth/[...all] and /api/memory and break
      // auth. Add new gateway paths here as later milestones implement them.
      for (const p of ["models", "skills"]) {
        rewrites.push({
          source: `/api/${p}`,
          destination: `${gatewayURL}/api/${p}`,
        });
        rewrites.push({
          source: `/api/${p}/:path*`,
          destination: `${gatewayURL}/api/${p}/:path*`,
        });
      }
    }

    return rewrites;
  },
};

export default config;
