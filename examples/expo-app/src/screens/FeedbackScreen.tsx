// @ts-nocheck — copy into an Expo app to typecheck against react-native types.
import { useEffect, useState } from "react";
import { Button, Text, TextInput, View } from "react-native";
import { analytics, flags, setUserId } from "../lib/analytics";

export function FeedbackScreen({ userId }: { userId: string }) {
  const [message, setMessage] = useState("");
  const [sent, setSent] = useState(false);
  const [widgetOn, setWidgetOn] = useState<boolean | null>(null);

  useEffect(() => {
    setUserId(userId);
    analytics.identify(userId, { platform: "ios", app_version: "1.0.0" });
    (async () => {
      await flags.ready();
      setWidgetOn(flags.isOn("feedback-widget", userId));
    })();
  }, [userId]);

  async function submit() {
    analytics.feedback(
      {
        kind: "bug",
        message,
        properties: { app_version: "1.0.0" },
      },
      { userId },
    );
    await analytics.flush();
    setSent(true);
    setMessage("");
  }

  if (widgetOn === null) return <Text>Loading…</Text>;
  if (!widgetOn) return <Text>Feedback is currently disabled.</Text>;

  return (
    <View style={{ padding: 24, gap: 12 }}>
      <Text style={{ fontWeight: "600" }}>Send feedback</Text>
      <TextInput
        value={message}
        onChangeText={setMessage}
        placeholder="What broke?"
        multiline
        style={{ borderWidth: 1, borderColor: "#ddd", padding: 8, minHeight: 80 }}
      />
      <Button title="Send" onPress={submit} disabled={!message.trim()} />
      {sent && <Text style={{ color: "green" }}>Thanks — landed in BigQuery.</Text>}
    </View>
  );
}
