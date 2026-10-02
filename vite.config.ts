import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
const commit =
  process.env.VITE_RELEASE_COMMIT ||
  process.env.VERCEL_GIT_COMMIT_SHA ||
  (() => {
    try {
      return execFileSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim();
    } catch {
      return "local";
    }
  })();
export default defineConfig({
  plugins: [
    react(),
    {
      name: "release-identity",
      apply: "build",
      closeBundle() {
        writeFileSync(
          "dist/release.json",
          JSON.stringify({ version: "0.2.0", commit }),
        );
        writeFileSync(
          "dist/sw.js",
          readFileSync("public/sw.js", "utf8") +
            "\n// Release: " +
            commit +
            "\n",
        );
      },
    },
  ],
  define: { __RELEASE_COMMIT__: JSON.stringify(commit) },
});
