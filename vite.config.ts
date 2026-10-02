import path from "path";
import { fileURLToPath } from "url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// https://vite.dev/config/
export default defineConfig({
  // Absolute base so client-side routing (/admin, /app, /portal/:slug) works.
  base: "/",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  server: {
    port: 5173,
    strictPort: false,
    // Lets you call the Edge Functions through the dev server if needed.
    proxy: {
      "/api": {
        target: "http://localhost:54321",
        changeOrigin: true,
        rewrite: (p) => `/functions/v1${p.replace(/^\/api/, "")}`,
      },
    },
  },
  build: {
    outDir: "dist",
    // The app is code-split per route, so keep the vendor chunk separate
    // from app logic for better caching.
    rollupOptions: {
      output: {
        manualChunks: {
          react: ["react", "react-dom", "react-router-dom"],
          supabase: ["@supabase/supabase-js"],
        },
      },
    },
  },
});
