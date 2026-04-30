import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/index.rn.ts",
    "src/auth.ts",
    "src/insert.ts",
    "src/transports/browser.ts",
    "src/transports/react-native.ts",
    "src/transports/pino.ts",
    "src/handlers/next.ts",
    "src/handlers/next-flags.ts",
    "src/handlers/hono.ts",
    "src/cli/attach.ts",
    "src/flags.ts",
    "src/flag-sources/edge-config.ts",
    "src/flag-sources/http.ts",
  ],
  format: ["esm"],
  dts: true,
  clean: true,
  splitting: false,
  sourcemap: true,
  target: "es2022",
});
