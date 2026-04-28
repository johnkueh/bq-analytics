import { track, identify, flush } from "@/lib/analytics";
import { after } from "next/server";

export default async function Page() {
  // Server-side track example. In a real app userId would come from your
  // auth provider; we use a stable sentinel here for the demo.
  identify("demo-user", { plan: "free", signup_country: "AU" });
  track(
    "page.viewed",
    { path: "/", source: "homepage" },
    { userId: "demo-user", sessionId: "demo-session" },
  );
  after(() => flush());

  return (
    <main style={{ fontFamily: "system-ui", padding: 32 }}>
      <h1>bq-analytics — Next.js example</h1>
      <p>This page calls <code>identify()</code> + <code>track()</code> on every render and flushes via <code>after()</code>. Check BigQuery for the rows.</p>
      <pre>
{`bq query "SELECT event_name, ts, user_id FROM \`PROJECT.events.raw\`
            WHERE event_name = 'page.viewed' ORDER BY ts DESC LIMIT 5"`}
      </pre>
    </main>
  );
}
