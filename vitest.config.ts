import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: [
      "tests/ui.test.tsx",
      "tests/sprint03-ui.test.tsx",
      "tests/adjust04-ui.test.tsx",
      "tests/hotfix-ui.test.tsx",
    ],
    clearMocks: true,
  },
});
