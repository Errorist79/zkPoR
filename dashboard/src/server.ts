/**
 * The listener.
 *
 * It binds the loopback address, which is a constant of this package and not a
 * setting. No environment variable and no argument moves it, so there is no
 * address here that a reader can misconfigure.
 */

import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { LOOPBACK_HOST, MAX_BODY_BYTES } from "./constants.js";
import type { Dashboard, DashboardResponse } from "./routes.js";
import { responseHeaders, route } from "./routes.js";

/** The value of one header, when the request carries exactly one of it. */
function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  if (typeof value === "string") {
    return value;
  }
  return undefined;
}

/**
 * The body of a request, as text.
 *
 * A body over the limit stops the read. The dashboard takes a path and never a
 * file, so a large body is a mistake or an attack and never a real submission.
 */
async function readBody(request: IncomingMessage): Promise<string> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += part.length;
    if (size > MAX_BODY_BYTES) {
      throw new Error(`the request body is longer than ${MAX_BODY_BYTES} bytes`);
    }
    parts.push(part);
  }
  return Buffer.concat(parts).toString("utf8");
}

/**
 * Writes one answer.
 *
 * Every answer of this process goes through here, so no branch can serve a
 * page that the content security policy does not govern.
 */
function send(response: ServerResponse, answered: DashboardResponse): void {
  response.writeHead(answered.status, responseHeaders(answered));
  response.end(answered.body);
}

async function answer(
  request: IncomingMessage,
  response: ServerResponse,
  dashboard: Dashboard,
): Promise<void> {
  let body = "";
  if (request.method === "POST") {
    try {
      body = await readBody(request);
    } catch {
      // Every answer leaves through one place, so every answer carries the
      // policy. A branch with a header object of its own would serve a page
      // that the policy does not govern.
      send(response, {
        status: 413,
        contentType: "text/plain; charset=utf-8",
        body: "The request body is too long.\n",
      });
      return;
    }
  }
  const answered = await route(
    {
      method: request.method ?? "GET",
      target: request.url ?? "/",
      host: header(request, "host"),
      fetchSite: header(request, "sec-fetch-site"),
      body,
    },
    dashboard,
  );
  send(response, answered);
}

/**
 * A listener that answers on the loopback address of this machine.
 *
 * The caller names the port only. The host is the constant above.
 */
export function openDashboard(input: { port: number; dashboard: Dashboard }): Promise<Server> {
  const server = createServer((request, response) => {
    answer(request, response, input.dashboard).catch(() => {
      // The route function answers every failure it can describe. A failure
      // that reaches here leaves the connection without a body, so the reader
      // sees a broken request rather than a page that states nothing.
      response.destroy();
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: LOOPBACK_HOST, port: input.port }, () => {
      resolve(server);
    });
  });
}
