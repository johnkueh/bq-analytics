// IMPORTANT: do NOT import node:crypto / node:child_process at top-level.
// React Native + browser bundlers (Metro, Webpack) statically analyse top-
// level imports and choke on `node:` specifiers — even though RN consumers
// only use httpTransport and never reach the server-only auth paths below.
// We use string-variable dynamic imports inside the (Node-only) functions
// that need them, which bundlers cannot statically resolve.

interface CachedToken {
  token: string;
  expiresAt: number;
}

const cache = new Map<string, CachedToken>();

export interface AuthOptions {
  scope?: string;
}

const DEFAULT_SCOPE = "https://www.googleapis.com/auth/bigquery.insertdata";

export async function getAccessToken(opts: AuthOptions = {}): Promise<string> {
  const scope = opts.scope ?? DEFAULT_SCOPE;
  const cached = cache.get(scope);
  const now = Date.now();
  if (cached && cached.expiresAt > now + 60_000) return cached.token;

  const result = await fetchToken(scope);
  cache.set(scope, result);
  return result.token;
}

async function fetchToken(scope: string): Promise<CachedToken> {
  // Explicit override (mostly for local testing / smoke runs).
  if (process.env.BQA_ACCESS_TOKEN) {
    return { token: process.env.BQA_ACCESS_TOKEN, expiresAt: Date.now() + 30 * 60 * 1000 };
  }

  // Vercel OIDC. Modern Vercel runtimes do NOT expose VERCEL_OIDC_TOKEN
  // as an env var — the token is per-request and must be fetched via
  // `@vercel/functions/oidc`. We try that first, fall back to the env
  // var for older runtimes / non-Vercel injection paths.
  const oidc = await readVercelOidcToken();
  if (oidc) return exchangeVercelOidc(oidc, scope);

  if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON)
    return fromServiceAccountJson(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON, scope);
  return fromAdc(scope);
}

async function readVercelOidcToken(): Promise<string | null> {
  // Older runtimes / explicit override
  if (process.env.VERCEL_OIDC_TOKEN) return process.env.VERCEL_OIDC_TOKEN;
  // Modern Vercel runtime — token lives in async-local request context,
  // surfaced by @vercel/functions/oidc. Optional dep — if not installed
  // we just return null and the caller falls through to other auth paths.
  try {
    const mod = (await import("@vercel/functions/oidc")) as {
      getVercelOidcToken?: () => Promise<string | null | undefined>;
    };
    if (typeof mod.getVercelOidcToken === "function") {
      const tok = await mod.getVercelOidcToken();
      return tok || null;
    }
  } catch {
    // not installed in this project
  }
  return null;
}

async function exchangeVercelOidc(oidcToken: string, scope: string): Promise<CachedToken> {
  const projectNumber = required("GCP_PROJECT_NUMBER");
  const poolId = required("GCP_WORKLOAD_IDENTITY_POOL_ID");
  const providerId = required("GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID");
  const saEmail = required("GCP_SERVICE_ACCOUNT_EMAIL");

  const sts = await fetch("https://sts.googleapis.com/v1/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      audience: `//iam.googleapis.com/projects/${projectNumber}/locations/global/workloadIdentityPools/${poolId}/providers/${providerId}`,
      scope: "https://www.googleapis.com/auth/cloud-platform",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
      subject_token: oidcToken,
    }),
  });
  if (!sts.ok) throw new Error(`STS exchange failed (${sts.status}): ${await sts.text()}`);
  const { access_token: federatedToken } = (await sts.json()) as { access_token: string };

  const imp = await fetch(
    `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${saEmail}:generateAccessToken`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${federatedToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ scope: [scope], lifetime: "3600s" }),
    },
  );
  if (!imp.ok) throw new Error(`SA impersonation failed (${imp.status}): ${await imp.text()}`);
  const { accessToken, expireTime } = (await imp.json()) as {
    accessToken: string;
    expireTime: string;
  };
  return { token: accessToken, expiresAt: Date.parse(expireTime) };
}

async function fromServiceAccountJson(json: string, scope: string): Promise<CachedToken> {
  if (typeof process === "undefined" || !process.versions?.node) {
    throw new Error("Service account JSON auth is Node.js-only");
  }
  // String-variable form so RN/browser bundlers don't try to resolve at build time.
  const cryptoModuleId = "node:" + "crypto";
  const { createSign } = (await import(cryptoModuleId)) as typeof import("node:crypto");
  const creds = JSON.parse(json) as { client_email: string; private_key: string };
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: creds.client_email,
    scope,
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  };
  const header = { alg: "RS256", typ: "JWT" };
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const signingInput = `${enc(header)}.${enc(claims)}`;
  const sig = createSign("RSA-SHA256")
    .update(signingInput)
    .sign(creds.private_key, "base64url");
  const jwt = `${signingInput}.${sig}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!res.ok) throw new Error(`Service account token fetch failed: ${await res.text()}`);
  const data = (await res.json()) as { access_token: string; expires_in: number };
  return { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
}

async function fromAdc(scope: string): Promise<CachedToken> {
  if (typeof process === "undefined" || !process.versions?.node) {
    throw new Error("ADC auth is Node.js-only");
  }
  // String-variable form so RN/browser bundlers don't try to resolve at build time.
  const childProcId = "node:" + "child_process";
  const { execSync } = (await import(childProcId)) as typeof import("node:child_process");
  try {
    const token = execSync(
      `gcloud auth application-default print-access-token --scopes=${scope}`,
      { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
    return { token, expiresAt: Date.now() + 50 * 60 * 1000 };
  } catch (err) {
    throw new Error(
      "bq-analytics: no auth available. Install @vercel/functions (Vercel runtime), set VERCEL_OIDC_TOKEN env var, set GOOGLE_APPLICATION_CREDENTIALS_JSON, or run `gcloud auth application-default login`.\n" +
        `Underlying error: ${(err as Error).message}`,
    );
  }
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`bq-analytics: env var ${name} is required for Vercel OIDC auth`);
  return v;
}

export function __resetTokenCache() {
  cache.clear();
}
