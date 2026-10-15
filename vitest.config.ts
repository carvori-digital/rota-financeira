import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    // Bound CPU contention in isolated audit/CI environments; keep test deadlines.
    pool: "threads",
    maxWorkers: 1,
    fileParallelism: false,
    include: [
      "tests/ui.test.tsx",
      "tests/sprint03-ui.test.tsx",
      "tests/adjust04-ui.test.tsx",
      "tests/hotfix-ui.test.tsx",
    ],
    clearMocks: true,
  },
});
