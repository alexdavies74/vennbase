import { cpSync, createReadStream, existsSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const packageRoot = __dirname;
const workspaceRoot = resolve(packageRoot, "../..");
const coreAssetsRoot = resolve(workspaceRoot, "packages/vennbase-core/assets");

function vennbaseCoreAssetsPlugin(): Plugin {
  return {
    name: "vennbase-core-assets",
    configureServer(server) {
      server.middlewares.use("/core-assets", (req, res, next) => {
        const url = req.url?.replace(/^\/+/, "") ?? "";
        const filePath = resolve(coreAssetsRoot, url);
        if (!filePath.startsWith(coreAssetsRoot)) {
          res.statusCode = 403;
          res.end("Forbidden");
          return;
        }

        if (!existsSync(filePath) || !statSync(filePath).isFile()) {
          next();
          return;
        }

        res.setHeader("Content-Type", contentTypeFor(filePath));
        createReadStream(filePath).pipe(res);
      });
    },
    writeBundle(outputOptions) {
      if (!existsSync(coreAssetsRoot)) {
        return;
      }

      const outDir = outputOptions.dir
        ? resolve(packageRoot, outputOptions.dir)
        : resolve(packageRoot, "dist");
      cpSync(coreAssetsRoot, resolve(outDir, "core-assets"), { recursive: true });
    },
  };
}

function contentTypeFor(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}

export default defineConfig({
  plugins: [react(), vennbaseCoreAssetsPlugin()],
  server: {
    fs: {
      allow: [workspaceRoot],
    },
    port: 5175,
  },
  build: {
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      input: {
        main: resolve(packageRoot, "index.html"),
        reference: resolve(packageRoot, "reference/index.html"),
      },
    },
  },
});
