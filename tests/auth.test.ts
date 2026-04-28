import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { __resetTokenCache, getAccessToken } from "../src/auth.js";

describe("auth", () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    __resetTokenCache();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const k of Object.keys(process.env)) {
      if (!(k in originalEnv)) delete process.env[k];
    }
    Object.assign(process.env, originalEnv);
  });

  it("Vercel OIDC path: STS exchange + SA impersonation", async () => {
    process.env.VERCEL_OIDC_TOKEN = "fake-oidc";
    process.env.GCP_PROJECT_NUMBER = "111";
    process.env.GCP_WORKLOAD_IDENTITY_POOL_ID = "vercel";
    process.env.GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID = "vercel";
    process.env.GCP_SERVICE_ACCOUNT_EMAIL = "sa@p.iam.gserviceaccount.com";

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("sts.googleapis.com")) {
        return new Response(JSON.stringify({ access_token: "federated-tok" }), {
          status: 200,
        });
      }
      if (url.includes("iamcredentials.googleapis.com")) {
        return new Response(
          JSON.stringify({
            accessToken: "sa-tok",
            expireTime: new Date(Date.now() + 3600_000).toISOString(),
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected url ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const tok = await getAccessToken();
    expect(tok).toBe("sa-tok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("caches the token across calls within validity window", async () => {
    process.env.VERCEL_OIDC_TOKEN = "fake-oidc";
    process.env.GCP_PROJECT_NUMBER = "111";
    process.env.GCP_WORKLOAD_IDENTITY_POOL_ID = "vercel";
    process.env.GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID = "vercel";
    process.env.GCP_SERVICE_ACCOUNT_EMAIL = "sa@p.iam.gserviceaccount.com";

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("sts.googleapis.com"))
        return new Response(JSON.stringify({ access_token: "f" }), { status: 200 });
      return new Response(
        JSON.stringify({
          accessToken: "sa-tok",
          expireTime: new Date(Date.now() + 3600_000).toISOString(),
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await getAccessToken();
    await getAccessToken();
    await getAccessToken();
    expect(fetchMock).toHaveBeenCalledTimes(2); // only one round-trip pair, then cache
  });

  it("missing required env throws a helpful error", async () => {
    process.env.VERCEL_OIDC_TOKEN = "fake-oidc";
    delete process.env.GCP_PROJECT_NUMBER;
    await expect(getAccessToken()).rejects.toThrow(/GCP_PROJECT_NUMBER/);
  });
});
