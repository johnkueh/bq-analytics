"use client";

import { useState } from "react";
import { browserAnalytics } from "@/lib/browser-analytics";

export function FeedbackWidget({ userId }: { userId: string | null }) {
  const [kind, setKind] = useState<"bug" | "request" | "general">("general");
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!message.trim()) return;
    setStatus("sending");
    try {
      const a = browserAnalytics();
      a.feedback(
        {
          kind,
          subject: subject || undefined,
          message,
          url: typeof location !== "undefined" ? location.pathname + location.search : undefined,
          properties: {
            user_agent: typeof navigator !== "undefined" ? navigator.userAgent : null,
            app_version: "nextjs-example@0.1.0",
          },
        },
        { userId: userId ?? undefined },
      );
      await a.flush();
      setStatus("sent");
      setSubject("");
      setMessage("");
    } catch {
      setStatus("error");
    }
  }

  return (
    <form
      onSubmit={submit}
      style={{
        display: "grid",
        gap: 8,
        maxWidth: 480,
        padding: 16,
        border: "1px solid #ddd",
        borderRadius: 8,
      }}
    >
      <strong>Send feedback</strong>
      <label style={{ display: "grid", gap: 4 }}>
        <span style={{ fontSize: 12, color: "#666" }}>Type</span>
        <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
          <option value="general">General</option>
          <option value="bug">Bug</option>
          <option value="request">Feature request</option>
        </select>
      </label>
      <label style={{ display: "grid", gap: 4 }}>
        <span style={{ fontSize: 12, color: "#666" }}>Subject (optional)</span>
        <input
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder="Translate button does nothing"
        />
      </label>
      <label style={{ display: "grid", gap: 4 }}>
        <span style={{ fontSize: 12, color: "#666" }}>Message</span>
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={4}
          placeholder="Tell us what happened…"
          required
        />
      </label>
      <button type="submit" disabled={status === "sending" || !message.trim()}>
        {status === "sending" ? "Sending…" : "Send"}
      </button>
      {status === "sent" && <span style={{ color: "green" }}>Thanks — landed in BigQuery.</span>}
      {status === "error" && <span style={{ color: "crimson" }}>Send failed (saved locally for retry).</span>}
    </form>
  );
}
