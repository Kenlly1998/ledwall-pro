#!/usr/bin/env node

// bridge/led-bridge.mjs
import http from "node:http";
import net from "node:net";
import dgram from "node:dgram";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// src/core/novastar.js
var NOVA_TCP_PORT = 5200;
var NOVA_UDP_SEARCH_PORT = 3800;
var NOVA_SEARCH_REQUEST = "rqProMI:";
var NOVA_SEARCH_REPLY_PREFIX = "rpProMI:";
var HEADER_LEN = 18;
var FRAME_OVERHEAD = HEADER_LEN + 2;
var ADDR_PC = 254;
var REG = {
  modelId: 2,
  brightness: 33554433,
  displayMode: 318767108,
  inputInfo: 318832641,
  layerSourceBase: 318898194,
  layerStride: 48,
  preset: 324075776,
  backupA: 33554456,
  backupB: 33554584,
  backupC: 33554688
};
var DISPLAY_MODES = [
  { id: "normal", label: "Normal", code: 3, icon: "play" },
  { id: "freeze", label: "Congelar", code: 4, icon: "pause" },
  { id: "ftb", label: "Negro (FTB)", code: 5, icon: "moon" }
];
var TEST_PATTERNS = [
  { code: 1, label: "Rojo", color: "#FF2D2D" },
  { code: 2, label: "Verde", color: "#22D46B" },
  { code: 3, label: "Azul", color: "#2F6BFF" },
  { code: 4, label: "Blanco", color: "#FFFFFF" },
  { code: 0, label: "Negro", color: "#000000" },
  { code: 5, label: "Barras V", color: null },
  { code: 6, label: "Barras H", color: null },
  { code: 7, label: "Ajedrez", color: null },
  { code: 18, label: "Diagonales", color: null }
];
var INPUT_SLOTS = [
  { code: 0, label: "HDMI 1" },
  { code: 1, label: "HDMI 2" },
  { code: 2, label: "DVI 1" },
  { code: 3, label: "DVI 2" },
  { code: 4, label: "SDI" },
  { code: 5, label: "OPT 1" },
  { code: 6, label: "OPT 2" },
  { code: 7, label: "Mosaico" }
];
var PRESET_COUNT = 10;
var LAYER_COUNT = 3;
var u16le = (n) => [n & 255, n >>> 8 & 255];
var u32le = (n) => [n & 255, n >>> 8 & 255, n >>> 16 & 255, n >>> 24 & 255];
var readU16 = (b, i) => b[i] | b[i + 1] << 8;
var readU32 = (b, i) => (b[i] | b[i + 1] << 8 | b[i + 2] << 16 | b[i + 3] << 24) >>> 0;
function checksum(bytes, from = 2, to = bytes.length) {
  let sum = 21845;
  for (let i = from; i < to; i++) sum += bytes[i];
  return u16le(sum & 65535);
}
function buildFrame({ address, data = [], length, write = true, dest = 0, devType = 0, port = 0, board = 0, label = 0 }) {
  const len = length ?? data.length;
  const head = [85, 170, 0, label & 255, ADDR_PC, dest, devType, port, ...u16le(board), write ? 1 : 0, 0, ...u32le(address), ...u16le(len)];
  const body = [...head, ...data];
  return [...body, ...checksum(body)];
}
function toHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(" ");
}
function fromHex(str) {
  const clean = String(str || "").replace(/0x/gi, "").replace(/[^0-9a-f]/gi, "");
  if (clean.length % 2) throw new Error("Hex con n\xFAmero impar de d\xEDgitos");
  const out = [];
  for (let i = 0; i < clean.length; i += 2) out.push(parseInt(clean.slice(i, i + 2), 16));
  return out;
}
function extractFrame(buffer) {
  const b = Array.from(buffer);
  let start = -1;
  for (let i = 0; i + 1 < b.length; i++) {
    if (b[i] === 170 && b[i + 1] === 85) {
      start = i;
      break;
    }
  }
  if (start < 0) return null;
  const view = b.slice(start);
  if (view.length < FRAME_OVERHEAD) return null;
  const total = FRAME_OVERHEAD + readU16(view, 16);
  if (view.length < total) return null;
  return { frame: view.slice(0, total), rest: view.slice(total) };
}
function parseResponse(bytes) {
  const b = Array.from(bytes);
  if (b.length < FRAME_OVERHEAD || b[0] !== 170 || b[1] !== 85) {
    return { ok: false, error: "Respuesta sin cabecera aa 55" };
  }
  const len = readU16(b, 16);
  if (b.length < FRAME_OVERHEAD + len) return { ok: false, error: "Respuesta incompleta" };
  const end = HEADER_LEN + len;
  const [lo, hi] = checksum(b, 2, end);
  const checksumOk = b[end] === lo && b[end + 1] === hi;
  const ack = b[2];
  return {
    ok: checksumOk && ack === 0,
    checksumOk,
    ack,
    label: b[3],
    write: b[10] === 1,
    address: readU32(b, 12),
    length: len,
    data: b.slice(HEADER_LEN, end),
    error: !checksumOk ? "Checksum inv\xE1lido" : ack !== 0 ? `El equipo rechaz\xF3 el comando (ack 0x${ack.toString(16)})` : null
  };
}
function buildResponse(request, data = []) {
  const r = Array.from(request);
  const write = r[10] === 1;
  const payload = write ? [] : data;
  const body = [170, 85, 0, r[3], r[5], ADDR_PC, r[6], r[7], r[8], r[9], r[10], 0, r[12], r[13], r[14], r[15], ...u16le(payload.length), ...payload];
  return [...body, ...checksum(body)];
}
var pctToLevel = (pct) => Math.round(Math.max(0, Math.min(100, pct)) / 100 * 255);
function cmdBrightness(level) {
  const v = Math.max(0, Math.min(255, Math.round(level)));
  return buildFrame({ address: REG.brightness, data: [v], dest: 255, devType: 1, port: 255, board: 65535 });
}
function cmdDisplayMode(modeId) {
  const mode = DISPLAY_MODES.find((m) => m.id === modeId);
  if (!mode) throw new Error(`Modo desconocido: ${modeId}`);
  return buildFrame({ address: REG.displayMode, data: [mode.code, 0] });
}
function cmdTestPattern(code) {
  return buildFrame({ address: REG.displayMode, data: [6, code & 255] });
}
function presetFrame(op, index, extra = []) {
  const n = Math.max(0, Math.min(PRESET_COUNT - 1, index));
  return buildFrame({ address: REG.preset + op, data: [...extra, n] });
}
var cmdPresetLoad = (index) => presetFrame(0, index);
var cmdPresetSave = (index) => presetFrame(2, index);
function cmdLayerSource(layer, slotCode) {
  const l = Math.max(0, Math.min(LAYER_COUNT - 1, layer));
  return buildFrame({ address: REG.layerSourceBase + l * REG.layerStride, data: [slotCode & 255, 0, 0] });
}
function cmdBackupMode(backup) {
  const v = backup ? 128 : 0;
  return [
    buildFrame({ address: REG.backupA, data: [v, v, v, v] }),
    buildFrame({ address: REG.backupB, data: [v, v, v, v] }),
    buildFrame({ address: REG.backupC, data: [v, v] })
  ];
}
function actionFrames(action) {
  switch (action?.type) {
    case "brightness":
      return [cmdBrightness(pctToLevel(action.value))];
    case "mode":
      return [cmdDisplayMode(action.value)];
    case "pattern":
      return [cmdTestPattern(action.value)];
    case "preset":
      return [cmdPresetLoad(action.value)];
    case "preset-save":
      return [cmdPresetSave(action.value)];
    case "source":
      return [cmdLayerSource(action.layer || 0, action.value)];
    case "backup":
      return cmdBackupMode(!!action.value);
    default:
      throw new Error(`Acci\xF3n desconocida: ${action?.type}`);
  }
}
function describeAction(action) {
  switch (action?.type) {
    case "brightness":
      return `Brillo ${action.value}%`;
    case "mode":
      return DISPLAY_MODES.find((m) => m.id === action.value)?.label || action.value;
    case "pattern":
      return `Patr\xF3n ${TEST_PATTERNS.find((p) => p.code === action.value)?.label || action.value}`;
    case "preset":
      return `Preset ${action.value + 1}`;
    case "preset-save":
      return `Guardar preset ${action.value + 1}`;
    case "source":
      return `Capa ${(action.layer || 0) + 1} \u2190 ${INPUT_SLOTS.find((s) => s.code === action.value)?.label || action.value}`;
    case "backup":
      return action.value ? "Modo backup" : "Modo principal";
    default:
      return "\u2014";
  }
}
function isPrivateIPv4(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(host || "").trim());
  if (!m) return false;
  const [a, b, c, d] = m.slice(1).map(Number);
  if ([a, b, c, d].some((x) => x > 255)) return false;
  return a === 10 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 169 && b === 254 || a === 127;
}

// src/core/novastarSim.js
var SIM_MODEL_ID = [12, 98];
var SIM_INPUTS = [
  { signal: 1, width: 1920, height: 1080, period: 16667 },
  { signal: 1, width: 3840, height: 2160, period: 33333 },
  { signal: 0 },
  { signal: 0 },
  { signal: 1, width: 1920, height: 1080, period: 2e4 }
];
function inputsBlock() {
  const data = Array(256).fill(0);
  SIM_INPUTS.forEach((s, i) => {
    const o = i * 32;
    data[o + 2] = s.signal;
    if (!s.signal) return;
    data[o + 3] = s.width & 255;
    data[o + 4] = s.width >> 8;
    data[o + 5] = s.height & 255;
    data[o + 6] = s.height >> 8;
    data[o + 7] = s.period & 255;
    data[o + 8] = s.period >> 8;
  });
  return data;
}
function createSimulator() {
  const state = { brightness: 255, mode: "normal", pattern: null, preset: null, backup: false, layers: [0, 1, 0] };
  function handle(request) {
    const r = Array.from(request);
    const len = r[16] | r[17] << 8;
    const end = 18 + (r[10] === 1 ? len : 0);
    const [lo, hi] = checksum(r, 2, end);
    if (r[0] !== 85 || r[1] !== 170 || r[end] !== lo || r[end + 1] !== hi) return null;
    const address = (r[12] | r[13] << 8 | r[14] << 16 | r[15] << 24) >>> 0;
    const data = r.slice(18, end);
    if (r[10] !== 1) {
      if (address === REG.modelId) return buildResponse(r, SIM_MODEL_ID);
      if (address === REG.inputInfo) return buildResponse(r, inputsBlock());
      return buildResponse(r, Array(len).fill(0));
    }
    if (address === REG.brightness) state.brightness = data[0];
    else if (address === REG.displayMode) {
      if (data[0] === 6) {
        state.pattern = data[1];
        state.mode = "pattern";
      } else {
        state.mode = DISPLAY_MODES.find((m) => m.code === data[0])?.id || state.mode;
        state.pattern = null;
      }
    } else if (address === REG.preset) state.preset = data[0];
    else if (address === REG.backupC) state.backup = data[0] === 128;
    else if (address >= REG.layerSourceBase && (address - REG.layerSourceBase) % REG.layerStride === 0) {
      state.layers[(address - REG.layerSourceBase) / REG.layerStride] = data[0];
    }
    return buildResponse(r);
  }
  return { state, handle };
}

// src/core/schedule.js
var SCHEDULE_MAX_LAG_MS = 15 * 60 * 1e3;
var DAY_MS = 24 * 60 * 60 * 1e3;
function parseTime(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h < 24 && min < 60 ? h * 60 + min : null;
}
function occurrenceOn(rule, date) {
  const m = parseTime(rule.time);
  if (m === null || !(rule.days || []).includes(date.getDay())) return null;
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), Math.floor(m / 60), m % 60, 0, 0);
}
var active = (rules) => (rules || []).filter((r) => r && r.enabled !== false);
function dueRules(rules, from, to, maxLagMs = SCHEDULE_MAX_LAG_MS) {
  const start = Math.max(from.getTime(), to.getTime() - maxLagMs);
  const end = to.getTime();
  return active(rules).filter((r) => [new Date(start), to].some((d) => {
    const t = occurrenceOn(r, d)?.getTime();
    return t !== void 0 && t > start && t <= end;
  }));
}
function nextRun(rule, now) {
  for (let d = 0; d <= 7; d++) {
    const t = occurrenceOn(rule, new Date(now.getTime() + d * DAY_MS));
    if (t && t.getTime() > now.getTime()) return t;
  }
  return null;
}
function lastRun(rule, now) {
  for (let d = 0; d <= 7; d++) {
    const t = occurrenceOn(rule, new Date(now.getTime() - d * DAY_MS));
    if (t && t.getTime() <= now.getTime()) return t;
  }
  return null;
}
function targetsOf(rule, devices) {
  const ids = rule.deviceIds || [];
  return ids.includes("*") ? devices : devices.filter((d) => ids.includes(d.id));
}
var actionKey = (a) => a.type === "source" ? `source:${a.layer || 0}` : a.type === "pattern" ? "mode" : a.type;
function resumeActions(rules, devices, now) {
  const latest = /* @__PURE__ */ new Map();
  active(rules).forEach((rule) => {
    const at = lastRun(rule, now);
    if (!at) return;
    targetsOf(rule, devices).forEach((dev) => {
      const key = `${dev.id}|${actionKey(rule.action)}`;
      const prev = latest.get(key);
      if (!prev || prev.at < at) latest.set(key, { device: dev, action: rule.action, at, ruleId: rule.id });
    });
  });
  return [...latest.values()].sort((a, b) => a.at - b.at);
}

// bridge/led-bridge.mjs
var VERSION = "1.0.0";
var HTTP_PORT = Number(process.env.PORT || 8787);
var TOKEN = process.env.TOKEN || "";
var DEMO = process.argv.includes("--demo");
var ALLOWED_PORTS = (process.env.ALLOWED_PORTS || String(NOVA_TCP_PORT)).split(",").map(Number);
var REQUEST_TIMEOUT_MS = 2500;
var IDLE_CLOSE_MS = 6e4;
var TICK_MS = 1e4;
var MAX_BODY = 64 * 1024;
var MAX_FRAMES = 16;
var DATA_FILE = path.join(process.env.DATA_DIR || path.dirname(fileURLToPath(import.meta.url)), "schedule.json");
var normalizeToken = (t) => String(t || "").replace(/[\s-]/g, "").toUpperCase();
var TOKEN_KEY = normalizeToken(TOKEN);
var log = [];
function record(level, text, extra = {}) {
  const entry = { at: (/* @__PURE__ */ new Date()).toISOString(), level, text, ...extra };
  log.unshift(entry);
  log.length = Math.min(log.length, 200);
  console.log(`[${entry.at.slice(11, 19)}] ${level.toUpperCase().padEnd(5)} ${text}`);
}
var sims = /* @__PURE__ */ new Map();
var DeviceLink = class {
  constructor(host, port) {
    this.host = host;
    this.port = port;
    this.socket = null;
    this.buffer = [];
    this.pending = null;
    this.queue = Promise.resolve();
    this.idleTimer = null;
  }
  connect() {
    if (this.socket && !this.socket.destroyed) return Promise.resolve(this.socket);
    return new Promise((resolve, reject) => {
      const s = net.createConnection({ host: this.host, port: this.port });
      s.setNoDelay(true);
      const fail = (err) => {
        s.destroy();
        reject(err);
      };
      s.setTimeout(REQUEST_TIMEOUT_MS, () => fail(new Error("Tiempo de conexi\xF3n agotado")));
      s.once("error", fail);
      s.once("connect", () => {
        s.setTimeout(0);
        s.off("error", fail);
        s.on("error", (err) => {
          if (this.socket === s) this.drop(err);
        });
        s.on("close", () => {
          if (this.socket === s) this.drop(new Error("Conexi\xF3n cerrada por el equipo"));
        });
        s.on("data", (chunk) => {
          if (this.socket === s) this.onData(chunk);
        });
        this.socket = s;
        this.buffer = [];
        resolve(s);
      });
    });
  }
  onData(chunk) {
    this.buffer.push(...chunk);
    const found = extractFrame(this.buffer);
    if (!found) return;
    this.buffer = found.rest;
    if (this.pending) {
      const { resolve, timer } = this.pending;
      clearTimeout(timer);
      this.pending = null;
      resolve(found.frame);
    }
  }
  drop(err) {
    if (this.socket) this.socket.destroy();
    this.socket = null;
    if (this.pending) {
      const { reject, timer } = this.pending;
      clearTimeout(timer);
      this.pending = null;
      reject(err);
    }
  }
  async transact(frame) {
    if (DEMO) {
      const key = `${this.host}:${this.port}`;
      if (!sims.has(key)) sims.set(key, createSimulator());
      await new Promise((r) => setTimeout(r, 15));
      const res = sims.get(key).handle(frame);
      if (!res) throw new Error("El simulador rechaz\xF3 la trama");
      return res;
    }
    const s = await this.connect();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null;
        this.drop(new Error("Sin respuesta del equipo"));
        reject(new Error("Sin respuesta del equipo"));
      }, REQUEST_TIMEOUT_MS);
      this.pending = { resolve, reject, timer };
      s.write(Buffer.from(frame));
    });
  }
  // Envía tramas en orden; cada una espera su respuesta antes de la siguiente.
  send(frames) {
    const run = async () => {
      clearTimeout(this.idleTimer);
      const out = [];
      try {
        for (const f of frames) out.push(await this.transact(f));
      } finally {
        this.idleTimer = setTimeout(() => this.drop(new Error("inactivo")), IDLE_CLOSE_MS);
      }
      return out;
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {
    });
    return p;
  }
};
var links = /* @__PURE__ */ new Map();
function linkFor(host, port = NOVA_TCP_PORT) {
  if (!isPrivateIPv4(host)) throw new Error(`IP no permitida (solo red local): ${host}`);
  if (!ALLOWED_PORTS.includes(port)) throw new Error(`Puerto no permitido: ${port}`);
  const key = `${host}:${port}`;
  if (!links.has(key)) links.set(key, new DeviceLink(host, port));
  return links.get(key);
}
async function sendFrames(host, port, frames) {
  const t0 = Date.now();
  const responses = await linkFor(host, port).send(frames);
  const parsed = responses.map(parseResponse);
  const bad = parsed.find((r) => !r.ok);
  if (bad) throw new Error(bad.error || "Respuesta inv\xE1lida");
  return { responses: responses.map(toHex), ms: Date.now() - t0 };
}
function broadcastAddresses() {
  const out = /* @__PURE__ */ new Set(["255.255.255.255"]);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family !== "IPv4" || ni.internal) continue;
      const ip = ni.address.split(".").map(Number);
      const mask = ni.netmask.split(".").map(Number);
      out.add(ip.map((b, i) => b | ~mask[i] & 255).join("."));
    }
  }
  return [...out];
}
function discover(timeoutMs = 1500) {
  if (DEMO) return Promise.resolve([{ ip: "192.168.0.10", reply: `${NOVA_SEARCH_REPLY_PREFIX}App,0161 (demo)` }]);
  return new Promise((resolve) => {
    const found = /* @__PURE__ */ new Map();
    const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
    sock.on("message", (msg, rinfo) => {
      const text = msg.toString("latin1");
      if (text.startsWith(NOVA_SEARCH_REPLY_PREFIX)) found.set(rinfo.address, { ip: rinfo.address, reply: text });
    });
    sock.on("error", () => {
    });
    sock.bind(() => {
      sock.setBroadcast(true);
      const payload = Buffer.from(NOVA_SEARCH_REQUEST, "latin1");
      broadcastAddresses().forEach((addr) => sock.send(payload, NOVA_UDP_SEARCH_PORT, addr, () => {
      }));
    });
    setTimeout(() => {
      sock.close();
      resolve([...found.values()]);
    }, timeoutMs);
  });
}
var schedule = { devices: [], rules: [], resumeOnStart: true, updatedAt: null };
try {
  schedule = { ...schedule, ...JSON.parse(fs.readFileSync(DATA_FILE, "utf8")) };
} catch {
}
function saveSchedule() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(schedule, null, 2));
}
async function runAction(device, action, origin) {
  try {
    const { ms } = await sendFrames(device.host, device.port || NOVA_TCP_PORT, actionFrames(action));
    record("ok", `${origin}: ${device.name || device.host} \u2192 ${describeAction(action)} (${ms} ms)`);
    return true;
  } catch (err) {
    record("error", `${origin}: ${device.name || device.host} \u2192 ${describeAction(action)}: ${err.message}`);
    return false;
  }
}
var RESUME_RETRY_MS = 3e4;
var RESUME_MAX_TRIES = 20;
async function resumeState(attempt = 1) {
  const pending = resumeActions(schedule.rules, schedule.devices, /* @__PURE__ */ new Date());
  if (!pending.length) return;
  if (attempt === 1) record("info", `Reponiendo ${pending.length} estado(s) de la programaci\xF3n tras el arranque`);
  const failed = [];
  for (const p of pending) if (!await runAction(p.device, p.action, "Reposici\xF3n")) failed.push(p);
  if (failed.length && attempt < RESUME_MAX_TRIES) setTimeout(() => resumeState(attempt + 1), RESUME_RETRY_MS);
}
var lastTick = /* @__PURE__ */ new Date();
setInterval(() => {
  const now = /* @__PURE__ */ new Date();
  dueRules(schedule.rules, lastTick, now).forEach((rule) => {
    targetsOf(rule, schedule.devices).forEach((dev) => runAction(dev, rule.action, "Programaci\xF3n"));
  });
  lastTick = now;
}, TICK_MS);
setTimeout(() => {
  if (schedule.resumeOnStart) resumeState();
}, 5e3);
function cleanDevice(d) {
  return { id: String(d.id), name: String(d.name || ""), host: String(d.host || ""), port: Number(d.port) || NOVA_TCP_PORT };
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("Cuerpo demasiado grande"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch {
        reject(new Error("JSON inv\xE1lido"));
      }
    });
  });
}
function reply(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, X-Bridge-Token",
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS"
  });
  res.end(JSON.stringify(body));
}
var routes = {
  "GET /api/health": async () => ({
    ok: true,
    version: VERSION,
    demo: DEMO,
    time: (/* @__PURE__ */ new Date()).toISOString(),
    uptimeS: Math.round(process.uptime()),
    devices: schedule.devices.length,
    rules: schedule.rules.length,
    auth: !!TOKEN
  }),
  "POST /api/send": async (body) => {
    const frames = (body.frames || []).slice(0, MAX_FRAMES).map(fromHex);
    if (!frames.length) throw new Error("Sin tramas");
    if (frames.some((f) => f[0] !== 85 || f[1] !== 170)) throw new Error("Trama sin cabecera 55 aa");
    return sendFrames(String(body.host || ""), Number(body.port) || NOVA_TCP_PORT, frames);
  },
  "GET /api/discover": async () => ({ devices: await discover() }),
  "GET /api/schedule": async () => schedule,
  "PUT /api/schedule": async (body) => {
    schedule = {
      devices: (body.devices || []).map(cleanDevice).filter((d) => isPrivateIPv4(d.host)),
      rules: Array.isArray(body.rules) ? body.rules : [],
      resumeOnStart: body.resumeOnStart !== false,
      updatedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    saveSchedule();
    const now = /* @__PURE__ */ new Date();
    const upcoming = schedule.rules.filter((r) => r.enabled !== false).map((r) => ({ id: r.id, at: nextRun(r, now)?.toISOString() || null }));
    record("info", `Programaci\xF3n actualizada: ${schedule.rules.length} regla(s), ${schedule.devices.length} equipo(s)`);
    return { ok: true, upcoming };
  },
  "GET /api/log": async () => ({ log })
};
var server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return reply(res, 204, {});
  const route = routes[`${req.method} ${req.url.split("?")[0]}`];
  if (!route) return reply(res, 404, { error: "Ruta no encontrada" });
  if (TOKEN_KEY && normalizeToken(req.headers["x-bridge-token"]) !== TOKEN_KEY) return reply(res, 401, { error: "Token inv\xE1lido" });
  try {
    const body = req.method === "POST" || req.method === "PUT" ? await readJson(req) : {};
    reply(res, 200, await route(body));
  } catch (err) {
    reply(res, 400, { error: err.message });
  }
});
server.listen(HTTP_PORT, "0.0.0.0", () => {
  const ips = Object.values(os.networkInterfaces()).flat().filter((n) => n && n.family === "IPv4" && !n.internal).map((n) => n.address);
  record("info", `Puente LED Wall Pro ${VERSION}${DEMO ? " (DEMO)" : ""} escuchando en el puerto ${HTTP_PORT}`);
  ips.forEach((ip) => console.log(`        En la app usa: http://${ip}:${HTTP_PORT}`));
  if (TOKEN) console.log("        Token requerido (X-Bridge-Token).");
});
