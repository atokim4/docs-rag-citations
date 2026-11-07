import { join } from "node:path";
import { serveDemo } from "../scripts/serve.js";

/** Starts the static server on a free port; tests read the URL from DEMO_URL. */
export default async function setup(): Promise<() => Promise<void>> {
  const { server, url } = await serveDemo(join(import.meta.dirname, "..", "dist"));
  process.env.DEMO_URL = url;
  return () => new Promise((done) => server.close(() => done()));
}
