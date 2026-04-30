# expo-app — bq-analytics example

Skeleton showing the React Native / Expo wiring for `bq-analytics`. Not a
runnable Expo project — the surrounding monorepo doesn't depend on Expo
tooling. Copy `src/lib/analytics.ts` and `src/screens/FeedbackScreen.tsx`
into a real Expo app to drive end-to-end.

## What it demonstrates

- `Analytics` + `reactNativeTransport` with AsyncStorage retry queue
- `attachExpoErrorHandler` / `attachAppStateFlush` lifecycle hooks
- `analytics.identify()` + `analytics.track()` + `analytics.feedback()`
  all hitting `/api/track` on your Vercel/Next.js backend
- Client-side flag check via `httpSource({ url: \`\${API_URL}/api/flags\` })`
  — never expose Edge Config token to the device

## Wiring it up

In a fresh `npx create-expo-app`:

```sh
pnpm add bq-analytics @react-native-async-storage/async-storage
```

Then drop `src/lib/analytics.ts` and `src/screens/FeedbackScreen.tsx` into
the new project. Point `API_URL` at your Next.js deploy. The same
`/api/track` route the browser uses serves the device.
