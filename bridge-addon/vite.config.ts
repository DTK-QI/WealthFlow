import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));
const defaultOrigin = process.env.WEALTHFLOW_ADDON_ORIGIN?.trim() || "https://wealthflow.invalid";

export default defineConfig({
  root,
  plugins: [react()],
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
    __WEALTHFLOW_DEFAULT_ORIGIN__: JSON.stringify(defaultOrigin),
  },
  build: {
    target: ["chrome107", "edge107", "firefox104", "safari16"],
    lib: {
      entry: fileURLToPath(new URL("./src/addon.tsx", import.meta.url)),
      fileName: () => "addon.js",
      formats: ["es"],
    },
    outDir: "dist",
    emptyOutDir: true,
    minify: true,
    sourcemap: false,
    rollupOptions: {
      external: [
        "@tanstack/react-query",
        "@wealthfolio/addon-sdk",
        "@wealthfolio/addon-sdk/host-api",
        "@wealthfolio/addon-sdk/host-dependencies",
        "@wealthfolio/addon-sdk/manifest",
        "@wealthfolio/addon-sdk/permissions",
        "@wealthfolio/addon-sdk/types",
        "@wealthfolio/addon-sdk/utils",
        "@wealthfolio/ui",
        "@wealthfolio/ui/chart",
        "date-fns",
        "lucide-react",
        "react",
        "react-dom",
        "react-dom/client",
        "react/jsx-dev-runtime",
        "react/jsx-runtime",
        "recharts"
      ]
    }
  }
});
