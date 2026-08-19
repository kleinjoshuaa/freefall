import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import type { Response } from "express";
import { openHangar, type Hangar } from "./public/flight.js";
import type { FlightEvent } from "./public/types.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.PORT ?? 4321);

const app = express();
app.use(express.static(path.join(root, "public")));

let hangar: Hangar | undefined;

app.get("/api/state", (_req, res) => {
  res.json({
    hasKey: Boolean(process.env.CURSOR_API_KEY?.trim()),
    open: hangar !== undefined,
  });
});

/**
 * Newline-delimited JSON rather than SSE: the browser drives these with fetch()
 * from a button press, and EventSource cannot POST.
 */
function openStream(res: Response): (event: FlightEvent) => void {
  res.status(200);
  res.setHeader("content-type", "application/x-ndjson");
  res.setHeader("cache-control", "no-store");
  res.flushHeaders();
  return (event) => res.write(`${JSON.stringify(event)}\n`);
}

app.post("/api/launch", async (_req, res) => {
  const send = openStream(res);
  try {
    if (hangar) await hangar[Symbol.asyncDispose]();
    hangar = await openHangar({
      apiKey: process.env.CURSOR_API_KEY,
      cwd: root,
    });
    for await (const event of hangar.launch()) send(event);
  } catch (err) {
    send({
      kind: "failed",
      message: err instanceof Error ? err.message : String(err),
      retryable: false,
    });
  } finally {
    res.end();
  }
});

app.post("/api/harden", async (_req, res) => {
  const send = openStream(res);
  try {
    if (!hangar) throw new Error("launch first");
    for await (const event of hangar.harden()) send(event);
  } catch (err) {
    send({
      kind: "failed",
      message: err instanceof Error ? err.message : String(err),
      retryable: false,
    });
  } finally {
    res.end();
  }
});

app.listen(port, () => {
  console.log(`freefall on http://localhost:${port}`);
  if (!process.env.CURSOR_API_KEY?.trim()) {
    console.log("warning: CURSOR_API_KEY is not set — launch will fail");
  }
});
