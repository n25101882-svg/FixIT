import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
    clearMocks: true,
    restoreMocks: true,
    coverage: {
      provider: "v8",
      include: ["src/orders.tsx", "src/CancelOrderDialog.tsx"],
      reporter: ["text", "html", "json", "json-summary"],
      reportsDirectory: "./coverage",
      thresholds: {
        perFile: true,
        statements: 71,
        branches: 71,
        functions: 71,
        lines: 71,
      },
    },
  },
});
