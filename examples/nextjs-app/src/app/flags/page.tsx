import { after } from "next/server";
import { flags } from "@/lib/flags";
import { flush } from "@/lib/analytics";
import { ClientFlagCheck } from "./client-flag-check";

/**
 * Demonstrates flag evaluation on both surfaces:
 *  - Server: flags().isOn(...) reads from Edge Config (or the inline
 *    fallback) directly. Exposures auto-track to events.raw via
 *    "$flag_called".
 *  - Client: <ClientFlagCheck /> below fetches /api/flags and evaluates
 *    in-process — same SDK, different source.
 */
export default async function FlagsPage() {
  const userId = "demo-user";
  await flags().ready();

  const checks = [
    "feedback-widget",
    "new-checkout",
    "ai-suggestions",
    "kill-old-flow",
  ] as const;

  const serverEval = checks.map((key) => ({
    key,
    on: flags().isOn(key, userId),
  }));

  after(() => flush());

  return (
    <main style={{ fontFamily: "system-ui", padding: 32, display: "grid", gap: 24 }}>
      <h1>Feature Flags</h1>
      <p>
        Server eval is direct (no HTTP). Client eval goes through{" "}
        <code>/api/flags</code> so the Edge Config token never hits the browser. Allowlists are
        stripped server-side.
      </p>

      <section>
        <h2>Server eval (userId = {userId})</h2>
        <table style={{ borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={cell}>flag</th>
              <th style={cell}>isOn?</th>
            </tr>
          </thead>
          <tbody>
            {serverEval.map(({ key, on }) => (
              <tr key={key}>
                <td style={cell}>
                  <code>{key}</code>
                </td>
                <td style={cell}>{on ? "✅ on" : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h2>Client eval</h2>
        <ClientFlagCheck userId={userId} keys={[...checks]} />
      </section>

      <section>
        <h2>Operate</h2>
        <pre style={{ background: "#f6f6f6", padding: 12, borderRadius: 6 }}>
{`# turn the widget off for everyone
pnpm bq-flags off feedback-widget

# half rollout of new-checkout
pnpm bq-flags rollout new-checkout 50%

# allowlist a beta tester
pnpm bq-flags allow ai-suggestions u_alice`}
        </pre>
      </section>
    </main>
  );
}

const cell = { padding: "6px 12px", borderBottom: "1px solid #eee", textAlign: "left" } as const;
