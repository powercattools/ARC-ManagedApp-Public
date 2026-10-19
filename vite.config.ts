import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { managedApps } from "@microsoft/managed-apps-vite-plugin";

// Shared review engine and result UI, vendored from CopilotStudioKitMakers/src.
const MAKERS = path.resolve(import.meta.dirname, "src/vendor/makers");
const ART_SRC = path.join(MAKERS, "features/agent-review-tool");

// https://vite.dev/config/
export default defineConfig({
  resolve: {
    alias: {
      "@review-ui": path.join(ART_SRC, "shared-ui"),
      "@art": ART_SRC,
    },
  },
  plugins: [react(), managedApps()],
});

