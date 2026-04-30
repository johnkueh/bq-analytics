import { after } from "next/server";
import { FeedbackWidget } from "./feedback-widget";
import { flags } from "@/lib/flags";
import { analytics, flush } from "@/lib/analytics";

/**
 * Demonstrates the full feedback round-trip:
 *  - Server-side feedback() (page-load event) → direct BQ insert
 *  - Client-side feedback() (the widget) → /api/track → BQ
 *
 * The widget itself is gated by the "feedback-widget" feature flag — flip
 * it off in Edge Config (or the static fallback in src/lib/flags.ts) to
 * confirm the gate works.
 */
export default async function FeedbackPage() {
  const userId = "demo-user";
  await flags().ready();
  const widgetOn = flags().isOn("feedback-widget", userId);

  // Server-side feedback example — fires on every page render
  analytics().feedback(
    {
      kind: "general",
      message: "Server-side feedback render — example ping from /feedback page.",
      properties: { source: "ssr-demo" },
    },
    { userId },
  );
  after(() => flush());

  return (
    <main style={{ fontFamily: "system-ui", padding: 32, display: "grid", gap: 24 }}>
      <h1>Product Feedback</h1>
      <p>
        Feedback rides the same intake as <code>track</code> / <code>identify</code> /{" "}
        <code>group</code>. Browser submissions go through <code>/api/track</code>; servers and CLIs
        write to BigQuery directly. Stored in <code>events.feedback</code>, joinable with{" "}
        <code>events.users</code> on <code>user_id</code> so an agent has one query for the full
        story.
      </p>

      {widgetOn ? (
        <FeedbackWidget userId={userId} />
      ) : (
        <p style={{ color: "#666" }}>
          The <code>feedback-widget</code> flag is off. Flip it on in Edge Config (or in{" "}
          <code>src/lib/flags.ts</code> fallback) to render the widget.
        </p>
      )}

      <section>
        <h2>Verify in BigQuery</h2>
        <pre style={{ background: "#f6f6f6", padding: 12, borderRadius: 6, overflowX: "auto" }}>
{`bq query --nouse_legacy_sql --format=prettyjson "
  SELECT kind, subject, message, user_id, JSON_VALUE(properties, '$.source') AS source
  FROM \\\`PROJECT.events.feedback\\\`
  ORDER BY ts DESC LIMIT 20
"`}
        </pre>
      </section>
    </main>
  );
}
