const fs = require("fs");
const http = require("http");
const path = require("path");

const DEFAULT_PORT = Number(process.env.PORT_TABS_PORT || 17368);
const HOST = "127.0.0.1";
const APP_VERSION = "0.3.4";
const DEFAULT_TIMEOUT_MS = Number(process.env.PORT_TABS_TIMEOUT_MS || 30000);
const MAX_BODY_BYTES = Number(process.env.PORT_TABS_MAX_BODY_BYTES || 10 * 1024 * 1024);

const pending = new Map();
const eventLog = [];
const sseClients = new Set();
let nextId = 1;
let nativeBuffer = Buffer.alloc(0);
let extensionConnected = false;
let configuredPort = DEFAULT_PORT;
let currentPort = null;
let server = null;
let lastListenError = null;
let nextEventId = 1;
let profileName = "";
let profileNote = "";
let displayName = `Browser on ${DEFAULT_PORT}`;

function log(...args) {
  console.error("[port-tabs]", ...args);
}

function writeNativeMessage(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([header, body]));
}

function pushEvent(channel, event) {
  const item = {
    eventId: nextEventId++,
    channel,
    time: Date.now(),
    ...event
  };
  eventLog.push(item);
  if (eventLog.length > 5000) {
    eventLog.splice(0, eventLog.length - 5000);
  }
  for (const client of sseClients) {
    if (client.channel !== "all" && client.channel !== channel) continue;
    client.response.write(`event: ${channel}\n`);
    client.response.write(`id: ${item.eventId}\n`);
    client.response.write(`data: ${JSON.stringify(item)}\n\n`);
  }
  return item;
}

function filterEvents(query) {
  const limit = Number(query.limit || 500);
  const channel = query.channel || "all";
  return eventLog
    .filter((event) => channel === "all" || event.channel === channel)
    .slice(-limit);
}

function openEventStream(request, response, query) {
  const channel = query.channel || "all";
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no"
  });
  response.write(`event: ready\n`);
  response.write(`data: ${JSON.stringify({ ok: true, channel, baseUrl: baseUrl() })}\n\n`);
  const client = { response, channel };
  sseClients.add(client);
  request.on("close", () => {
    sseClients.delete(client);
  });
}

function normalizePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return port;
}

function baseUrl() {
  return `http://${HOST}:${configuredPort}`;
}

function startHttpServer(portValue) {
  const port = normalizePort(portValue || DEFAULT_PORT);
  configuredPort = port;
  lastListenError = null;

  if (server && currentPort === port) {
    return;
  }

  if (server) {
    const oldServer = server;
    server = null;
    currentPort = null;
    oldServer.close(() => log("stopped listening"));
  }

  const nextServer = http.createServer(handleHttpRequest);
  nextServer.once("error", (error) => {
    lastListenError = error.message;
    if (server === nextServer) {
      server = null;
      currentPort = null;
    }
    log(`server error on ${HOST}:${port}:`, error.message);
  });
  nextServer.listen(port, HOST, () => {
    server = nextServer;
    currentPort = port;
    log(`listening on http://${HOST}:${port}`);
  });
}

function handleNativeMessage(message) {
  if (message.type === "hello" || message.type === "configure") {
    extensionConnected = true;
    profileName = String(message.profileName || "").trim();
    profileNote = String(message.profileNote || "").trim();
    displayName = String(message.displayName || profileName || `Browser on ${message.port || DEFAULT_PORT}`).trim();
    try {
      startHttpServer(message.port || DEFAULT_PORT);
      log(`extension connected, requested port ${configuredPort}, displayName=${displayName}`);
    } catch (error) {
      lastListenError = error.message;
      log("failed to configure port:", error.message);
    }
    return;
  }

  if (message.type === "event") {
    pushEvent(message.channel || "extension", message.event || {});
    return;
  }

  if (message.type === "result" && pending.has(message.id)) {
    const resolve = pending.get(message.id);
    pending.delete(message.id);
    resolve(message);
  }
}

function readNativeMessages(chunk) {
  nativeBuffer = Buffer.concat([nativeBuffer, chunk]);

  while (nativeBuffer.length >= 4) {
    const length = nativeBuffer.readUInt32LE(0);
    if (nativeBuffer.length < 4 + length) {
      return;
    }

    const json = nativeBuffer.subarray(4, 4 + length).toString("utf8");
    nativeBuffer = nativeBuffer.subarray(4 + length);

    try {
      handleNativeMessage(JSON.parse(json));
    } catch (error) {
      log("bad native message:", error.message);
    }
  }
}

function sendExtensionCommand(command, payload = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const id = nextId++;

  const resultPromise = new Promise((resolve) => {
    pending.set(id, resolve);
  });

  writeNativeMessage({
    type: "command",
    command,
    id,
    payload
  });

  return Promise.race([
    resultPromise,
    new Promise((resolve) => {
      setTimeout(() => {
        pending.delete(id);
        resolve({
          type: "result",
          id,
          ok: false,
          error: `Timed out after ${timeoutMs}ms waiting for extension response.`
        });
      }, timeoutMs);
    })
  ]);
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(`${JSON.stringify(payload, null, 2)}\n`);
}

function sendText(response, statusCode, text) {
  response.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(text);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body is too large."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });

    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

async function readJsonBody(request) {
  const body = await readBody(request);
  if (!body.trim()) {
    return {};
  }
  return JSON.parse(body);
}

function queryPayload(url) {
  const payload = {};
  for (const [key, value] of url.searchParams.entries()) {
    if (value === "true") payload[key] = true;
    else if (value === "false") payload[key] = false;
    else if (/^-?\d+(\.\d+)?$/.test(value)) payload[key] = Number(value);
    else payload[key] = value;
  }
  return payload;
}

async function payloadFromRequest(request, url) {
  const query = queryPayload(url);
  if (request.method === "GET" || request.method === "HEAD") {
    return query;
  }

  const body = await readJsonBody(request);
  return { ...query, ...body };
}

async function commandResponse(response, command, payload, options = {}) {
  if (!extensionConnected) {
    sendJson(response, 503, {
      ok: false,
      error: "Extension is not connected. Reload or click the extension first."
    });
    return null;
  }

  const result = await sendExtensionCommand(command, payload, Number(payload.timeoutMs) || options.timeoutMs || DEFAULT_TIMEOUT_MS);
  if (options.after) {
    await options.after(result, payload);
  }
  sendJson(response, result.ok ? 200 : 500, result);
  return result;
}

function screenshotData(result) {
  return result && result.result && result.result.data;
}

function saveBase64(filePath, base64) {
  if (!filePath) {
    return null;
  }
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, Buffer.from(base64, "base64"));
  return resolved;
}

const API = [
  {
    method: "GET",
    path: "/health",
    summary: "Check HTTP server and extension connection status.",
    example: "curl http://127.0.0.1:17368/health"
  },
  {
    method: "GET",
    path: "/tabs",
    summary: "List browser tabs.",
    example: "curl http://127.0.0.1:17368/tabs"
  },
  {
    method: "GET",
    path: "/tab",
    summary: "Get the current active tab.",
    example: "curl http://127.0.0.1:17368/tab"
  },
  {
    method: "GET",
    path: "/windows",
    summary: "List browser windows.",
    query: { populate: "boolean, optional" },
    example: "curl http://127.0.0.1:17368/windows?populate=true"
  },
  {
    method: "POST",
    path: "/open",
    summary: "Open a URL in a new tab.",
    body: { url: "string", active: "boolean, optional", windowId: "number, optional" },
    example: "curl -X POST http://127.0.0.1:17368/open -H \"content-type: application/json\" -d \"{\\\"url\\\":\\\"https://www.baidu.com/\\\"}\""
  },
  {
    method: "POST",
    path: "/goto",
    summary: "Navigate the active or specified tab.",
    body: { url: "string", tabId: "number, optional" },
    example: "curl -X POST http://127.0.0.1:17368/goto -H \"content-type: application/json\" -d \"{\\\"url\\\":\\\"https://example.com\\\"}\""
  },
  {
    method: "POST",
    path: "/back",
    summary: "Go back in tab history.",
    body: { tabId: "number, optional" }
  },
  {
    method: "POST",
    path: "/forward",
    summary: "Go forward in tab history.",
    body: { tabId: "number, optional" }
  },
  {
    method: "POST",
    path: "/reload",
    summary: "Reload a tab.",
    body: { tabId: "number, optional", bypassCache: "boolean, optional" }
  },
  {
    method: "POST",
    path: "/close",
    summary: "Close the active or specified tab.",
    body: { tabId: "number, optional" }
  },
  {
    method: "POST",
    path: "/activate",
    summary: "Activate a tab.",
    body: { tabId: "number" }
  },
  {
    method: "POST",
    path: "/click",
    summary: "Click an element by CSS selector or viewport coordinates.",
    body: { selector: "string, optional", x: "number, optional", y: "number, optional", tabId: "number, optional", double: "boolean, optional", button: "left|middle|right, optional" },
    example: "curl -X POST http://127.0.0.1:17368/click -H \"content-type: application/json\" -d \"{\\\"selector\\\":\\\"#su\\\"}\""
  },
  {
    method: "POST",
    path: "/fill",
    summary: "Fill an input, textarea, select, checkbox, radio, or contenteditable element.",
    body: { selector: "string", value: "string|boolean", tabId: "number, optional" },
    example: "curl -X POST http://127.0.0.1:17368/fill -H \"content-type: application/json\" -d \"{\\\"selector\\\":\\\"#kw\\\",\\\"value\\\":\\\"test\\\"}\""
  },
  {
    method: "POST",
    path: "/key",
    summary: "Type text or dispatch keyboard events.",
    body: { selector: "string, optional", text: "string, optional", key: "string, optional", keys: "string, optional", tabId: "number, optional" }
  },
  {
    method: "POST",
    path: "/scroll",
    summary: "Scroll the page or an element.",
    body: { selector: "string, optional", x: "number, optional", y: "number, optional", to: "object, optional", tabId: "number, optional" }
  },
  {
    method: "POST",
    path: "/wait",
    summary: "Wait for text, selector, or disappearance.",
    body: { selector: "string, optional", text: "string, optional", gone: "string, optional", timeout: "number, optional", tabId: "number, optional" }
  },
  {
    method: "POST",
    path: "/eval",
    summary: "Evaluate JavaScript in the active or specified page. Defaults to world=MAIN so page globals and open shadow DOM are visible.",
    body: { expression: "string", code: "string, alias of expression", tabId: "number, optional", world: "MAIN|ISOLATED, optional default MAIN" },
    example: "curl -X POST http://127.0.0.1:17368/eval -H \"content-type: application/json\" -d \"{\\\"expression\\\":\\\"document.title\\\"}\""
  },
  {
    method: "POST",
    path: "/content",
    summary: "Extract page title, URL, text, links, images, forms, meta, and optionally HTML.",
    body: { tabId: "number, optional", html: "boolean, optional", maxText: "number, optional", maxHtml: "number, optional", maxLinks: "number, optional", maxImages: "number, optional" }
  },
  {
    method: "POST",
    path: "/snapshot",
    summary: "Return a compact visible DOM snapshot.",
    body: { tabId: "number, optional", maxNodes: "number, optional", maxDepth: "number, optional" }
  },
  {
    method: "POST",
    path: "/interactive",
    summary: "List visible interactive elements with selectors and bounds.",
    body: { tabId: "number, optional", limit: "number, optional" }
  },
  {
    method: "POST",
    path: "/screenshot",
    summary: "Capture a screenshot via CDP and optionally save it to disk.",
    body: { tabId: "number, optional", format: "png|jpeg, optional", quality: "number, optional", path: "string, optional", omitData: "boolean, optional" }
  },
  {
    method: "POST",
    path: "/cdp",
    summary: "Send a raw Chrome DevTools Protocol command.",
    body: { tabId: "number, optional", method: "string", params: "object, optional" },
    example: "curl -X POST http://127.0.0.1:17368/cdp -H \"content-type: application/json\" -d \"{\\\"method\\\":\\\"Runtime.evaluate\\\",\\\"params\\\":{\\\"expression\\\":\\\"location.href\\\",\\\"returnByValue\\\":true}}\""
  },
  {
    method: "POST",
    path: "/network/start",
    summary: "Enable CDP Network events for the active or specified tab.",
    body: { tabId: "number, optional" }
  },
  {
    method: "GET",
    path: "/network",
    summary: "List aggregated Network requests with DevTools-style search and filters.",
    query: { search: "string, optional global fuzzy search", url: "string, optional", domain: "string, optional", method: "GET|POST|..., optional", status: "number|2xx|3xx|4xx|5xx, optional", type: "Fetch|XHR|Document|Script|Stylesheet|Image|Media|Font|WebSocket|Other, optional", resourceType: "alias of type, optional", mimeType: "string, optional", failed: "boolean, optional", hasBody: "boolean, optional", requestId: "string, optional", tabId: "number, optional", limit: "number, optional default 100", offset: "number, optional", raw: "boolean, optional include raw events for returned items" }
  },
  {
    method: "GET",
    path: "/network/detail",
    summary: "Get one aggregated Network request plus its raw CDP events.",
    query: { requestId: "string", tabId: "number, optional" }
  },
  {
    method: "GET",
    path: "/network/body",
    summary: "Get a network response body by requestId.",
    query: { requestId: "string", tabId: "number, optional" }
  },
  {
    method: "POST",
    path: "/network/clear",
    summary: "Clear cached network events."
  },
  {
    method: "POST",
    path: "/console/start",
    summary: "Enable console/log events for the active or specified tab.",
    body: { tabId: "number, optional" }
  },
  {
    method: "GET",
    path: "/console",
    summary: "List cached console/log events.",
    query: { limit: "number, optional" }
  },
  {
    method: "POST",
    path: "/console/clear",
    summary: "Clear cached console/log events."
  },
  {
    method: "GET",
    path: "/downloads",
    summary: "List downloads.",
    query: { query: "Chrome downloads.search fields, optional" }
  },
  {
    method: "POST",
    path: "/download",
    summary: "Start a browser download.",
    body: { url: "string", filename: "string, optional", saveAs: "boolean, optional" }
  },
  {
    method: "GET",
    path: "/history",
    summary: "Search browser history.",
    query: { text: "string, optional", maxResults: "number, optional", startTime: "number, optional", endTime: "number, optional" }
  },
  {
    method: "GET",
    path: "/bookmarks",
    summary: "Search bookmarks or return tree.",
    query: { query: "string, optional", tree: "boolean, optional" }
  },
  {
    method: "GET",
    path: "/cookies",
    summary: "List cookies matching Chrome cookies.getAll details.",
    query: { url: "string, optional", domain: "string, optional", name: "string, optional" }
  },
  {
    method: "POST",
    path: "/cookies",
    summary: "Set a cookie.",
    body: { url: "string", name: "string", value: "string", domain: "string, optional", path: "string, optional", expirationDate: "number, optional" }
  },
  {
    method: "POST",
    path: "/cookies/remove",
    summary: "Remove a cookie.",
    body: { url: "string", name: "string" }
  },
  {
    method: "GET",
    path: "/storage",
    summary: "Read page localStorage/sessionStorage.",
    query: { area: "localStorage|sessionStorage, optional", key: "string, optional", tabId: "number, optional" }
  },
  {
    method: "POST",
    path: "/storage",
    summary: "Write page localStorage/sessionStorage.",
    body: { area: "localStorage|sessionStorage, optional", key: "string, optional", value: "string, optional", items: "object, optional", remove: "string, optional", clear: "boolean, optional", tabId: "number, optional" }
  },
  {
    method: "GET",
    path: "/chrome-storage",
    summary: "Read extension chrome.storage.",
    query: { area: "local|session, optional", keys: "string|string[], optional" }
  },
  {
    method: "POST",
    path: "/chrome-storage",
    summary: "Write extension chrome.storage.",
    body: { area: "local|session, optional", items: "object, optional", remove: "string|string[], optional", clear: "boolean, optional" }
  },
  {
    method: "POST",
    path: "/input/mouse",
    summary: "Dispatch a raw CDP mouse event.",
    body: { type: "mouseMoved|mousePressed|mouseReleased|mouseWheel", x: "number", y: "number", button: "left|middle|right|none, optional", buttons: "number, optional", deltaX: "number, optional", deltaY: "number, optional", tabId: "number, optional" }
  },
  {
    method: "POST",
    path: "/input/click",
    summary: "Click by viewport coordinates using CDP Input.dispatchMouseEvent.",
    body: { x: "number", y: "number", button: "left|middle|right, optional", double: "boolean, optional", tabId: "number, optional" }
  },
  {
    method: "POST",
    path: "/input/drag",
    summary: "Drag from one viewport coordinate to another using CDP mouse events.",
    body: { from: "{x,y}", to: "{x,y}", steps: "number, optional", button: "left|middle|right, optional", tabId: "number, optional" }
  },
  {
    method: "POST",
    path: "/input/wheel",
    summary: "Dispatch a wheel event; falls back to page-side WheelEvent and manual scroll if CDP times out.",
    body: { x: "number", y: "number", deltaX: "number, optional", deltaY: "number", cdpTimeoutMs: "number, optional default 1200", fallback: "boolean|'always', optional", manualScroll: "boolean, optional", tabId: "number, optional", returns: "cdp status, fallback target, before/after scroller state" }
  },
  {
    method: "POST",
    path: "/input/key",
    summary: "Dispatch a CDP key event or insert text.",
    body: { key: "string, optional", text: "string, optional", code: "string, optional", tabId: "number, optional" }
  },
  {
    method: "GET",
    path: "/cdp/events",
    summary: "List cached CDP events from the extension.",
    query: { limit: "number, optional" }
  },
  {
    method: "POST",
    path: "/cdp/events/clear",
    summary: "Clear cached CDP events in the extension."
  },
  {
    method: "GET",
    path: "/events",
    summary: "List native-host cached events pushed by the extension.",
    query: { channel: "all|cdp|network|console, optional", limit: "number, optional" }
  },
  {
    method: "GET",
    path: "/events/stream",
    summary: "Server-sent event stream for pushed extension events.",
    query: { channel: "all|cdp|network|console, optional" }
  },
  {
    method: "POST",
    path: "/events/clear",
    summary: "Clear native-host cached events."
  },
  {
    method: "GET",
    path: "/frames",
    summary: "List browser frames for the active or specified tab.",
    query: { tabId: "number, optional" }
  },
  {
    method: "POST",
    path: "/shadow/query",
    summary: "Query elements across open shadow roots and same-origin iframes. Runs in MAIN by default.",
    body: { selector: "string, optional", text: "string, optional", visible: "boolean, optional default true", limit: "number, optional", tabId: "number, optional", world: "MAIN|ISOLATED, optional default MAIN" }
  },
  {
    method: "POST",
    path: "/shadow/snapshot",
    summary: "List discovered open shadow roots and same-origin frame roots.",
    body: { limit: "number, optional", maxText: "number, optional", tabId: "number, optional" }
  },
  {
    method: "POST",
    path: "/element/inspect",
    summary: "Inspect element rect, attributes, computed style, and hit-test status. Coordinate mode pierces open shadow roots.",
    body: { selector: "string, optional", x: "number, optional", y: "number, optional", tabId: "number, optional", returns: "selector, root, chain, rect, style, viewport, text" }
  },
  {
    method: "POST",
    path: "/element/from-point",
    summary: "Deep hit-test viewport coordinates through open shadow roots and same-origin iframes.",
    body: { x: "number", y: "number", tabId: "number, optional", returns: "deepest element plus shadow/iframe chain" }
  },
  {
    method: "POST",
    path: "/element/highlight",
    summary: "Draw a temporary overlay around an element.",
    body: { selector: "string, optional", x: "number, optional", y: "number, optional", duration: "number, optional", color: "string, optional", tabId: "number, optional" }
  },
  {
    method: "POST",
    path: "/element/screenshot",
    summary: "Capture an element screenshot using its computed rectangle and CDP screenshot clipping.",
    body: { selector: "string, tabId: number, optional", format: "png|jpeg, optional", quality: "number, optional" }
  },
  {
    method: "POST",
    path: "/recorder/start",
    summary: "Start recording page input events, including composed shadow-DOM paths where available.",
    body: { tabId: "number, optional", clear: "boolean, optional", maxEvents: "number, optional" }
  },
  {
    method: "POST",
    path: "/recorder/stop",
    summary: "Stop recording page input events.",
    body: { tabId: "number, optional" }
  },
  {
    method: "GET",
    path: "/recorder",
    summary: "List recorded page input events.",
    query: { tabId: "number, optional", limit: "number, optional" }
  },
  {
    method: "POST",
    path: "/recorder/clear",
    summary: "Clear recorded page input events.",
    body: { tabId: "number, optional" }
  },
  {
    method: "POST",
    path: "/recorder/dispose",
    summary: "Remove recorder listeners from the page.",
    body: { tabId: "number, optional" }
  }
];

const LEGACY_API = [
  { method: "POST", path: "/open-baidu", summary: "Compatibility helper: open https://www.baidu.com/." },
  { method: "POST", path: "/tabs/open", summary: "Compatibility alias of /open." },
  { method: "POST", path: "/open-url", summary: "Compatibility alias of /open." },
  { method: "POST", path: "/tabs/:tabId/activate", summary: "Compatibility path for /activate." },
  { method: "POST", path: "/tabs/:tabId/close", summary: "Compatibility path for /close." },
  { method: "POST", path: "/tabs/:tabId/reload", summary: "Compatibility path for /reload." },
  { method: "POST", path: "/tabs/:tabId/navigate", summary: "Compatibility path for /goto." },
  { method: "POST", path: "/devtools/send", summary: "Compatibility alias of /cdp." },
  { method: "POST", path: "/devtools/evaluate", summary: "Compatibility alias for CDP Runtime.evaluate." }
];

function endpoints() {
  return API.map((item) => `${item.method.padEnd(4)} ${item.path}${item.body ? ` ${JSON.stringify(item.body)}` : ""}`);
}

function dynamicApi() {
  return API.map((item) => ({
    ...item,
    example: item.example ? item.example.replaceAll("http://127.0.0.1:17368", baseUrl()) : undefined
  }));
}

function schema() {
  return {
    name: "Port Tabs",
    version: APP_VERSION,
    baseUrl: baseUrl(),
    profile: {
      port: configuredPort,
      profileName,
      profileNote,
      displayName
    },
    model: {
      mcp: false,
      defaultTarget: "active tab when tabId is omitted",
      nativeMessagingHost: "com.port_tabs"
    },
    endpoints: dynamicApi(),
    compatibilityEndpoints: LEGACY_API
  };
}

function helpText() {
  const lines = [
    "Port Tabs",
    `Version: ${APP_VERSION}`,
    "",
    `Base URL: ${baseUrl()}`,
    `Profile: ${displayName}`,
    profileNote ? `Note: ${profileNote}` : "Note: none",
    "",
    "Model:",
    "  - No MCP.",
    "  - No caller sessions.",
    "  - If tabId is omitted, commands use the current active tab.",
    "  - If tabId is provided, commands target that tab.",
    "",
    "Discovery:",
    "  GET /help          Human-readable help.",
    "  GET /schema        Machine-readable endpoint schema.",
    "  GET /openapi.json  OpenAPI 3.0 document.",
    "",
    "Page debugging notes:",
    "  - /eval, /shadow/query, /element/* and /recorder default to the page MAIN world.",
    "  - /input/wheel first tries CDP Input.dispatchMouseEvent, then falls back to page WheelEvent plus manual scroll when CDP does not respond.",
    "  - /element/from-point and coordinate-based /element/inspect deep hit-test through open shadow roots and same-origin iframes.",
    "  - /recorder/start records pointer, mouse, wheel, scroll, key and input events. Shadow DOM events include retargetSelector when composedPath exposes a deeper target.",
    "  - /cdp/events caches debugger events and also records synthetic timeout diagnostics such as Input.dispatchMouseEvent.timeout.",
    "",
    "Network and request environment notes:",
    "  - /network returns aggregated request rows. Use search/url/domain/method/status/type/failed/hasBody/requestId filters instead of reading every raw CDP event.",
    "  - /network/detail?requestId=... returns one request plus its raw Network.* events.",
    "  - /network/body?requestId=... reads a response body for a request already made by this tab.",
    "  - /eval fetch is the same kind of fetch as F12 Console fetch. It runs inside the page and follows normal browser CORS, Origin, cookie, credentials and CSP rules.",
    "  - To fetch under another Origin, open a tab at that Origin first, then run /eval fetch in that tab.",
    "  - Terminal/native HTTP requests are a different environment. They do not follow page CORS, but they also do not automatically match browser cookies, Origin, Referer or login state.",
    "",
    "Typical page-bug workflow:",
    `  1. ${baseUrl()}/tabs`,
    "     Find the tabId of the real target page. Avoid chrome:// pages because extensions cannot inject there.",
    `  2. POST ${baseUrl()}/recorder/start {"tabId":123,"clear":true}`,
    "     Start recording user/input events on that tab.",
    `  3. POST ${baseUrl()}/element/from-point {"tabId":123,"x":500,"y":500}`,
    "     Resolve the deepest element at a coordinate, including open shadow DOM.",
    `  4. POST ${baseUrl()}/input/wheel {"tabId":123,"x":500,"y":500,"deltaY":240}`,
    "     Scroll at a coordinate. Response includes CDP status and fallback scroller before/after state.",
    `  5. ${baseUrl()}/recorder?tabId=123 and ${baseUrl()}/cdp/events`,
    "     Check whether wheel/scroll/pointer events and CDP diagnostics were captured.",
    "",
    "Endpoints:"
  ];

  for (const item of dynamicApi()) {
    lines.push(`  ${item.method.padEnd(4)} ${item.path}`);
    lines.push(`       ${item.summary}`);
    if (item.body) lines.push(`       body: ${JSON.stringify(item.body)}`);
    if (item.query) lines.push(`       query: ${JSON.stringify(item.query)}`);
    if (item.example) lines.push(`       example: ${item.example}`);
  }

  lines.push("");
  lines.push("Compatibility endpoints:");
  for (const item of LEGACY_API) {
    lines.push(`  ${item.method.padEnd(4)} ${item.path} - ${item.summary}`);
  }

  return `${lines.join("\n")}\n`;
}

function schemaToOpenApi() {
  const paths = {};
  for (const item of [...API, ...LEGACY_API]) {
    const openPath = item.path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
    const method = item.method.toLowerCase();
    paths[openPath] ||= {};
    paths[openPath][method] = {
      summary: item.summary,
      parameters: item.query
        ? Object.entries(item.query).map(([name, description]) => ({
            name,
            in: "query",
            required: false,
            schema: { type: "string" },
            description
          }))
        : [],
      requestBody: item.body
        ? {
            required: false,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  additionalProperties: true,
                  properties: Object.fromEntries(
                    Object.entries(item.body).map(([name, description]) => [
                      name,
                      { description, type: "string" }
                    ])
                  )
                }
              }
            }
          }
        : undefined,
      responses: {
        200: {
          description: "Command result",
          content: {
            "application/json": {
              schema: { type: "object", additionalProperties: true }
            }
          }
        }
      }
    };
  }

  return {
    openapi: "3.0.3",
    info: {
      title: "Port Tabs Local Browser Control API",
      version: APP_VERSION
    },
    servers: [{ url: baseUrl() }],
    paths
  };
}

const routes = [
  ["GET", /^\/tabs$/, "tabs.list"],
  ["GET", /^\/tab$/, "tabs.active"],
  ["GET", /^\/windows$/, "windows.list"],
  ["POST", /^\/open$/, "openTab"],
  ["POST", /^\/goto$/, "tabs.navigate"],
  ["POST", /^\/back$/, "tabs.back"],
  ["POST", /^\/forward$/, "tabs.forward"],
  ["POST", /^\/reload$/, "tabs.reload"],
  ["POST", /^\/close$/, "tabs.close"],
  ["POST", /^\/activate$/, "tabs.activate"],
  ["POST", /^\/click$/, "page.click"],
  ["POST", /^\/fill$/, "page.fill"],
  ["POST", /^\/key$/, "page.key"],
  ["POST", /^\/scroll$/, "page.scroll"],
  ["POST", /^\/wait$/, "page.wait"],
  ["POST", /^\/eval$/, "page.eval"],
  ["POST", /^\/content$/, "page.content"],
  ["POST", /^\/snapshot$/, "page.snapshot"],
  ["POST", /^\/interactive$/, "page.interactive"],
  ["POST", /^\/cdp$/, "cdp.send"],
  ["POST", /^\/devtools\/send$/, "cdp.send"],
  ["POST", /^\/devtools\/evaluate$/, "cdp.evaluate"],
  ["POST", /^\/network\/start$/, "network.start"],
  ["GET", /^\/network$/, "network.list"],
  ["GET", /^\/network\/detail$/, "network.detail"],
  ["GET", /^\/network\/body$/, "network.body"],
  ["POST", /^\/network\/clear$/, "network.clear"],
  ["POST", /^\/console\/start$/, "console.start"],
  ["GET", /^\/console$/, "console.list"],
  ["POST", /^\/console\/clear$/, "console.clear"],
  ["GET", /^\/downloads$/, "downloads.list"],
  ["POST", /^\/download$/, "downloads.download"],
  ["GET", /^\/history$/, "history.search"],
  ["GET", /^\/bookmarks$/, "bookmarks.search"],
  ["GET", /^\/cookies$/, "cookies.get"],
  ["POST", /^\/cookies$/, "cookies.set"],
  ["POST", /^\/cookies\/remove$/, "cookies.remove"],
  ["GET", /^\/storage$/, "page.storage.get"],
  ["POST", /^\/storage$/, "page.storage.set"],
  ["GET", /^\/chrome-storage$/, "storage.get"],
  ["POST", /^\/chrome-storage$/, "storage.set"],
  ["POST", /^\/input\/mouse$/, "input.mouse"],
  ["POST", /^\/input\/click$/, "input.click"],
  ["POST", /^\/input\/drag$/, "input.drag"],
  ["POST", /^\/input\/wheel$/, "input.wheel"],
  ["POST", /^\/input\/key$/, "input.key"],
  ["GET", /^\/cdp\/events$/, "cdp.events"],
  ["POST", /^\/cdp\/events\/clear$/, "cdp.clearEvents"],
  ["GET", /^\/frames$/, "frames.list"],
  ["POST", /^\/shadow\/query$/, "shadow.query"],
  ["POST", /^\/shadow\/snapshot$/, "shadow.snapshot"],
  ["POST", /^\/element\/inspect$/, "element.inspect"],
  ["POST", /^\/element\/from-point$/, "element.fromPoint"],
  ["POST", /^\/element\/highlight$/, "element.highlight"],
  ["POST", /^\/element\/screenshot$/, "element.screenshot"],
  ["POST", /^\/recorder\/start$/, "recorder.start"],
  ["POST", /^\/recorder\/stop$/, "recorder.stop"],
  ["GET", /^\/recorder$/, "recorder.list"],
  ["POST", /^\/recorder\/clear$/, "recorder.clear"],
  ["POST", /^\/recorder\/dispose$/, "recorder.dispose"]
];

const legacyTabAction = /^\/tabs\/(\d+)\/(activate|close|reload|navigate)$/;
const legacyTabCommand = {
  activate: "tabs.activate",
  close: "tabs.close",
  reload: "tabs.reload",
  navigate: "tabs.navigate"
};

async function handleHttpRequest(request, response) {
  try {
    const url = new URL(request.url, baseUrl());

    if (request.method === "GET" && url.pathname === "/") {
      sendText(response, 200, [
        "Port Tabs",
        `Version: ${APP_VERSION}`,
        `Profile: ${displayName}`,
        `Base URL: ${baseUrl()}`,
        "",
        "Discovery:",
        "  GET /help",
        "  GET /schema",
        "  GET /openapi.json",
        "",
        "Common endpoints:",
        ...endpoints().slice(0, 12),
        "",
        "Use /help for the full command list."
      ].join("\n") + "\n");
      return;
    }

    if (request.method === "GET" && url.pathname === "/help") {
      sendText(response, 200, helpText());
      return;
    }

    if (request.method === "GET" && url.pathname === "/schema") {
      sendJson(response, 200, schema());
      return;
    }

    if (request.method === "GET" && url.pathname === "/openapi.json") {
      sendJson(response, 200, schemaToOpenApi());
      return;
    }

    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, {
        ok: true,
        version: APP_VERSION,
        profileName,
        profileNote,
        displayName,
        extensionConnected,
        configuredPort,
        currentPort,
        listening: Boolean(server && currentPort),
        lastListenError,
        endpoints: endpoints()
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/events") {
      sendJson(response, 200, {
        ok: true,
        events: filterEvents(queryPayload(url))
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/events/stream") {
      openEventStream(request, response, queryPayload(url));
      return;
    }

    if (request.method === "POST" && url.pathname === "/events/clear") {
      eventLog.length = 0;
      sendJson(response, 200, { ok: true });
      return;
    }

    if (["GET", "POST"].includes(request.method) && (url.pathname === "/open-baidu" || url.pathname === "/tabs/open" || url.pathname === "/open-url")) {
      const payload = await payloadFromRequest(request, url);
      await commandResponse(response, "openTab", {
        ...payload,
        url: url.pathname === "/open-baidu" ? "https://www.baidu.com/" : payload.url
      });
      return;
    }

    const legacy = url.pathname.match(legacyTabAction);
    if (request.method === "POST" && legacy) {
      const payload = await payloadFromRequest(request, url);
      await commandResponse(response, legacyTabCommand[legacy[2]], {
        ...payload,
        tabId: Number(legacy[1])
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/screenshot") {
      const payload = await payloadFromRequest(request, url);
      await commandResponse(response, "cdp.screenshot", payload, {
        after: async (result, requestPayload) => {
          const data = result.ok ? screenshotData(result) : null;
          if (data && requestPayload.path) {
            result.savedPath = saveBase64(requestPayload.path, data);
            if (requestPayload.omitData !== false) {
              result.result.data = undefined;
            }
          }
        }
      });
      return;
    }

    for (const [method, pattern, command] of routes) {
      if (request.method === method && pattern.test(url.pathname)) {
        const payload = await payloadFromRequest(request, url);
        await commandResponse(response, command, payload);
        return;
      }
    }

    sendJson(response, 404, {
      ok: false,
      error: "Not found.",
      endpoints: endpoints()
    });
  } catch (error) {
    sendJson(response, 500, {
      ok: false,
      error: error && error.message ? error.message : String(error),
      stack: error && error.stack
    });
  }
}

process.stdin.on("data", readNativeMessages);
process.stdin.on("end", () => process.exit(0));
process.stdin.resume();

log(`native host started, waiting for extension port configuration; default=${DEFAULT_PORT}`);


