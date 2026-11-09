import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Vite must not load the developer's repository .env during tests.
  envDir: fileURLToPath(new URL("./tests/fixtures/no-env/", import.meta.url)),
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    clearMocks: true,
    restoreMocks: true,
  },
});
