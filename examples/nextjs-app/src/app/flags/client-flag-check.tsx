"use client";

import { useEffect, useState } from "react";
import { Flags, httpSource } from "bq-analytics";

export function ClientFlagCheck({ userId, keys }: { userId: string; keys: string[] }) {
  const [results, setResults] = useState<Array<{ key: string; on: boolean }> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const f = new Flags({ source: httpSource({ url: "/api/flags" }) });
        await f.ready();
        if (cancelled) return;
        setResults(keys.map((k) => ({ key: k, on: f.isOn(k, userId) })));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId, keys]);

  if (error) return <p style={{ color: "crimson" }}>Error: {error}</p>;
  if (!results) return <p>Loading flags…</p>;

  return (
    <table style={{ borderCollapse: "collapse" }}>
      <thead>
        <tr>
          <th style={cell}>flag</th>
          <th style={cell}>isOn?</th>
        </tr>
      </thead>
      <tbody>
        {results.map(({ key, on }) => (
          <tr key={key}>
            <td style={cell}>
              <code>{key}</code>
            </td>
            <td style={cell}>{on ? "✅ on" : "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const cell = { padding: "6px 12px", borderBottom: "1px solid #eee", textAlign: "left" } as const;
