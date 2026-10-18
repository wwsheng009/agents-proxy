import { describe, expect, test } from "bun:test"
import {
  assertProxyEnvConsistent,
  buildNoProxyMatcher,
  decideProxy,
  OutboundState,
  parseProxyURL,
  proxyFetchOption,
  splitHostPort,
  validateProxyConfig,
} from "./outbound"

const EMPTY_ENV: Record<string, string | undefined> = {}

describe("parseProxyURL", () => {
  test("accepts http and https", () => {
    expect(parseProxyURL("http://127.0.0.1:10810").display).toBe("http://127.0.0.1:10810")
    expect(parseProxyURL("https://proxy.example.com:8443").display).toBe(
      "https://proxy.example.com:8443",
    )
  })

  test("defaults to http when scheme is omitted", () => {
    const parsed = parseProxyURL("127.0.0.1:10810")
    expect(parsed.url.protocol).toBe("http:")
    expect(parsed.display).toBe("http://127.0.0.1:10810")
  })

  test("keeps credentials out of the display value", () => {
    const parsed = parseProxyURL("http://alice:s3cret@127.0.0.1:10810")
    expect(parsed.url.username).toBe("alice")
    expect(parsed.display).toBe("http://127.0.0.1:10810")
  })

  test("rejects socks5 with an actionable message", () => {
    expect(() => parseProxyURL("socks5://127.0.0.1:1080")).toThrow(/不支持 socks5/)
    expect(() => parseProxyURL("socks://127.0.0.1:1080")).toThrow(/不支持 socks/)
  })

  test("rejects unsupported schemes and malformed values", () => {
    expect(() => parseProxyURL("ftp://127.0.0.1:21")).toThrow(/不支持的代理 scheme/)
    expect(() => parseProxyURL("")).toThrow(/代理地址为空/)
    expect(() => parseProxyURL("http://")).toThrow()
  })
})

describe("splitHostPort", () => {
  test("splits host and port", () => {
    expect(splitHostPort("example.com:8080")).toEqual({ host: "example.com", port: "8080" })
    expect(splitHostPort("example.com")).toEqual({ host: "example.com", port: "" })
  })

  test("handles IPv6 literals", () => {
    expect(splitHostPort("[::1]:8080")).toEqual({ host: "[::1]", port: "8080" })
    expect(splitHostPort("[::1]")).toEqual({ host: "[::1]", port: "" })
    expect(splitHostPort("::1")).toEqual({ host: "::1", port: "" })
  })
})

describe("buildNoProxyMatcher", () => {
  test("* matches everything", () => {
    const matcher = buildNoProxyMatcher(["*"])
    expect(matcher.match("example.com", "443")).toBe(true)
    expect(matcher.match("10.0.0.1", "80")).toBe(true)
  })

  test("domain entries match the apex and subdomains", () => {
    const matcher = buildNoProxyMatcher(["example.com"])
    expect(matcher.match("example.com", "443")).toBe(true)
    expect(matcher.match("api.example.com", "443")).toBe(true)
    expect(matcher.match("notexample.com", "443")).toBe(false)
  })

  test("leading dot is equivalent to a bare domain", () => {
    const matcher = buildNoProxyMatcher([".internal"])
    expect(matcher.match("svc.internal", "80")).toBe(true)
    expect(matcher.match("internal", "80")).toBe(true)
  })

  test("host:port requires the same port", () => {
    const matcher = buildNoProxyMatcher(["example.com:8080"])
    expect(matcher.match("example.com", "8080")).toBe(true)
    expect(matcher.match("example.com", "443")).toBe(false)
  })

  test("IPv4 and IPv6 literals", () => {
    const matcher = buildNoProxyMatcher(["127.0.0.1", "::1"])
    expect(matcher.match("127.0.0.1", "80")).toBe(true)
    expect(matcher.match("127.0.0.2", "80")).toBe(false)
    expect(matcher.match("[::1]", "80")).toBe(true)
  })

  test("IPv4 CIDR", () => {
    const matcher = buildNoProxyMatcher(["10.0.0.0/8", "192.168.1.0/24"])
    expect(matcher.match("10.1.2.3", "80")).toBe(true)
    expect(matcher.match("11.1.2.3", "80")).toBe(false)
    expect(matcher.match("192.168.1.255", "80")).toBe(true)
    expect(matcher.match("192.168.2.1", "80")).toBe(false)
  })

  test("IPv6 CIDR", () => {
    const matcher = buildNoProxyMatcher(["fd00::/8", "2001:db8::/32"])
    expect(matcher.match("fd12:3456::1", "80")).toBe(true)
    expect(matcher.match("2001:db8:abcd::1", "80")).toBe(true)
    expect(matcher.match("2001:db9::1", "80")).toBe(false)
  })

  test("rejects malformed CIDR entries", () => {
    expect(() => buildNoProxyMatcher(["10.0.0.0/33"])).toThrow(/前缀超过 32/)
    expect(() => buildNoProxyMatcher(["10.0.0.0/abc"])).toThrow(/前缀无效/)
    expect(() => buildNoProxyMatcher(["not-an-ip/8"])).toThrow(/地址无效/)
  })
})

describe("decideProxy", () => {
  const httpsTarget = new URL("https://opencode.ai/zen/v1/chat/completions")

  test("explicit url wins", () => {
    const decision = decideProxy(
      { url: "http://127.0.0.1:10810", noProxy: [], fromEnv: false },
      null,
      httpsTarget,
      {},
    )
    expect(decision.option).toBe("http://127.0.0.1:10810")
    expect(decision.via).toBe("http://127.0.0.1:10810")
  })

  test("no_proxy hit goes direct", () => {
    const matcher = buildNoProxyMatcher(["opencode.ai"])
    const decision = decideProxy(
      { url: "http://127.0.0.1:10810", noProxy: ["opencode.ai"], fromEnv: false },
      matcher,
      httpsTarget,
      {},
    )
    expect(decision.option).toBe("direct")
    expect(decision.via).toBe("direct")
  })

  test("from_env reads HTTPS_PROXY for https targets", () => {
    const decision = decideProxy(
      { url: "", noProxy: [], fromEnv: true },
      null,
      httpsTarget,
      { HTTPS_PROXY: "http://127.0.0.1:10810" },
    )
    expect(decision.option).toBe("http://127.0.0.1:10810")
  })

  test("from_env ignores HTTP_PROXY for https targets", () => {
    const decision = decideProxy(
      { url: "", noProxy: [], fromEnv: true },
      null,
      httpsTarget,
      { HTTP_PROXY: "http://127.0.0.1:10810" },
    )
    expect(decision.option).toBe("direct")
  })

  test("from_env ignores ALL_PROXY on Bun 1.3.14", () => {
    const decision = decideProxy(
      { url: "", noProxy: [], fromEnv: true },
      null,
      httpsTarget,
      { ALL_PROXY: "http://127.0.0.1:10810" },
    )
    expect(decision.option).toBe("direct")
  })

  test("from_env=false ignores the environment", () => {
    const decision = decideProxy(
      { url: "", noProxy: [], fromEnv: false },
      null,
      httpsTarget,
      { HTTPS_PROXY: "http://127.0.0.1:10810" },
    )
    expect(decision.option).toBe("direct")
  })

  test("lowercase environment variables are honored", () => {
    const decision = decideProxy(
      { url: "", noProxy: [], fromEnv: true },
      null,
      httpsTarget,
      { https_proxy: "http://127.0.0.1:10810" },
    )
    expect(decision.option).toBe("http://127.0.0.1:10810")
  })
})

describe("proxyFetchOption", () => {
  test("direct becomes undefined, never false", () => {
    // Bun 1.3.14 ignores proxy:false and would still use the environment.
    expect(proxyFetchOption({ via: "direct", option: "direct" })).toBeUndefined()
  })

  test("proxy addresses pass through", () => {
    expect(
      proxyFetchOption({ via: "http://127.0.0.1:10810", option: "http://127.0.0.1:10810" }),
    ).toBe("http://127.0.0.1:10810")
  })
})

describe("validateProxyConfig", () => {
  test("builds a matcher only when noProxy is present", () => {
    expect(validateProxyConfig({ url: "", noProxy: [], fromEnv: false })).toBeNull()
    expect(
      validateProxyConfig({ url: "http://127.0.0.1:1", noProxy: [], fromEnv: false }),
    ).toBeNull()
    expect(
      validateProxyConfig({ url: "http://127.0.0.1:1", noProxy: ["example.com"], fromEnv: false }),
    ).not.toBeNull()
  })

  test("rejects noProxy without a url", () => {
    expect(() =>
      validateProxyConfig({ url: "", noProxy: ["example.com"], fromEnv: false }),
    ).toThrow(/仅在 proxy.url 非空时生效/)
  })

  test("rejects an invalid proxy url", () => {
    expect(() =>
      validateProxyConfig({ url: "socks5://127.0.0.1:1080", noProxy: [], fromEnv: false }),
    ).toThrow(/不支持 socks5/)
  })
})

describe("assertProxyEnvConsistent", () => {
  test("allows an explicit url regardless of the environment", () => {
    expect(() =>
      assertProxyEnvConsistent(
        { url: "http://127.0.0.1:10810", noProxy: [], fromEnv: false },
        { HTTPS_PROXY: "http://127.0.0.1:1" },
      ),
    ).not.toThrow()
  })

  test("rejects url + no_proxy when a proxy env var is set (direct path would fall back)", () => {
    expect(() =>
      assertProxyEnvConsistent(
        { url: "http://127.0.0.1:10810", noProxy: ["opencode.ai"], fromEnv: false },
        { HTTPS_PROXY: "http://127.0.0.1:1" },
      ),
    ).toThrow(/proxy\.url \+ proxy\.no_proxy 与环境变量 HTTPS_PROXY 冲突/)
  })

  test("allows url + no_proxy when the environment is clean", () => {
    expect(() =>
      assertProxyEnvConsistent(
        { url: "http://127.0.0.1:10810", noProxy: ["opencode.ai"], fromEnv: false },
        {},
      ),
    ).not.toThrow()
  })

  test("allows from_env even when the environment is set", () => {
    expect(() =>
      assertProxyEnvConsistent(
        { url: "", noProxy: [], fromEnv: true },
        { HTTPS_PROXY: "http://127.0.0.1:1" },
      ),
    ).not.toThrow()
  })

  test("allows from_env=false when the environment is clean", () => {
    expect(() =>
      assertProxyEnvConsistent({ url: "", noProxy: [], fromEnv: false }, {}),
    ).not.toThrow()
  })

  test("rejects from_env=false when a proxy env var is set", () => {
    expect(() =>
      assertProxyEnvConsistent({ url: "", noProxy: [], fromEnv: false }, {
        HTTPS_PROXY: "http://127.0.0.1:1",
      }),
    ).toThrow(/proxy\.fromEnv=false 与环境变量 HTTPS_PROXY 冲突/)
  })

  test("ignores empty environment values", () => {
    expect(() =>
      assertProxyEnvConsistent({ url: "", noProxy: [], fromEnv: false }, {
        HTTP_PROXY: "  ",
      }),
    ).not.toThrow()
  })

  test("ALL_PROXY alone is not a conflict (1.3.14 ignores it)", () => {
    expect(() =>
      assertProxyEnvConsistent({ url: "", noProxy: [], fromEnv: false }, {
        ALL_PROXY: "http://127.0.0.1:1",
      }),
    ).not.toThrow()
  })
})

describe("OutboundState", () => {
  test("reports the configured proxy without credentials", () => {
    const state = new OutboundState(
      { url: "http://alice:s3cret@127.0.0.1:10810", noProxy: [], fromEnv: false },
      EMPTY_ENV,
    )
    expect(state.configured).toBe("http://127.0.0.1:10810")
    const route = state.route("https://opencode.ai/zen/v1/chat/completions")
    expect(route.effective).toBe("http://127.0.0.1:10810")
    expect(route.option).toBe("http://alice:s3cret@127.0.0.1:10810/")
  })

  test("normalizes a proxy url without scheme before passing it to fetch", () => {
    const state = new OutboundState(
      { url: "127.0.0.1:10810", noProxy: [], fromEnv: false },
      EMPTY_ENV,
    )
    const route = state.route("https://opencode.ai/zen/v1/chat/completions")
    expect(route.option).toBe("http://127.0.0.1:10810/")
    expect(route.effective).toBe("http://127.0.0.1:10810")
  })

  test("routes direct when no_proxy matches", () => {
    const state = new OutboundState(
      { url: "http://127.0.0.1:10810", noProxy: ["opencode.ai"], fromEnv: false },
      EMPTY_ENV,
    )
    const route = state.route("https://opencode.ai/zen/v1/chat/completions")
    expect(route.effective).toBe("direct")
    expect(route.option).toBeUndefined()
  })

  test("probe reflects the effective route for the upstream", () => {
    const state = new OutboundState(
      { url: "", noProxy: [], fromEnv: true },
      { HTTPS_PROXY: "http://127.0.0.1:10810" },
    )
    expect(state.probe("https://opencode.ai")).toBe("http://127.0.0.1:10810")
    expect(state.probe("http://opencode.ai")).toBe("direct")
  })
})
