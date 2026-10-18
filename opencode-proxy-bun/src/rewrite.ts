// Paths from the live catalog / Console compatibility layer -> legacy /zen/*
// Inverse of packages/console/app/src/lib/inference-proxy.ts.
const INFERENCE_PREFIXES: Array<[string, string]> = [
  ["/inference/go/openai/v1/", "/zen/go/v1/"],
  ["/inference/go/anthropic/v1/", "/zen/go/v1/"],
  ["/inference/go/systemone/v1/", "/zen/go/v1/"],
  ["/inference/go/v1/", "/zen/go/v1/"],
  ["/inference/google/v1beta/models/", "/zen/v1/models/"],
  ["/inference/openai/v1/", "/zen/v1/"],
  ["/inference/anthropic/v1/", "/zen/v1/"],
  ["/inference/systemone/v1/", "/zen/v1/"],
  ["/inference/v1/", "/zen/v1/"],
]

export function rewritePath(path: string): string {
  for (const [from, to] of INFERENCE_PREFIXES) {
    if (path.startsWith(from)) return to + path.slice(from.length)
  }
  if (path.startsWith("/zen/")) return path
  if (path.startsWith("/v1beta/models")) {
    return "/zen/v1/models" + path.slice("/v1beta/models".length)
  }
  if (path === "/v1" || path.startsWith("/v1/")) return "/zen" + path
  if (
    path === "/chat/completions" ||
    path === "/responses" ||
    path === "/messages" ||
    path === "/models"
  ) {
    return "/zen/v1" + path
  }
  return path
}

export function isZenPath(path: string): boolean {
  return /^\/zen\/(?:go\/)?v1\//.test(path)
}

export function isChatPath(path: string): boolean {
  return /^\/zen\/(?:go\/)?v1\/chat\/completions\/?$/.test(path)
}
