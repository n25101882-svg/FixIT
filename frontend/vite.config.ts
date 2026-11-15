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
      include: ["src/orders.tsx", "src/CancelOrderDialog.tsx", "src/catalog.tsx", "src/master-services.tsx", "src/master-orders.tsx", "src/standard-order.tsx", "src/standard-return.ts", "src/order-details.tsx", "src/order-return.ts"],
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
