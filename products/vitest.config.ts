import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@products/shared": fileURLToPath(new URL("./shared/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["shared/tests/**/*.test.ts", "*/*/tests/**/*.test.ts", "scripts/tests/**/*.test.ts"],
    exclude: ["**/node_modules/**", "dist/**", "templates/**"],
    environment: "node",
    restoreMocks: true,
  },
});
