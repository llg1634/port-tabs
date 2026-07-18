const NATIVE_HOST = "com.port_tabs";
const DEFAULT_CONTROL_PORT = 17368;
const PORT_STORAGE_KEY = "controlPort";
const PROFILE_NAME_STORAGE_KEY = "profileName";
const PROFILE_NOTE_STORAGE_KEY = "profileNote";
const MAX_EVENTS = 1000;

let nativePort = null;
let reconnectTimer = null;
let nextEventId = 1;

const attachedDebugTargets = new Set();
const networkEvents = [];
const consoleEvents = [];
const devtoolsEvents = [];
const requestToTab = new Map();

function normalizePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return port;
}

async function getConfiguredPort() {
  const result = await chrome.storage.local.get({ [PORT_STORAGE_KEY]: DEFAULT_CONTROL_PORT });
  return normalizePort(result[PORT_STORAGE_KEY]);
}

async function getProfileConfig() {
  const result = await chrome.storage.local.get({
    [PORT_STORAGE_KEY]: DEFAULT_CONTROL_PORT,
    [PROFILE_NAME_STORAGE_KEY]: "",
    [PROFILE_NOTE_STORAGE_KEY]: ""
  });
  const port = normalizePort(result[PORT_STORAGE_KEY]);
  const profileName = String(result[PROFILE_NAME_STORAGE_KEY] || "").trim();
  const profileNote = String(result[PROFILE_NOTE_STORAGE_KEY] || "").trim();
  return {
    port,
    profileName,
    profileNote,
    displayName: profileName || `Browser on ${port}`
  };
}

function sendProfileConfigure(config) {
  sendToNative({
    type: "configure",
    source: "port-tabs-extension",
    port: config.port,
    profileName: config.profileName,
    profileNote: config.profileNote,
    displayName: config.displayName,
    time: Date.now()
  });
}

async function setConfiguredPort(port) {
  const normalized = normalizePort(port);
  await chrome.storage.local.set({ [PORT_STORAGE_KEY]: normalized });
  sendProfileConfigure(await getProfileConfig());
  return normalized;
}

async function setProfileConfig(updates = {}) {
  const items = {};
  if (updates.port !== undefined) items[PORT_STORAGE_KEY] = normalizePort(updates.port);
  if (updates.profileName !== undefined) items[PROFILE_NAME_STORAGE_KEY] = String(updates.profileName || "").trim();
  if (updates.profileNote !== undefined) items[PROFILE_NOTE_STORAGE_KEY] = String(updates.profileNote || "").trim();
  await chrome.storage.local.set(items);
  const config = await getProfileConfig();
  sendProfileConfigure(config);
  return config;
}

function pushLimited(list, event) {
  list.push({
    eventId: nextEventId++,
    time: Date.now(),
    ...event
  });
  if (list.length > MAX_EVENTS) {
    list.splice(0, list.length - MAX_EVENTS);
  }
}

function normalizeHttpUrl(rawUrl) {
  const value = String(rawUrl || "about:blank").trim();
  if (value === "about:blank") {
    return value;
  }

  const url = /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(value)
    ? new URL(value)
    : new URL(`https://${value}`);

  if (!["http:", "https:", "file:"].includes(url.protocol)) {
    throw new Error(`Only http/https/file URLs are allowed: ${url.protocol}`);
  }

  return url.href;
}

function callChrome(invoker) {
  return new Promise((resolve, reject) => {
    try {
      invoker((result) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          reject(new Error(lastError.message));
          return;
        }

        resolve(result);
      });
    } catch (error) {
      reject(error);
    }
  });
}

function withTimeout(promise, timeoutMs, message) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function tabTarget(tabId) {
  const numericTabId = Number(tabId);
  if (!Number.isInteger(numericTabId)) {
    throw new Error(`Invalid tabId: ${tabId}`);
  }
  return { tabId: numericTabId };
}

async function getActiveTab() {
  let tabs = await callChrome((done) => {
    chrome.tabs.query({ active: true, currentWindow: true }, done);
  });

  if (!tabs.length) {
    tabs = await callChrome((done) => {
      chrome.tabs.query({ active: true }, done);
    });
  }

  if (!tabs.length) {
    throw new Error("No active tab found.");
  }

  return tabs[0];
}

async function getTargetTabId(payload = {}) {
  if (payload.tabId !== undefined && payload.tabId !== null) {
    return tabTarget(payload.tabId).tabId;
  }

  const tab = await getActiveTab();
  return tab.id;
}

function sendToNative(message) {
  if (!nativePort) {
    console.warn("Native host is not connected.");
    return;
  }

  nativePort.postMessage(message);
}

function emitNativeEvent(channel, event) {
  sendToNative({
    type: "event",
    channel,
    event: {
      time: Date.now(),
      ...event
    }
  });
}

function sendResult(id, data) {
  sendToNative({
    type: "result",
    id,
    ok: true,
    ...data
  });
}

function sendError(id, error) {
  sendToNative({
    type: "result",
    id,
    ok: false,
    error: error && error.message ? error.message : String(error),
    stack: error && error.stack
  });
}

function scheduleReconnect() {
  if (reconnectTimer) {
    return;
  }

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectNativeHost();
  }, 2000);
}

async function ensureDebuggerAttached(tabId, protocolVersion = "1.3") {
  const target = tabTarget(tabId);
  if (attachedDebugTargets.has(target.tabId)) {
    return target;
  }

  try {
    await callChrome((done) => {
      chrome.debugger.attach(target, protocolVersion, done);
    });
  } catch (error) {
    if (!/already attached/i.test(error.message)) {
      throw error;
    }
  }

  attachedDebugTargets.add(target.tabId);
  return target;
}

async function sendDevToolsCommand(payload = {}) {
  if (!payload.method) {
    throw new Error("Missing DevTools Protocol method.");
  }

  const tabId = await getTargetTabId(payload);
  const target = await ensureDebuggerAttached(tabId, payload.protocolVersion);
  const result = await callChrome((done) => {
    chrome.debugger.sendCommand(target, payload.method, payload.params || {}, done);
  });

  return {
    tabId,
    method: payload.method,
    result
  };
}

async function sendDevToolsCommandWithTimeout(payload = {}, timeoutMs = 1500) {
  return await withTimeout(
    sendDevToolsCommand(payload),
    timeoutMs,
    `Timed out after ${timeoutMs}ms waiting for ${payload.method}.`
  );
}

async function runInPage(payload, func, args = []) {
  const tabId = await getTargetTabId(payload);
  const results = await callChrome((done) => {
    chrome.scripting.executeScript(
      {
        target: {
          tabId,
          allFrames: Boolean(payload.allFrames)
        },
        world: payload.world === "ISOLATED" ? "ISOLATED" : "MAIN",
        func,
        args
      },
      done
    );
  });

  return { tabId, results };
}

async function evaluateWithScripting(payload = {}) {
  const code = payload.code || payload.expression;
  if (!code) {
    throw new Error("Missing code or expression.");
  }

  return await runInPage(
    payload,
    async (source) => {
      try {
        const value = await (0, eval)(source);
        return { ok: true, value };
      } catch (error) {
        return {
          ok: false,
          error: error && error.message ? error.message : String(error),
          stack: error && error.stack
        };
      }
    },
    [String(code)]
  );
}

async function pageClick(payload = {}) {
  return await runInPage(
    payload,
    async (options) => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const find = () => {
        if (options.selector) return document.querySelector(options.selector);
        if (options.x !== undefined && options.y !== undefined) return document.elementFromPoint(options.x, options.y);
        throw new Error("Missing selector or coordinates.");
      };
      const element = find();
      if (!element) throw new Error(`Element not found: ${options.selector || `${options.x},${options.y}`}`);
      element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      await sleep(50);
      const rect = element.getBoundingClientRect();
      const x = options.x ?? rect.left + rect.width / 2;
      const y = options.y ?? rect.top + rect.height / 2;
      const buttonName = options.button || "left";
      const button = buttonName === "middle" ? 1 : buttonName === "right" ? 2 : 0;
      const base = { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, button };
      element.dispatchEvent(new MouseEvent("mouseover", base));
      element.dispatchEvent(new MouseEvent("mousemove", base));
      element.dispatchEvent(new MouseEvent("mousedown", base));
      element.dispatchEvent(new MouseEvent("mouseup", base));
      element.dispatchEvent(new MouseEvent("click", base));
      if (options.double || options.dblClick) {
        element.dispatchEvent(new MouseEvent("mousedown", base));
        element.dispatchEvent(new MouseEvent("mouseup", base));
        element.dispatchEvent(new MouseEvent("click", base));
        element.dispatchEvent(new MouseEvent("dblclick", base));
      }
      return {
        ok: true,
        selector: options.selector || null,
        x,
        y,
        tagName: element.tagName,
        text: (element.innerText || element.value || "").slice(0, 300)
      };
    },
    [payload]
  );
}

async function pageFill(payload = {}) {
  return await runInPage(
    payload,
    async (options) => {
      const element = document.querySelector(options.selector);
      if (!element) throw new Error(`Element not found: ${options.selector}`);
      const value = options.value ?? "";
      element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      element.focus();

      if (element.matches("input[type=checkbox], input[type=radio]")) {
        element.checked = Boolean(value);
      } else if (element.tagName === "SELECT") {
        element.value = String(value);
      } else if (element.isContentEditable) {
        element.textContent = String(value);
      } else {
        element.value = String(value);
      }

      element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: String(value) }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true, selector: options.selector, value };
    },
    [payload]
  );
}

async function pageKey(payload = {}) {
  return await runInPage(
    payload,
    async (options) => {
      const target = options.selector ? document.querySelector(options.selector) : document.activeElement || document.body;
      if (!target) throw new Error(`Element not found: ${options.selector}`);
      target.focus?.();
      const text = options.text;
      const keys = options.keys || options.key;
      if (text !== undefined) {
        if ("value" in target) {
          target.value = `${target.value || ""}${text}`;
          target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: String(text) }));
          target.dispatchEvent(new Event("change", { bubbles: true }));
        } else {
          target.textContent = `${target.textContent || ""}${text}`;
        }
      }
      if (keys) {
        for (const key of String(keys).split("+").filter(Boolean)) {
          target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
          target.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true }));
        }
      }
      return { ok: true, selector: options.selector || null, text, keys };
    },
    [payload]
  );
}

async function pageScroll(payload = {}) {
  return await runInPage(
    payload,
    (options) => {
      if (options.selector) {
        const element = document.querySelector(options.selector);
        if (!element) throw new Error(`Element not found: ${options.selector}`);
        if (options.intoView !== false) {
          element.scrollIntoView({ block: options.block || "center", inline: options.inline || "center", behavior: options.behavior || "instant" });
        } else {
          element.scrollBy(options.x || 0, options.y || options.deltaY || 0);
        }
      } else if (options.to) {
        window.scrollTo(options.to.x || 0, options.to.y || 0);
      } else {
        window.scrollBy(options.x || 0, options.y || options.deltaY || 0);
      }
      return {
        ok: true,
        scrollX,
        scrollY,
        width: document.documentElement.scrollWidth,
        height: document.documentElement.scrollHeight
      };
    },
    [payload]
  );
}

async function pageWait(payload = {}) {
  return await runInPage(
    payload,
    async (options) => {
      const timeout = Number(options.timeout || 5000);
      const started = Date.now();
      const visible = (el) => {
        if (!el) return false;
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
      };
      while (Date.now() - started < timeout) {
        let matched = false;
        if (options.selector) {
          const el = document.querySelector(options.selector);
          matched = options.visible === false ? Boolean(el) : visible(el);
        }
        if (options.text) {
          matched = document.body.innerText.includes(options.text);
        }
        if (options.gone) {
          matched = !document.body.innerText.includes(options.gone) && (!options.selector || !document.querySelector(options.selector));
        }
        if (matched) return { ok: true, elapsedMs: Date.now() - started };
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return { ok: false, error: "Timed out", elapsedMs: Date.now() - started };
    },
    [payload]
  );
}

async function pageContent(payload = {}) {
  return await runInPage(
    payload,
    (options) => {
      const maxText = Number(options.maxText || 200000);
      const links = Array.from(document.links).slice(0, options.maxLinks || 500).map((a) => ({
        text: (a.innerText || a.textContent || "").trim(),
        href: a.href
      }));
      const images = Array.from(document.images).slice(0, options.maxImages || 300).map((img) => ({
        alt: img.alt || "",
        src: img.currentSrc || img.src,
        width: img.naturalWidth,
        height: img.naturalHeight
      }));
      const forms = Array.from(document.forms).slice(0, 100).map((form) => ({
        action: form.action,
        method: form.method,
        fields: Array.from(form.elements).map((el) => ({
          tag: el.tagName,
          type: el.type || "",
          name: el.name || "",
          id: el.id || "",
          placeholder: el.placeholder || "",
          value: options.includeValues ? el.value : undefined
        }))
      }));
      const meta = Array.from(document.querySelectorAll("meta")).map((m) => ({
        name: m.getAttribute("name") || m.getAttribute("property") || "",
        content: m.getAttribute("content") || ""
      }));
      return {
        title: document.title,
        url: location.href,
        text: document.body ? document.body.innerText.slice(0, maxText) : "",
        html: options.html ? document.documentElement.outerHTML.slice(0, Number(options.maxHtml || 500000)) : undefined,
        links,
        images,
        forms,
        meta
      };
    },
    [payload]
  );
}

async function pageInteractive(payload = {}) {
  return await runInPage(
    payload,
    (options) => {
      const selector = [
        "a[href]",
        "button",
        "input",
        "textarea",
        "select",
        "[role=button]",
        "[role=link]",
        "[role=menuitem]",
        "[role=option]",
        "[role=switch]",
        "[tabindex]:not([tabindex='-1'])",
        "[onclick]",
        "[contenteditable=true]"
      ].join(",");
      const visible = (el) => {
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
      };
      const cssPath = (el) => {
        if (el.id) return `#${CSS.escape(el.id)}`;
        const parts = [];
        while (el && el.nodeType === Node.ELEMENT_NODE && parts.length < 5) {
          let part = el.tagName.toLowerCase();
          if (el.classList.length) part += `.${Array.from(el.classList).slice(0, 2).map((c) => CSS.escape(c)).join(".")}`;
          const parent = el.parentElement;
          if (parent) {
            const same = Array.from(parent.children).filter((child) => child.tagName === el.tagName);
            if (same.length > 1) part += `:nth-of-type(${same.indexOf(el) + 1})`;
          }
          parts.unshift(part);
          el = parent;
        }
        return parts.join(" > ");
      };
      return Array.from(document.querySelectorAll(selector))
        .filter(visible)
        .slice(0, options.limit || 200)
        .map((el) => {
          const rect = el.getBoundingClientRect();
          return {
            selector: cssPath(el),
            tag: el.tagName,
            type: el.type || "",
            role: el.getAttribute("role") || "",
            text: (el.innerText || el.value || el.getAttribute("aria-label") || "").trim().slice(0, 200),
            href: el.href || "",
            x: Math.round(rect.left),
            y: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
          };
        });
    },
    [payload]
  );
}

async function pageSnapshot(payload = {}) {
  return await runInPage(
    payload,
    (options) => {
      const maxNodes = Number(options.maxNodes || 300);
      const lines = [];
      const visible = (el) => {
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
      };
      const walk = (el, depth) => {
        if (!el || lines.length >= maxNodes || depth > (options.maxDepth || 8)) return;
        if (!visible(el)) return;
        const role = el.getAttribute("role") || "";
        const name = (el.getAttribute("aria-label") || el.innerText || el.value || "").trim().replace(/\s+/g, " ").slice(0, 120);
        const id = el.id ? `#${el.id}` : "";
        const cls = el.className && typeof el.className === "string" ? `.${el.className.trim().split(/\s+/).slice(0, 2).join(".")}` : "";
        lines.push(`${"  ".repeat(depth)}${el.tagName.toLowerCase()}${id}${cls}${role ? ` role=${role}` : ""}${name ? ` "${name}"` : ""}`);
        for (const child of el.children) walk(child, depth + 1);
      };
      walk(document.body, 0);
      return {
        title: document.title,
        url: location.href,
        lines
      };
    },
    [payload]
  );
}

async function pageStorageGet(payload = {}) {
  return await runInPage(
    payload,
    (options) => {
      const area = options.area === "sessionStorage" ? sessionStorage : localStorage;
      if (options.key) return { [options.key]: area.getItem(options.key) };
      return Object.fromEntries(Array.from({ length: area.length }, (_, i) => {
        const key = area.key(i);
        return [key, area.getItem(key)];
      }));
    },
    [payload]
  );
}

async function pageStorageSet(payload = {}) {
  return await runInPage(
    payload,
    (options) => {
      const area = options.area === "sessionStorage" ? sessionStorage : localStorage;
      if (options.clear) area.clear();
      if (options.remove) area.removeItem(options.remove);
      if (options.key !== undefined) area.setItem(options.key, String(options.value ?? ""));
      if (options.items) {
        for (const [key, value] of Object.entries(options.items)) {
          area.setItem(key, String(value));
        }
      }
      return { ok: true };
    },
    [payload]
  );
}

async function listWindows(payload = {}) {
  const windows = await callChrome((done) => {
    chrome.windows.getAll({ populate: Boolean(payload.populate) }, done);
  });
  return { windows };
}

async function chromeStorageGet(payload = {}) {
  const area = payload.area === "session" ? chrome.storage.session : chrome.storage.local;
  const value = await area.get(payload.keys || null);
  return { area: payload.area || "local", value };
}

async function chromeStorageSet(payload = {}) {
  const area = payload.area === "session" ? chrome.storage.session : chrome.storage.local;
  if (payload.clear) await area.clear();
  if (payload.remove) await area.remove(payload.remove);
  if (payload.items) await area.set(payload.items);
  return { ok: true, area: payload.area || "local" };
}

async function cdpInputMouse(payload = {}) {
  const tabId = await getTargetTabId(payload);
  const params = {
    type: payload.type || "mouseMoved",
    x: Number(payload.x || 0),
    y: Number(payload.y || 0),
    button: payload.button || "none",
    buttons: payload.buttons,
    clickCount: payload.clickCount,
    deltaX: payload.deltaX,
    deltaY: payload.deltaY,
    modifiers: payload.modifiers
  };
  Object.keys(params).forEach((key) => params[key] === undefined && delete params[key]);
  const result = await sendDevToolsCommand({ tabId, method: "Input.dispatchMouseEvent", params });
  return { tabId, dispatched: params, result };
}

async function cdpInputClick(payload = {}) {
  const tabId = await getTargetTabId(payload);
  const x = Number(payload.x || 0);
  const y = Number(payload.y || 0);
  const button = payload.button || "left";
  const clickCount = Number(payload.clickCount || (payload.double ? 2 : 1));
  const events = [
    { type: "mouseMoved", x, y, button: "none" },
    { type: "mousePressed", x, y, button, buttons: button === "left" ? 1 : button === "right" ? 2 : 4, clickCount },
    { type: "mouseReleased", x, y, button, buttons: 0, clickCount }
  ];
  for (const params of events) {
    await sendDevToolsCommand({ tabId, method: "Input.dispatchMouseEvent", params });
  }
  return { tabId, events };
}

async function pageWheelFallback(payload = {}, cdp = null) {
  return await runInPage(
    payload,
    (options, helpersSource, cdpState) => {
      const { queryDeep, deepElementFromPoint, elementInfo, cssPath } = eval(`(${helpersSource})`)();
      const toNumber = (value, fallback) => {
        const number = Number(value);
        return Number.isFinite(number) ? number : fallback;
      };
      const x = toNumber(options.x, window.innerWidth / 2);
      const y = toNumber(options.y, window.innerHeight / 2);
      const deltaX = toNumber(options.deltaX, 0);
      const deltaY = toNumber(options.deltaY !== undefined ? options.deltaY : options.yDelta, 0);
      const hit = options.selector
        ? { el: queryDeep(options.selector), rootLabel: "selector", chain: [] }
        : deepElementFromPoint(x, y);
      const target = hit.el || document.elementFromPoint(x, y) || document.documentElement;
      if (!target || target.nodeType !== Node.ELEMENT_NODE) {
        throw new Error(`Element not found at ${x},${y}.`);
      }

      const nearestScrollable = (start) => {
        const doc = start.ownerDocument || document;
        let current = start.nodeType === Node.ELEMENT_NODE ? start : start.parentElement;
        const seen = new Set();
        while (current && !seen.has(current)) {
          seen.add(current);
          const style = current.ownerDocument.defaultView.getComputedStyle(current);
          const canScrollY = Math.abs(deltaY) > 0
            && /(auto|scroll|overlay)/.test(style.overflowY)
            && current.scrollHeight > current.clientHeight;
          const canScrollX = Math.abs(deltaX) > 0
            && /(auto|scroll|overlay)/.test(style.overflowX)
            && current.scrollWidth > current.clientWidth;
          if (canScrollY || canScrollX) return current;

          const root = current.getRootNode ? current.getRootNode() : null;
          current = current.assignedSlot || current.parentElement || (root && root.host) || null;
        }
        return doc.scrollingElement || doc.documentElement || document.scrollingElement || document.documentElement;
      };

      const describeScroll = (el) => {
        if (!el) return null;
        return {
          selector: cssPath(el),
          tag: el.tagName,
          scrollTop: el.scrollTop,
          scrollLeft: el.scrollLeft,
          scrollHeight: el.scrollHeight,
          scrollWidth: el.scrollWidth,
          clientHeight: el.clientHeight,
          clientWidth: el.clientWidth
        };
      };

      const scroller = nearestScrollable(target);
      const before = describeScroll(scroller);
      const ownerWindow = target.ownerDocument.defaultView || window;
      const event = new ownerWindow.WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX: x,
        clientY: y,
        deltaX,
        deltaY,
        deltaMode: Number(options.deltaMode || 0),
        ctrlKey: Boolean(options.ctrlKey),
        shiftKey: Boolean(options.shiftKey),
        altKey: Boolean(options.altKey),
        metaKey: Boolean(options.metaKey)
      });
      const notCancelled = target.dispatchEvent(event);

      let manualScroll = false;
      if (options.manualScroll !== false && notCancelled && scroller) {
        const oldTop = scroller.scrollTop;
        const oldLeft = scroller.scrollLeft;
        scroller.scrollTop += deltaY;
        scroller.scrollLeft += deltaX;
        manualScroll = scroller.scrollTop !== oldTop || scroller.scrollLeft !== oldLeft;
        if (manualScroll) {
          scroller.dispatchEvent(new ownerWindow.Event("scroll", { bubbles: false, cancelable: false, composed: true }));
        }
      }

      const after = describeScroll(scroller);
      return {
        ok: true,
        cdp: cdpState,
        dispatched: {
          type: "wheel",
          x,
          y,
          deltaX,
          deltaY,
          deltaMode: Number(options.deltaMode || 0)
        },
        eventCancelled: !notCancelled,
        manualScroll,
        target: elementInfo(target, { rootLabel: hit.rootLabel || "document", chain: hit.chain || [] }),
        scroller: {
          before,
          after
        }
      };
    },
    [payload, pageDebugHelpers.toString(), cdp]
  );
}

async function cdpInputWheel(payload = {}) {
  const tabId = await getTargetTabId(payload);
  const params = {
    type: "mouseWheel",
    x: Number(payload.x || 0),
    y: Number(payload.y || 0),
    deltaX: Number(payload.deltaX || 0),
    deltaY: Number(payload.deltaY || payload.yDelta || 0),
    modifiers: payload.modifiers
  };
  Object.keys(params).forEach((key) => params[key] === undefined && delete params[key]);
  let cdp = { ok: false, skipped: payload.cdp === false };
  if (payload.cdp !== false) {
    try {
      const timeoutMs = Math.max(100, Number(payload.cdpTimeoutMs || payload.inputTimeoutMs || 1200));
      const result = await sendDevToolsCommandWithTimeout(
        { tabId, method: "Input.dispatchMouseEvent", params },
        timeoutMs
      );
      cdp = { ok: true, timeoutMs, result };
      if (payload.fallback !== "always" && payload.alwaysFallback !== true) {
        return { tabId, dispatched: params, cdp };
      }
    } catch (error) {
      cdp = {
        ok: false,
        timeout: /Timed out/i.test(error.message),
        error: error && error.message ? error.message : String(error)
      };
      const event = {
        tabId,
        method: "Input.dispatchMouseEvent.timeout",
        params,
        error: cdp.error,
        source: "input.wheel"
      };
      pushLimited(devtoolsEvents, event);
      emitNativeEvent("cdp", event);
      if (payload.fallback === false) {
        throw error;
      }
    }
  }
  const fallback = await pageWheelFallback({ ...payload, tabId }, cdp);
  const result = fallback.results && fallback.results[0] ? fallback.results[0].result : null;
  return { tabId, dispatched: params, cdp, fallback: result };
}

async function cdpInputDrag(payload = {}) {
  const tabId = await getTargetTabId(payload);
  const from = payload.from || { x: payload.fromX, y: payload.fromY };
  const to = payload.to || { x: payload.toX, y: payload.toY };
  const steps = Math.max(1, Number(payload.steps || 12));
  const button = payload.button || "left";
  const buttons = button === "left" ? 1 : button === "right" ? 2 : 4;
  const events = [];
  const push = async (params) => {
    events.push(params);
    await sendDevToolsCommand({ tabId, method: "Input.dispatchMouseEvent", params });
  };
  await push({ type: "mouseMoved", x: Number(from.x), y: Number(from.y), button: "none" });
  await push({ type: "mousePressed", x: Number(from.x), y: Number(from.y), button, buttons, clickCount: 1 });
  for (let i = 1; i <= steps; i++) {
    const ratio = i / steps;
    await push({
      type: "mouseMoved",
      x: Number(from.x) + (Number(to.x) - Number(from.x)) * ratio,
      y: Number(from.y) + (Number(to.y) - Number(from.y)) * ratio,
      button,
      buttons
    });
  }
  await push({ type: "mouseReleased", x: Number(to.x), y: Number(to.y), button, buttons: 0, clickCount: 1 });
  return { tabId, events };
}

async function cdpInputKey(payload = {}) {
  const tabId = await getTargetTabId(payload);
  if (payload.text !== undefined) {
    const result = await sendDevToolsCommand({
      tabId,
      method: "Input.insertText",
      params: { text: String(payload.text) }
    });
    return { tabId, insertedText: String(payload.text), result };
  }
  const key = payload.key || payload.code;
  if (!key) throw new Error("Missing key or text.");
  const down = {
    type: "keyDown",
    key,
    code: payload.code || key,
    windowsVirtualKeyCode: payload.windowsVirtualKeyCode,
    nativeVirtualKeyCode: payload.nativeVirtualKeyCode,
    modifiers: payload.modifiers
  };
  const up = { ...down, type: "keyUp" };
  Object.keys(down).forEach((name) => down[name] === undefined && delete down[name]);
  Object.keys(up).forEach((name) => up[name] === undefined && delete up[name]);
  await sendDevToolsCommand({ tabId, method: "Input.dispatchKeyEvent", params: down });
  await sendDevToolsCommand({ tabId, method: "Input.dispatchKeyEvent", params: up });
  return { tabId, events: [down, up] };
}

async function framesList(payload = {}) {
  const tabId = await getTargetTabId(payload);
  const frames = await callChrome((done) => chrome.webNavigation.getAllFrames({ tabId }, done));
  return { tabId, frames };
}

function networkHeadersObject(headers) {
  if (!headers) return {};
  if (Array.isArray(headers)) {
    return headers.reduce((acc, item) => {
      if (item && item.name) acc[item.name] = item.value;
      return acc;
    }, {});
  }
  return headers;
}

function networkHeaderText(headers) {
  return Object.entries(networkHeadersObject(headers))
    .map(([name, value]) => `${name}: ${value}`)
    .join("\n");
}

function networkStatusMatches(status, expected) {
  if (expected === undefined || expected === null || expected === "") return true;
  if (status === undefined || status === null) return false;
  const value = String(expected).toLowerCase();
  if (/^[1-5]xx$/.test(value)) {
    return Math.floor(Number(status) / 100) === Number(value[0]);
  }
  if (value.includes(",")) {
    return value.split(",").map((item) => item.trim()).some((item) => networkStatusMatches(status, item));
  }
  return Number(status) === Number(value);
}

function networkTextMatches(value, expected) {
  if (expected === undefined || expected === null || expected === "") return true;
  return String(value || "").toLowerCase().includes(String(expected).toLowerCase());
}

function networkTypeMatches(item, expected) {
  if (!expected) return true;
  const values = String(expected).toLowerCase().split(",").map((part) => part.trim()).filter(Boolean);
  const resourceType = String(item.resourceType || item.type || "").toLowerCase();
  return values.some((value) => {
    if (value === "xhr") return resourceType === "xhr";
    if (value === "fetch") return resourceType === "fetch";
    if (value === "js") return resourceType === "script";
    if (value === "css") return resourceType === "stylesheet";
    if (value === "img") return resourceType === "image";
    return resourceType === value;
  });
}

function networkItemSearchBlob(item) {
  return [
    item.requestId,
    item.url,
    item.documentURL,
    item.method,
    item.status,
    item.statusText,
    item.resourceType,
    item.mimeType,
    item.protocol,
    item.initiatorType,
    item.errorText,
    item.blockedReason,
    item.postDataPreview,
    networkHeaderText(item.requestHeaders),
    networkHeaderText(item.responseHeaders)
  ].filter((value) => value !== undefined && value !== null).join("\n").toLowerCase();
}

function buildNetworkItems(events = []) {
  const byId = new Map();
  const ensure = (requestId, event) => {
    const existing = byId.get(requestId);
    if (existing) return existing;
    const item = {
      requestId,
      tabId: event.tabId,
      events: [],
      rawEventIds: [],
      failed: false,
      hasResponseBody: false
    };
    byId.set(requestId, item);
    return item;
  };

  for (const event of events) {
    const params = event.params || {};
    const requestId = params.requestId;
    if (!requestId) continue;
    const item = ensure(requestId, event);
    item.events.push(event);
    item.rawEventIds.push(event.eventId);
    item.tabId = item.tabId === undefined ? event.tabId : item.tabId;
    item.lastEventTime = event.time;

    if (event.method === "Network.requestWillBeSent") {
      const request = params.request || {};
      item.url = request.url || item.url;
      item.documentURL = params.documentURL || item.documentURL;
      item.method = request.method || item.method;
      item.requestHeaders = networkHeadersObject(request.headers || item.requestHeaders);
      item.postDataPreview = request.postData ? String(request.postData).slice(0, 1000) : item.postDataPreview;
      item.hasPostData = Boolean(request.postData || item.hasPostData);
      item.resourceType = params.type || item.resourceType;
      item.type = item.resourceType;
      item.initiatorType = params.initiator && params.initiator.type;
      item.frameId = params.frameId || item.frameId;
      item.loaderId = params.loaderId || item.loaderId;
      item.timestamp = params.timestamp || item.timestamp;
      item.wallTime = params.wallTime || item.wallTime;
      item.startTime = item.startTime || event.time;
    } else if (event.method === "Network.requestWillBeSentExtraInfo") {
      item.associatedCookies = params.associatedCookies || item.associatedCookies;
      item.requestHeaders = networkHeadersObject(params.headers || item.requestHeaders);
    } else if (event.method === "Network.responseReceived") {
      const response = params.response || {};
      item.url = response.url || item.url;
      item.status = response.status;
      item.statusText = response.statusText;
      item.responseHeaders = networkHeadersObject(response.headers || item.responseHeaders);
      item.mimeType = response.mimeType || item.mimeType;
      item.protocol = response.protocol || item.protocol;
      item.remoteIPAddress = response.remoteIPAddress || item.remoteIPAddress;
      item.remotePort = response.remotePort || item.remotePort;
      item.fromDiskCache = Boolean(response.fromDiskCache);
      item.fromServiceWorker = Boolean(response.fromServiceWorker);
      item.encodedDataLength = response.encodedDataLength;
      item.resourceType = params.type || item.resourceType;
      item.type = item.resourceType;
      item.hasResponseBody = true;
    } else if (event.method === "Network.responseReceivedExtraInfo") {
      item.responseHeaders = networkHeadersObject(params.headers || item.responseHeaders);
      if (params.statusCode !== undefined) item.status = params.statusCode;
      item.cookiePartitionKey = params.cookiePartitionKey || item.cookiePartitionKey;
    } else if (event.method === "Network.dataReceived") {
      item.dataLength = (item.dataLength || 0) + Number(params.dataLength || 0);
      item.encodedDataLength = (item.encodedDataLength || 0) + Number(params.encodedDataLength || 0);
    } else if (event.method === "Network.loadingFinished") {
      item.finished = true;
      item.endTime = event.time;
      if (params.encodedDataLength !== undefined) item.encodedDataLength = params.encodedDataLength;
    } else if (event.method === "Network.loadingFailed") {
      item.failed = true;
      item.canceled = Boolean(params.canceled);
      item.errorText = params.errorText;
      item.blockedReason = params.blockedReason;
      item.endTime = event.time;
      item.hasResponseBody = false;
    }
  }

  return Array.from(byId.values()).map((item) => {
    const endTime = item.endTime || item.lastEventTime || item.startTime;
    const startTime = item.startTime || item.lastEventTime || item.endTime;
    const url = item.url || "";
    let domain = "";
    try {
      domain = new URL(url).hostname;
    } catch (_) {
      domain = "";
    }
    return {
      ...item,
      domain,
      startTime,
      endTime,
      durationMs: startTime && endTime ? Math.max(0, endTime - startTime) : undefined,
      bodyHint: item.hasResponseBody ? `/network/body?requestId=${encodeURIComponent(item.requestId)}` : undefined
    };
  }).sort((a, b) => (a.startTime || 0) - (b.startTime || 0));
}

function networkItemMatches(item, payload = {}) {
  if (payload.tabId !== undefined && Number(item.tabId) !== Number(payload.tabId)) return false;
  if (!networkTextMatches(item.requestId, payload.requestId)) return false;
  if (!networkTextMatches(item.url, payload.url)) return false;
  if (!networkTextMatches(item.domain, payload.domain)) return false;
  if (payload.method && String(item.method || "").toUpperCase() !== String(payload.method).toUpperCase()) return false;
  if (!networkStatusMatches(item.status, payload.status)) return false;
  if (!networkTypeMatches(item, payload.type || payload.resourceType)) return false;
  if (payload.mimeType && !networkTextMatches(item.mimeType, payload.mimeType)) return false;
  if (payload.initiatorType && !networkTextMatches(item.initiatorType, payload.initiatorType)) return false;
  if (payload.failed === true && !(item.failed || Number(item.status) >= 400)) return false;
  if (payload.failed === false && (item.failed || Number(item.status) >= 400)) return false;
  if (payload.hasBody === true && !item.hasResponseBody) return false;
  if (payload.hasBody === false && item.hasResponseBody) return false;
  if (payload.search && !networkItemSearchBlob(item).includes(String(payload.search).toLowerCase())) return false;
  return true;
}

function compactNetworkItem(item) {
  const {
    events,
    requestHeaders,
    responseHeaders,
    associatedCookies,
    ...summary
  } = item;
  return {
    ...summary,
    requestHeaders,
    responseHeaders,
    associatedCookies
  };
}

function listNetworkRequests(payload = {}) {
  const allItems = buildNetworkItems(networkEvents);
  const matchedItems = allItems.filter((item) => networkItemMatches(item, payload));
  const offset = Math.max(0, Number(payload.offset || 0));
  const limit = Math.max(1, Math.min(MAX_EVENTS, Number(payload.limit || 100)));
  const page = matchedItems.slice(offset, offset + limit).map(compactNetworkItem);
  const response = {
    total: allItems.length,
    matched: matchedItems.length,
    returned: page.length,
    offset,
    limit,
    filters: {
      search: payload.search,
      url: payload.url,
      domain: payload.domain,
      method: payload.method,
      status: payload.status,
      type: payload.type || payload.resourceType,
      mimeType: payload.mimeType,
      failed: payload.failed,
      hasBody: payload.hasBody,
      tabId: payload.tabId
    },
    items: page
  };
  if (payload.raw === true) {
    const ids = new Set(matchedItems.slice(offset, offset + limit).map((item) => item.requestId));
    response.events = networkEvents.filter((event) => event.params && ids.has(event.params.requestId));
  }
  return response;
}

function networkRequestDetail(payload = {}) {
  if (!payload.requestId) {
    throw new Error("Missing requestId.");
  }
  const item = buildNetworkItems(networkEvents).find((candidate) => {
    if (candidate.requestId !== payload.requestId) return false;
    return payload.tabId === undefined || Number(candidate.tabId) === Number(payload.tabId);
  });
  if (!item) {
    throw new Error(`Network request not found: ${payload.requestId}`);
  }
  return {
    item: compactNetworkItem(item),
    events: item.events,
    bodyHint: item.hasResponseBody ? `/network/body?requestId=${encodeURIComponent(item.requestId)}` : undefined
  };
}

function pageDebugHelpers() {
  const cssPath = (el) => {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return "";
    if (el.id) return `#${CSS.escape(el.id)}`;
    const parts = [];
    while (el && el.nodeType === Node.ELEMENT_NODE && parts.length < 8) {
      let part = el.tagName.toLowerCase();
      if (el.classList && el.classList.length) {
        part += `.${Array.from(el.classList).slice(0, 2).map((c) => CSS.escape(c)).join(".")}`;
      }
      const parent = el.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((child) => child.tagName === el.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(el) + 1})`;
      }
      parts.unshift(part);
      el = parent;
    }
    return parts.join(" > ");
  };

  const visible = (el) => {
    if (!el || !el.getBoundingClientRect) return false;
    const win = el.ownerDocument && el.ownerDocument.defaultView ? el.ownerDocument.defaultView : window;
    const style = win.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
  };

  const roots = (root = document) => {
    const found = [{ root, label: "document" }];
    const visit = (node, label) => {
      if (!node || !node.querySelectorAll) return;
      for (const el of node.querySelectorAll("*")) {
        if (el.shadowRoot) {
          const nextLabel = `${label} ${cssPath(el)} >>>`;
          found.push({ root: el.shadowRoot, label: nextLabel });
          visit(el.shadowRoot, nextLabel);
        }
        if (el.tagName === "IFRAME") {
          try {
            if (el.contentDocument) {
              const frameLabel = `${label} ${cssPath(el)} ::frame`;
              found.push({ root: el.contentDocument, label: frameLabel });
              visit(el.contentDocument, frameLabel);
            }
          } catch (_) {
            // Cross-origin frames are intentionally skipped by DOM traversal.
          }
        }
      }
    };
    visit(root, "document");
    return found;
  };

  const queryDeep = (selector) => {
    if (!selector) return null;
    if (selector.includes(">>>")) {
      const parts = selector.split(">>>").map((part) => part.trim()).filter(Boolean);
      let root = document;
      let current = null;
      for (const part of parts) {
        current = root.querySelector(part);
        if (!current) return null;
        root = current.shadowRoot || current;
      }
      return current;
    }
    for (const item of roots()) {
      const found = item.root.querySelector(selector);
      if (found) return found;
    }
    return null;
  };

  const pointInRoot = (root, x, y) => {
    if (!root) return null;
    if (typeof root.elementFromPoint === "function") {
      return root.elementFromPoint(x, y);
    }
    if (typeof root.elementsFromPoint === "function") {
      const list = root.elementsFromPoint(x, y);
      if (list && list.length) return list[0];
    }
    if (root.querySelectorAll) {
      const candidates = Array.from(root.querySelectorAll("*"));
      for (let i = candidates.length - 1; i >= 0; i--) {
        const el = candidates[i];
        const rect = el.getBoundingClientRect();
        if (rect.left <= x && x <= rect.right && rect.top <= y && y <= rect.bottom && visible(el)) {
          return el;
        }
      }
    }
    return null;
  };

  const deepElementFromPoint = (x, y, root = document, rootLabel = "document", chain = []) => {
    let label = rootLabel;
    let el = pointInRoot(root, x, y);
    let hitChain = chain.slice();
    const seen = new Set();

    for (let depth = 0; el && depth < 25; depth++) {
      if (seen.has(el)) break;
      seen.add(el);

      const current = {
        tag: el.tagName,
        id: el.id || "",
        className: typeof el.className === "string" ? el.className : "",
        selector: cssPath(el),
        root: label
      };

      if (el.shadowRoot) {
        const shadowHit = pointInRoot(el.shadowRoot, x, y);
        if (shadowHit && shadowHit !== el && shadowHit.nodeType === Node.ELEMENT_NODE) {
          const nextLabel = `${label} ${cssPath(el)} >>>`;
          hitChain = hitChain.concat([{ ...current, pierce: "shadow", root: nextLabel }]);
          label = nextLabel;
          el = shadowHit;
          continue;
        }
      }

      if (el.tagName === "IFRAME") {
        try {
          if (el.contentDocument) {
            const rect = el.getBoundingClientRect();
            const frameLabel = `${label} ${cssPath(el)} ::frame`;
            return deepElementFromPoint(
              x - rect.left,
              y - rect.top,
              el.contentDocument,
              frameLabel,
              hitChain.concat([{ ...current, pierce: "iframe", root: frameLabel }])
            );
          }
        } catch (_) {
          // Cross-origin frames cannot be inspected from the extension script.
        }
      }

      return { el, rootLabel: label, chain: hitChain.concat([current]) };
    }

    return { el, rootLabel: label, chain: hitChain };
  };

  const elementInfo = (el, meta = "document") => {
    const rootLabel = typeof meta === "string" ? meta : meta.rootLabel || "document";
    const chain = typeof meta === "string" ? [] : meta.chain || [];
    const win = el.ownerDocument && el.ownerDocument.defaultView ? el.ownerDocument.defaultView : window;
    const rect = el.getBoundingClientRect();
    const style = win.getComputedStyle(el);
    const attrs = {};
    for (const attr of Array.from(el.attributes || [])) attrs[attr.name] = attr.value;
    const centerHit = deepElementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
      el.ownerDocument || document,
      rootLabel
    );
    return {
      selector: cssPath(el),
      root: rootLabel,
      chain,
      tag: el.tagName,
      id: el.id || "",
      className: typeof el.className === "string" ? el.className : "",
      attrs,
      text: (el.innerText || el.textContent || el.value || "").trim().slice(0, 1000),
      rect: {
        x: rect.x,
        y: rect.y,
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height
      },
      viewport: {
        scrollX: win.scrollX,
        scrollY: win.scrollY,
        innerWidth: win.innerWidth,
        innerHeight: win.innerHeight,
        devicePixelRatio: win.devicePixelRatio
      },
      style: {
        display: style.display,
        visibility: style.visibility,
        opacity: style.opacity,
        pointerEvents: style.pointerEvents,
        position: style.position,
        zIndex: style.zIndex,
        overflow: style.overflow,
        overflowX: style.overflowX,
        overflowY: style.overflowY,
        transform: style.transform
      },
      visible: visible(el),
      elementFromCenter: centerHit.el === el
    };
  };

  return { cssPath, visible, roots, queryDeep, pointInRoot, deepElementFromPoint, elementInfo };
}

async function shadowQuery(payload = {}) {
  return await runInPage(
    payload,
    (options, helpersSource) => {
      const { roots, elementInfo, visible } = eval(`(${helpersSource})`)();
      const limit = Number(options.limit || 100);
      const results = [];
      for (const item of roots()) {
        const candidates = options.selector ? Array.from(item.root.querySelectorAll(options.selector)) : Array.from(item.root.querySelectorAll("*"));
        for (const el of candidates) {
          if (results.length >= limit) break;
          if (options.visible !== false && !visible(el)) continue;
          const text = (el.innerText || el.textContent || el.value || "").trim();
          if (options.text && !text.includes(options.text)) continue;
          results.push(elementInfo(el, item.label));
        }
      }
      return results;
    },
    [payload, pageDebugHelpers.toString()]
  );
}

async function shadowSnapshot(payload = {}) {
  return await runInPage(
    payload,
    (options, helpersSource) => {
      const { roots } = eval(`(${helpersSource})`)();
      return roots().slice(0, Number(options.limit || 100)).map((item) => ({
        root: item.label,
        childElementCount: item.root.children ? item.root.children.length : 0,
        text: (item.root.body ? item.root.body.innerText : item.root.textContent || "").trim().slice(0, Number(options.maxText || 500))
      }));
    },
    [payload, pageDebugHelpers.toString()]
  );
}

async function elementInspect(payload = {}) {
  return await runInPage(
    payload,
    (options, helpersSource) => {
      const { queryDeep, deepElementFromPoint, elementInfo } = eval(`(${helpersSource})`)();
      const hit = options.selector
        ? { el: queryDeep(options.selector), rootLabel: "selector", chain: [] }
        : deepElementFromPoint(Number(options.x), Number(options.y));
      const el = hit.el;
      if (!el) throw new Error(`Element not found: ${options.selector || `${options.x},${options.y}`}`);
      return elementInfo(el, { rootLabel: hit.rootLabel || "document", chain: hit.chain || [] });
    },
    [payload, pageDebugHelpers.toString()]
  );
}

async function elementFromPoint(payload = {}) {
  return await elementInspect({ ...payload, selector: undefined });
}

async function elementHighlight(payload = {}) {
  return await runInPage(
    payload,
    async (options, helpersSource) => {
      const { queryDeep, deepElementFromPoint } = eval(`(${helpersSource})`)();
      const hit = options.selector
        ? { el: queryDeep(options.selector) }
        : deepElementFromPoint(Number(options.x), Number(options.y));
      const el = hit.el;
      if (!el) throw new Error(`Element not found: ${options.selector || `${options.x},${options.y}`}`);
      const rect = el.getBoundingClientRect();
      const box = document.createElement("div");
      box.id = "__port_tabs_highlight";
      Object.assign(box.style, {
        position: "fixed",
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
        border: `${options.borderWidth || 3}px solid ${options.color || "#ff3b30"}`,
        background: options.fill || "rgba(255, 59, 48, 0.12)",
        zIndex: "2147483647",
        pointerEvents: "none",
        boxSizing: "border-box"
      });
      document.getElementById("__port_tabs_highlight")?.remove();
      document.documentElement.appendChild(box);
      setTimeout(() => box.remove(), Number(options.duration || 2500));
      return { ok: true, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
    },
    [payload, pageDebugHelpers.toString()]
  );
}

async function elementScreenshot(payload = {}) {
  const inspect = await elementInspect(payload);
  const info = inspect.results && inspect.results[0] && inspect.results[0].result;
  if (!info || !info.rect || !info.rect.width || !info.rect.height) {
    throw new Error("Unable to resolve element rectangle.");
  }
  const result = await sendDevToolsCommand({
    tabId: inspect.tabId,
    method: "Page.captureScreenshot",
    params: {
      format: payload.format || "png",
      quality: payload.quality,
      captureBeyondViewport: true,
      clip: {
        x: info.rect.left + (info.viewport ? info.viewport.scrollX : 0),
        y: info.rect.top + (info.viewport ? info.viewport.scrollY : 0),
        width: info.rect.width,
        height: info.rect.height,
        scale: 1
      }
    }
  });
  return { tabId: inspect.tabId, element: info, result: result.result };
}

async function recorderCommand(payload = {}, action = "status") {
  return await runInPage(
    payload,
    (options, actionName, helpersSource) => {
      const { cssPath } = eval(`(${helpersSource})`)();
      const ensure = () => {
        if (window.__portTabsRecorder) return window.__portTabsRecorder;
        const state = {
          active: false,
          events: [],
          listeners: [],
          maxEvents: Number(options.maxEvents || 1000)
        };
        const push = (event, extra = {}) => {
          if (!state.active) return;
          const path = typeof event.composedPath === "function" ? event.composedPath() : [];
          const retarget = event.target && event.target.nodeType === Node.ELEMENT_NODE ? event.target : document.documentElement;
          const target = path.find((node) => node && node.nodeType === Node.ELEMENT_NODE) || retarget;
          const item = {
            time: Date.now(),
            type: event.type,
            selector: cssPath(target),
            retargetSelector: target === retarget ? undefined : cssPath(retarget),
            tag: target.tagName,
            text: (target.innerText || target.value || target.textContent || "").trim().slice(0, 160),
            x: event.clientX,
            y: event.clientY,
            button: event.button,
            buttons: event.buttons,
            key: event.key,
            deltaX: event.deltaX,
            deltaY: event.deltaY,
            scrollX,
            scrollY,
            ...extra
          };
          state.events.push(item);
          if (state.events.length > state.maxEvents) state.events.splice(0, state.events.length - state.maxEvents);
        };
        const onScroll = (event) => push(event, { scrollTarget: event.target === document ? "document" : undefined });
        for (const type of ["pointerdown", "pointermove", "pointerup", "mousedown", "mousemove", "mouseup", "click", "dblclick", "wheel", "keydown", "keyup", "input"]) {
          const listener = (event) => push(event);
          window.addEventListener(type, listener, true);
          state.listeners.push([window, type, listener]);
        }
        window.addEventListener("scroll", onScroll, true);
        state.listeners.push([window, "scroll", onScroll]);
        state.stop = () => {
          for (const [target, type, listener] of state.listeners) target.removeEventListener(type, listener, true);
          state.listeners = [];
          state.active = false;
        };
        window.__portTabsRecorder = state;
        return state;
      };
      const state = ensure();
      if (actionName === "start") {
        state.active = true;
        if (options.clear !== false) state.events = [];
      } else if (actionName === "stop") {
        state.active = false;
      } else if (actionName === "clear") {
        state.events = [];
      } else if (actionName === "dispose") {
        state.stop();
        delete window.__portTabsRecorder;
        return { active: false, disposed: true, events: [] };
      }
      return {
        active: state.active,
        count: state.events.length,
        events: state.events.slice(-(options.limit || state.maxEvents))
      };
    },
    [payload, action, pageDebugHelpers.toString()]
  );
}

async function executeCommand(message) {
  const payload = message.payload || {};

  switch (message.command || message.type) {
    case "openTab": {
      const url = normalizeHttpUrl(payload.url || message.url);
      const tab = await callChrome((done) => {
        chrome.tabs.create({ url, active: payload.active !== false, windowId: payload.windowId }, done);
      });
      return { tabId: tab.id, tab };
    }

    case "tabs.list": {
      const tabs = await callChrome((done) => chrome.tabs.query(payload.query || {}, done));
      return { tabs };
    }

    case "tabs.get": {
      const tabId = await getTargetTabId(payload);
      const tab = await callChrome((done) => chrome.tabs.get(tabId, done));
      return { tab };
    }

    case "tabs.active": {
      const tab = await getActiveTab();
      return { tab };
    }

    case "tabs.activate": {
      const tabId = await getTargetTabId(payload);
      const tab = await callChrome((done) => chrome.tabs.update(tabId, { active: true }, done));
      if (tab && tab.windowId !== undefined) {
        await callChrome((done) => chrome.windows.update(tab.windowId, { focused: true }, done));
      }
      return { tabId, tab };
    }

    case "tabs.close": {
      const tabId = await getTargetTabId(payload);
      await callChrome((done) => chrome.tabs.remove(tabId, done));
      return { tabId };
    }

    case "tabs.reload": {
      const tabId = await getTargetTabId(payload);
      await callChrome((done) => chrome.tabs.reload(tabId, { bypassCache: Boolean(payload.bypassCache) }, done));
      return { tabId };
    }

    case "tabs.navigate": {
      const tabId = await getTargetTabId(payload);
      const url = normalizeHttpUrl(payload.url);
      const tab = await callChrome((done) => chrome.tabs.update(tabId, { url }, done));
      return { tabId, tab };
    }

    case "tabs.back": {
      const tabId = await getTargetTabId(payload);
      await callChrome((done) => chrome.tabs.goBack(tabId, done));
      return { tabId };
    }

    case "tabs.forward": {
      const tabId = await getTargetTabId(payload);
      await callChrome((done) => chrome.tabs.goForward(tabId, done));
      return { tabId };
    }

    case "windows.list":
      return await listWindows(payload);

    case "windows.activate": {
      await callChrome((done) => chrome.windows.update(Number(payload.windowId), { focused: true }, done));
      return { windowId: Number(payload.windowId) };
    }

    case "script.evaluate":
    case "page.eval":
      return await evaluateWithScripting(payload);

    case "page.click":
      return await pageClick(payload);

    case "page.fill":
      return await pageFill(payload);

    case "page.key":
      return await pageKey(payload);

    case "page.scroll":
      return await pageScroll(payload);

    case "page.wait":
      return await pageWait(payload);

    case "page.content":
      return await pageContent(payload);

    case "page.interactive":
      return await pageInteractive(payload);

    case "page.snapshot":
      return await pageSnapshot(payload);

    case "page.storage.get":
      return await pageStorageGet(payload);

    case "page.storage.set":
      return await pageStorageSet(payload);

    case "input.mouse":
      return await cdpInputMouse(payload);

    case "input.click":
      return await cdpInputClick(payload);

    case "input.wheel":
      return await cdpInputWheel(payload);

    case "input.drag":
      return await cdpInputDrag(payload);

    case "input.key":
      return await cdpInputKey(payload);

    case "frames.list":
      return await framesList(payload);

    case "shadow.query":
      return await shadowQuery(payload);

    case "shadow.snapshot":
      return await shadowSnapshot(payload);

    case "element.inspect":
      return await elementInspect(payload);

    case "element.fromPoint":
      return await elementFromPoint(payload);

    case "element.highlight":
      return await elementHighlight(payload);

    case "element.screenshot":
      return await elementScreenshot(payload);

    case "recorder.start":
      return await recorderCommand(payload, "start");

    case "recorder.stop":
      return await recorderCommand(payload, "stop");

    case "recorder.list":
      return await recorderCommand(payload, "list");

    case "recorder.clear":
      return await recorderCommand(payload, "clear");

    case "recorder.dispose":
      return await recorderCommand(payload, "dispose");

    case "devtools.attach": {
      const tabId = await getTargetTabId(payload);
      await ensureDebuggerAttached(tabId, payload.protocolVersion);
      return { tabId, attached: true };
    }

    case "devtools.detach": {
      const tabId = await getTargetTabId(payload);
      await callChrome((done) => chrome.debugger.detach(tabTarget(tabId), done));
      attachedDebugTargets.delete(tabId);
      return { tabId, attached: false };
    }

    case "devtools.send":
    case "cdp.send":
      return await sendDevToolsCommand(payload);

    case "cdp.events":
      return { events: devtoolsEvents.slice(-(payload.limit || MAX_EVENTS)) };

    case "cdp.clearEvents":
      devtoolsEvents.length = 0;
      return { ok: true };

    case "devtools.evaluate":
    case "cdp.evaluate":
      return await sendDevToolsCommand({
        ...payload,
        method: "Runtime.evaluate",
        params: {
          expression: payload.expression || payload.code || "",
          awaitPromise: payload.awaitPromise !== false,
          returnByValue: payload.returnByValue !== false,
          ...(payload.params || {})
        }
      });

    case "devtools.screenshot":
    case "cdp.screenshot":
      return await sendDevToolsCommand({
        ...payload,
        method: "Page.captureScreenshot",
        params: {
          format: payload.format || "png",
          quality: payload.quality,
          fromSurface: payload.fromSurface !== false,
          captureBeyondViewport: payload.captureBeyondViewport !== false,
          ...(payload.params || {})
        }
      });

    case "network.start": {
      const tabId = await getTargetTabId(payload);
      await ensureDebuggerAttached(tabId, payload.protocolVersion);
      await sendDevToolsCommand({ tabId, method: "Network.enable", params: payload.params || {} });
      return { tabId, enabled: true };
    }

    case "network.list":
      return listNetworkRequests(payload);

    case "network.detail":
      return networkRequestDetail(payload);

    case "network.clear":
      networkEvents.length = 0;
      requestToTab.clear();
      return { ok: true };

    case "network.body": {
      const tabId = payload.tabId || requestToTab.get(payload.requestId) || (await getTargetTabId(payload));
      return await sendDevToolsCommand({
        tabId,
        method: "Network.getResponseBody",
        params: { requestId: payload.requestId }
      });
    }

    case "console.start": {
      const tabId = await getTargetTabId(payload);
      await ensureDebuggerAttached(tabId, payload.protocolVersion);
      await sendDevToolsCommand({ tabId, method: "Runtime.enable" });
      await sendDevToolsCommand({ tabId, method: "Log.enable" });
      return { tabId, enabled: true };
    }

    case "console.list":
      return { events: consoleEvents.slice(-(payload.limit || MAX_EVENTS)) };

    case "console.clear":
      consoleEvents.length = 0;
      return { ok: true };

    case "downloads.list": {
      const downloads = await callChrome((done) => chrome.downloads.search(payload.query || {}, done));
      return { downloads };
    }

    case "downloads.download": {
      const id = await callChrome((done) => chrome.downloads.download(payload, done));
      return { downloadId: id };
    }

    case "history.search": {
      const items = await callChrome((done) => chrome.history.search({
        text: payload.text || "",
        startTime: payload.startTime,
        endTime: payload.endTime,
        maxResults: payload.maxResults || 100
      }, done));
      return { items };
    }

    case "bookmarks.search": {
      const items = payload.tree
        ? await callChrome((done) => chrome.bookmarks.getTree(done))
        : await callChrome((done) => chrome.bookmarks.search(payload.query || "", done));
      return { items };
    }

    case "cookies.get": {
      const cookies = await callChrome((done) => chrome.cookies.getAll(payload, done));
      return { cookies };
    }

    case "cookies.set": {
      const cookie = await callChrome((done) => chrome.cookies.set(payload, done));
      return { cookie };
    }

    case "cookies.remove": {
      const details = await callChrome((done) => chrome.cookies.remove(payload, done));
      return { details };
    }

    case "storage.get":
      return await chromeStorageGet(payload);

    case "storage.set":
      return await chromeStorageSet(payload);

    default:
      throw new Error(`Unknown command: ${message.command || message.type}`);
  }
}

function handleNativeMessage(message) {
  if (!message || !message.id) {
    return;
  }

  executeCommand(message)
    .then((data) => sendResult(message.id, data))
    .catch((error) => sendError(message.id, error));
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source && source.tabId;
  const event = { tabId, method, params };
  pushLimited(devtoolsEvents, event);
  emitNativeEvent("cdp", event);

  if (method && method.startsWith("Network.")) {
    if (params && params.requestId && tabId !== undefined) {
      requestToTab.set(params.requestId, tabId);
    }
    pushLimited(networkEvents, event);
    emitNativeEvent("network", event);
  }

  if (method === "Runtime.consoleAPICalled" || method === "Runtime.exceptionThrown" || method === "Log.entryAdded") {
    pushLimited(consoleEvents, event);
    emitNativeEvent("console", event);
  }
});

chrome.debugger.onDetach.addListener((source) => {
  if (source && source.tabId !== undefined) {
    attachedDebugTargets.delete(source.tabId);
  }
});

async function connectNativeHost() {
  if (nativePort) {
    return;
  }

  try {
    nativePort = chrome.runtime.connectNative(NATIVE_HOST);
  } catch (error) {
    console.error("Failed to connect native host:", error);
    scheduleReconnect();
    return;
  }

  nativePort.onMessage.addListener(handleNativeMessage);
  nativePort.onDisconnect.addListener(() => {
    const lastError = chrome.runtime.lastError;
    if (lastError) {
      console.warn("Native host disconnected:", lastError.message);
    }

    nativePort = null;
    scheduleReconnect();
  });

  const config = await getProfileConfig();
  sendToNative({
    type: "hello",
    source: "port-tabs-extension",
    port: config.port,
    profileName: config.profileName,
    profileNote: config.profileNote,
    displayName: config.displayName,
    time: Date.now()
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target !== "port-tabs") {
    return false;
  }

  (async () => {
    if (message.type === "getStatus") {
      const config = await getProfileConfig();
      return {
        ok: true,
        ...config,
        connected: Boolean(nativePort),
        apiBaseUrl: `http://127.0.0.1:${config.port}`
      };
    }

    if (message.type === "setPort") {
      const port = await setConfiguredPort(message.port);
      const config = await getProfileConfig();
      if (!nativePort) {
        await connectNativeHost();
      }
      return {
        ok: true,
        ...config,
        port,
        connected: Boolean(nativePort),
        apiBaseUrl: `http://127.0.0.1:${port}`
      };
    }

    if (message.type === "setProfile") {
      const config = await setProfileConfig(message);
      if (!nativePort) {
        await connectNativeHost();
      }
      return {
        ok: true,
        ...config,
        connected: Boolean(nativePort),
        apiBaseUrl: `http://127.0.0.1:${config.port}`
      };
    }

    if (message.type === "reconnect") {
      if (nativePort) {
        nativePort.disconnect();
      }
      nativePort = null;
      await connectNativeHost();
      const config = await getProfileConfig();
      return {
        ok: true,
        ...config,
        connected: Boolean(nativePort),
        apiBaseUrl: `http://127.0.0.1:${config.port}`
      };
    }

    throw new Error(`Unknown popup message: ${message.type}`);
  })()
    .then((result) => sendResponse(result))
    .catch((error) => sendResponse({
      ok: false,
      error: error && error.message ? error.message : String(error)
    }));

  return true;
});

chrome.runtime.onInstalled.addListener(() => connectNativeHost());
chrome.runtime.onStartup.addListener(() => connectNativeHost());

connectNativeHost();

