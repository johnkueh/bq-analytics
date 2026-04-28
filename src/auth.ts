import { createSign } from "node:crypto";

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
  if (process.env.VERCEL_OIDC_TOKEN) return exchangeVercelOidc(scope);
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON)
    return fromServiceAccountJson(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON, scope);
  return fromAdc(scope);
}

async function exchangeVercelOidc(scope: string): Promise<CachedToken> {
  const projectNumber = required("GCP_PROJECT_NUMBER");
  const poolId = required("GCP_WORKLOAD_IDENTITY_POOL_ID");
  const providerId = required("GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID");
  const saEmail = required("GCP_SERVICE_ACCOUNT_EMAIL");
  const oidcToken = process.env.VERCEL_OIDC_TOKEN!;

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
  const { execSync } = await import("node:child_process");
  try {
    const token = execSync(
      `gcloud auth application-default print-access-token --scopes=${scope}`,
      { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
    return { token, expiresAt: Date.now() + 50 * 60 * 1000 };
  } catch (err) {
    throw new Error(
      "bq-analytics: no auth available. Set VERCEL_OIDC_TOKEN, GOOGLE_APPLICATION_CREDENTIALS_JSON, or run `gcloud auth application-default login`.\n" +
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
