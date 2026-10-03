import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
const adapter = fileURLToPath(
  new URL("./experience-preview-data.mjs", import.meta.url),
);
export async function createExperienceServer(port = 5175) {
  const server = await createServer({
    configFile: false,
    envDir: false,
    plugins: [
      react(),
      {
        name: "local-preview-label",
        transformIndexHtml(html) {
          return html.replace(
            "<body>",
            '<body><div style="padding:8px 12px;text-align:center;background:#e7edda;color:#526542;font:11px system-ui">Prévia local · dados de demonstração · somente revisão visual</div>',
          );
        },
      },
    ],
    resolve: {
      alias: [{ find: /^(?:\.{1,2}\/)+lib\/supabase$/, replacement: adapter }],
    },
    define: { __RELEASE_COMMIT__: JSON.stringify("local-experience-preview") },
    server: { host: "127.0.0.1", port, strictPort: true },
  });
  await server.listen();
  return server;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const server = await createExperienceServer();
  console.log(
    "Prévia local: http://127.0.0.1:5175 — adaptador isolado, nenhuma conexão real com Supabase.",
  );
  const stop = async () => {
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
