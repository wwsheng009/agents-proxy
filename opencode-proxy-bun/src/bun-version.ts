export const SUPPORTED_BUN_RANGE = "1.3.14+ / 1.4.x"

/**
 * OpenCode free-tier admission is not tied to a single Bun patch release.
 * Verified clients: 1.3.14, 1.4.2, 1.4.3. Accept the tested range and reject
 * untested major/minor versions so a future Bun upgrade cannot silently
 * change the TLS/HTTP2 fingerprint.
 */
export function isSupportedBunVersion(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim())
  if (!match) return false

  const major = Number(match[1])
  const minor = Number(match[2])
  const patch = Number(match[3])

  if (major !== 1) return false
  if (minor === 3) return patch >= 14
  return minor === 4
}
