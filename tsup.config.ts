import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/auth.ts",
    "src/insert.ts",
    "src/transports/browser.ts",
    "src/transports/react-native.ts",
    "src/transports/pino.ts",
    "src/handlers/next.ts",
    "src/handlers/hono.ts",
    "src/cli/attach.ts",
  ],
  format: ["esm"],
  dts: true,
  clean: true,
  splitting: false,
  sourcemap: true,
  target: "es2022",
});
