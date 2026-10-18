"use strict";
const { companyRole } = require('./lib/access');
const { validRegistration, isAuthorized } = require('./lib/access_requests');
const { makeApprovalEmailSender, isEmailReady } = require('./lib/email_https');
const { canAcceptDeviceReading } = require('./lib/device_policy');


const crypto = require("crypto");
const express = require("express");
const rateLimit = require("express-rate-limit");
const helmet = require("helmet");
const mqtt = require("mqtt");
const admin = require("firebase-admin");
const { parseSensorMessage, normalizeDeviceId } = require("./lib/status");
const { evaluateSchedule, effectiveStatus } = require("./lib/schedule");

function requiredEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`Variável obrigatória ausente: ${name}`);
  return value;
}

function boolEnv(name, fallback = false) {
  const raw = String(process.env[name] ?? fallback).trim().toLowerCase();
  return ["1", "true", "yes", "sim", "on"].includes(raw);
}

const PORT = Number(process.env.PORT || 3000);
const MQTT_HOST = requiredEnv("MQTT_HOST");
const MQTT_PORT = Number(process.env.MQTT_PORT || 8883);
const MQTT_USER = requiredEnv("MQTT_USER");
const MQTT_PASS = requiredEnv("MQTT_PASS");
const MQTT_TOPICS = String(process.env.MQTT_TOPICS || "capacete/status,capacete/+/status")
  .split(",")
  .map((v) => v.trim())
  .filter(Boolean);
const FIREBASE_DATABASE_URL = requiredEnv("FIREBASE_DATABASE_URL");
const FIREBASE_SERVICE_ACCOUNT = String(
  process.env.FIREBASE_SERVICE_ACCOUNT_JSON || process.env.FIREBASE_SERVICE_ACCOUNT || "",
).trim();
if (!FIREBASE_SERVICE_ACCOUNT) {
  throw new Error("Variável obrigatória ausente: FIREBASE_SERVICE_ACCOUNT_JSON");
}
const DEFAULT_DEVICE_ID = normalizeDeviceId(process.env.DEFAULT_DEVICE_ID || "default");
const DEFAULT_FUNCIONARIO = String(process.env.DEFAULT_FUNCIONARIO || "Funcionário não vinculado").trim();
const DEFAULT_EPI = String(process.env.DEFAULT_EPI || "Capacete 01").trim();
const DEFAULT_OBRA = String(process.env.DEFAULT_OBRA || "").trim();
const OFFLINE_GAP_SECONDS = Math.max(30, Number(process.env.OFFLINE_GAP_SECONDS || 120));
const CONTEXT_CACHE_SECONDS = Math.max(5, Number(process.env.CONTEXT_CACHE_SECONDS || 30));
const ENABLE_LEGACY_MIRROR = boolEnv("ENABLE_LEGACY_MIRROR", true);
const ENABLE_TEST_ENDPOINTS = boolEnv("ENABLE_TEST_ENDPOINTS", false);
const ADMIN_TEST_TOKEN = String(process.env.ADMIN_TEST_TOKEN || "").trim();
const MARY_AI_ENABLED = boolEnv("MARY_AI_ENABLED", true);
const OPENROUTER_API_KEY = String(process.env.OPENROUTER_API_KEY || "").trim();
const OPENROUTER_MODEL = String(process.env.OPENROUTER_MODEL || "").trim();
const OPENROUTER_SITE_URL = String(process.env.OPENROUTER_SITE_URL || "").trim();
const MARY_AI_CONFIGURED = MARY_AI_ENABLED && Boolean(OPENROUTER_API_KEY && OPENROUTER_MODEL);

let serviceAccount;
try {
  serviceAccount = JSON.parse(FIREBASE_SERVICE_ACCOUNT);
} catch (error) {
  throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON inválido: confirme o JSON da chave privada no Render");
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: FIREBASE_DATABASE_URL,
});
const db = admin.database();

const app = express();
app.disable("x-powered-by");
app.use(helmet());
app.use(express.json({ limit: "32kb" }));

const adminLimiter = rateLimit({
  windowMs: 60_000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
});

const maryLimiter = rateLimit({
  windowMs: 60_000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
});

const deviceCache = new Map();
const contextCache = new Map();
let processingQueue = Promise.resolve();
let mqttConnected = false;

function enqueue(work) {
  processingQueue = processingQueue
    .then(work)
    .catch((error) => console.error("Fila de processamento:", error.message));
  return processingQueue;
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}min ${s}s`;
  if (m > 0) return `${m} min ${s} seg`;
  return `${s} seg`;
}

function localParts(date, timeZone = "America/Sao_Paulo") {
  let zone = timeZone;
  try {
    new Intl.DateTimeFormat("pt-BR", { timeZone: zone }).format(date);
  } catch (_) {
    zone = "America/Sao_Paulo";
  }
  const dateText = new Intl.DateTimeFormat("pt-BR", {
    timeZone: zone,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(date);
  const timeText = new Intl.DateTimeFormat("pt-BR", {
    timeZone: zone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
  return { dateText, timeText };
}

function textStatus(status) {
  switch (status) {
    case "ATIVO": return "CAPACETE EM USO";
    case "INATIVO": return "SEM CAPACETE";
    case "PAUSA": return "PAUSA PROGRAMADA";
    case "FORA_JORNADA": return "FORA DO EXPEDIENTE";
    default: return "AGUARDANDO LEITURA";
  }
}

function alarmStatus(status) {
  switch (status) {
    case "ATIVO": return "CAPACETE EM USO";
    case "INATIVO": return "ALERTA: SEM CAPACETE";
    case "PAUSA": return "PAUSA PROGRAMADA";
    case "FORA_JORNADA": return "FORA DO EXPEDIENTE";
    default: return "AGUARDANDO";
  }
}

function descriptionStatus(status, reason = "") {
  switch (status) {
    case "ATIVO": return "Sensor detectou o capacete em uso";
    case "INATIVO": return "Sensor livre durante período de monitoramento obrigatório";
    case "PAUSA": return reason ? `Monitoramento suspenso: ${reason}` : "Pausa programada";
    case "FORA_JORNADA": return "Leitura fora do expediente programado";
    default: return "Aguardando leitura válida";
  }
}

function statusValue(status) {
  if (status === "ATIVO") return 1;
  if (status === "INATIVO") return 0;
  if (status === "PAUSA") return 2;
  if (status === "FORA_JORNADA") return 3;
  return -1;
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function isValidCnpj(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length !== 14 || /^(\d)\1{13}$/.test(digits)) return false;
  const calc = (length) => {
    let sum = 0;
    let weight = length - 7;
    for (let i = 0; i < length; i += 1) {
      sum += Number(digits[i]) * weight;
      weight -= 1;
      if (weight === 1) weight = 9;
    }
    const mod = sum % 11;
    return mod < 2 ? 0 : 11 - mod;
  };
  return Number(digits[12]) === calc(12) && Number(digits[13]) === calc(13);
}

function companyMonitoringBase(companyId, deviceId) {
  return `companies/${companyId}/monitoring/devices/${deviceId}`;
}

async function resolveDeviceContext(deviceId, reading, nowMs) {
  const cached = contextCache.get(deviceId);
  if (cached && nowMs - cached.loadedAtMs < CONTEXT_CACHE_SECONDS * 1000) {
    return { ...cached.value };
  }

  const registrySnap = await db.ref(`deviceRegistry/${deviceId}`).once("value");
  const registry = asObject(registrySnap.val());
  const companyId = String(registry.companyId || "").trim();

  const base = {
    companyId,
    employeeId: String(registry.employeeId || "").trim(),
    helmetId: String(registry.helmetId || "").trim(),
    worksiteId: String(registry.worksiteId || "").trim(),
    funcionario: reading.funcionario || DEFAULT_FUNCIONARIO,
    epi: String(registry.helmetCode || reading.epi || DEFAULT_EPI).trim(),
    obra: reading.obra || DEFAULT_OBRA,
    schedule: null,
    timezone: "America/Sao_Paulo",
  };

  if (companyId) {
    const companyBase = `companies/${companyId}`;
    const employeePath = base.employeeId ? `${companyBase}/employees/${base.employeeId}` : null;
    const worksitePath = base.worksiteId ? `${companyBase}/worksites/${base.worksiteId}` : null;
    const helmetPath = base.helmetId ? `${companyBase}/helmets/${base.helmetId}` : null;

    const [employeeSnap, worksiteSnap, helmetSnap, defaultScheduleSnap] = await Promise.all([
      employeePath ? db.ref(employeePath).once("value") : Promise.resolve(null),
      worksitePath ? db.ref(worksitePath).once("value") : Promise.resolve(null),
      helmetPath ? db.ref(helmetPath).once("value") : Promise.resolve(null),
      db.ref(`${companyBase}/settings/defaultSchedule`).once("value"),
    ]);

    const employee = asObject(employeeSnap?.val());
    const worksite = asObject(worksiteSnap?.val());
    const helmetItem = asObject(helmetSnap?.val());
    const defaultSchedule = asObject(defaultScheduleSnap?.val());

    if (String(employee.name || "").trim()) base.funcionario = String(employee.name).trim();
    if (String(worksite.name || "").trim()) base.obra = String(worksite.name).trim();
    if (String(helmetItem.code || "").trim()) base.epi = String(helmetItem.code).trim();
    base.schedule = employee.schedule && typeof employee.schedule === "object"
      ? employee.schedule
      : (Object.keys(defaultSchedule).length ? defaultSchedule : null);
    base.timezone = String(base.schedule?.timezone || "America/Sao_Paulo");
  }

  contextCache.set(deviceId, { loadedAtMs: nowMs, value: base });
  return { ...base };
}

async function loadOpenState(deviceId) {
  if (deviceCache.has(deviceId)) return deviceCache.get(deviceId);
  const snapshot = await db.ref(`devices/${deviceId}/estadoAberto`).once("value");
  const value = snapshot.val();
  if (!value || !["ATIVO", "INATIVO", "PAUSA", "FORA_JORNADA"].includes(value.status)) {
    deviceCache.set(deviceId, null);
    return null;
  }

  const startedAtMs = Date.parse(value.inicioISO || "");
  const lastReadingAtMs = Date.parse(value.ultimaLeituraISO || value.inicioISO || "");
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(lastReadingAtMs)) {
    deviceCache.set(deviceId, null);
    return null;
  }

  const state = {
    status: value.status,
    sensorStatus: String(value.sensorStatus || value.status || ""),
    raw: String(value.raw || ""),
    startedAtMs,
    lastReadingAtMs,
    funcionario: String(value.funcionario || DEFAULT_FUNCIONARIO),
    epi: String(value.epi || DEFAULT_EPI),
    obra: String(value.obra || DEFAULT_OBRA),
    companyId: String(value.companyId || ""),
    employeeId: String(value.employeeId || ""),
    helmetId: String(value.helmetId || ""),
    worksiteId: String(value.worksiteId || ""),
    scheduleReason: String(value.scheduleReason || ""),
    timezone: String(value.timezone || "America/Sao_Paulo"),
    activeAlertId: String(value.activeAlertId || ""),
  };
  deviceCache.set(deviceId, state);
  return state;
}

async function updateSummary(deviceId, status, seconds, companyId = "") {
  const result = await db.ref(`devices/${deviceId}/resumo`).transaction((current) => {
    const resumo = current || {
      totalEventos: 0,
      totalAlertas: 0,
      tempoAtivoSegundos: 0,
      tempoInativoSegundos: 0,
      tempoPausaSegundos: 0,
      tempoForaExpedienteSegundos: 0,
    };
    resumo.totalEventos = Number(resumo.totalEventos || 0) + 1;
    resumo.totalAlertas = Number(resumo.totalAlertas || 0) + (status === "INATIVO" ? 1 : 0);
    if (status === "ATIVO") {
      resumo.tempoAtivoSegundos = Number(resumo.tempoAtivoSegundos || 0) + seconds;
    } else if (status === "INATIVO") {
      resumo.tempoInativoSegundos = Number(resumo.tempoInativoSegundos || 0) + seconds;
    } else if (status === "PAUSA") {
      resumo.tempoPausaSegundos = Number(resumo.tempoPausaSegundos || 0) + seconds;
    } else if (status === "FORA_JORNADA") {
      resumo.tempoForaExpedienteSegundos = Number(resumo.tempoForaExpedienteSegundos || 0) + seconds;
    }
    const active = Number(resumo.tempoAtivoSegundos || 0);
    const inactive = Number(resumo.tempoInativoSegundos || 0);
    const totalMonitored = active + inactive;
    resumo.conformidade = totalMonitored > 0 ? Math.round((active / totalMonitored) * 100) : 0;
    resumo.tempoAtivo = formatDuration(active);
    resumo.tempoInativo = formatDuration(inactive);
    resumo.tempoPausa = formatDuration(Number(resumo.tempoPausaSegundos || 0));
    resumo.tempoForaExpediente = formatDuration(Number(resumo.tempoForaExpedienteSegundos || 0));
    resumo.atualizadoEm = new Date().toISOString();
    return resumo;
  });
  const resumo = result.snapshot.val();
  if (companyId) {
    await db.ref(`${companyMonitoringBase(companyId, deviceId)}/resumo`).set(resumo);
  }
  return resumo;
}

async function closeActiveAlert(state, endMs, normalizedBy = "CAPACETE_RECOLOCADO") {
  if (!state.companyId || !state.activeAlertId) return;
  const path = `companies/${state.companyId}/alerts/${state.activeAlertId}`;
  const durationSeconds = Math.max(0, Math.floor((endMs - state.startedAtMs) / 1000));
  await db.ref(path).update({
    active: false,
    normalized: true,
    normalizedAt: new Date(endMs).toISOString(),
    normalizedReason: normalizedBy,
    durationSeconds,
    duration: formatDuration(durationSeconds),
    updatedAt: new Date().toISOString(),
  });
}

async function saveClosedEvent(deviceId, state, endMs, reason = "TRANSICAO") {
  const startMs = state.startedAtMs;
  const safeEndMs = Math.max(startMs, endMs);
  const seconds = Math.max(0, Math.floor((safeEndMs - startMs) / 1000));
  const start = new Date(startMs);
  const end = new Date(safeEndMs);
  const startParts = localParts(start, state.timezone);
  const endParts = localParts(end, state.timezone);
  const eventId = db.ref(`devices/${deviceId}/eventos`).push().key;
  const excludedFromCompliance = state.status === "PAUSA" || state.status === "FORA_JORNADA";
  const registro = {
    eventId,
    deviceId,
    companyId: state.companyId || "",
    employeeId: state.employeeId || "",
    helmetId: state.helmetId || "",
    worksiteId: state.worksiteId || "",
    funcionario: state.funcionario,
    epi: state.epi,
    obra: state.obra,
    raw: state.raw,
    rawAtual: state.raw,
    sensorStatus: state.sensorStatus,
    status: state.status,
    statusAtual: state.status,
    titulo: textStatus(state.status),
    data: endParts.dateText,
    horaInicio: startParts.timeText,
    horaFim: endParts.timeText,
    inicioISO: start.toISOString(),
    fimISO: end.toISOString(),
    dataHoraISO: end.toISOString(),
    tempoSegundos: seconds,
    tempo: formatDuration(seconds),
    descricao: state.status === "ATIVO"
      ? `Capacete em uso por ${formatDuration(seconds)}`
      : state.status === "INATIVO"
        ? `Sem capacete por ${formatDuration(seconds)}`
        : descriptionStatus(state.status, state.scheduleReason),
    alarme: alarmStatus(state.status),
    valor: statusValue(state.status),
    excludedFromCompliance,
    scheduleReason: state.scheduleReason || "",
    motivoFechamento: reason,
  };

  const updates = {
    [`devices/${deviceId}/eventos/${eventId}`]: registro,
  };
  if (state.companyId) {
    updates[`${companyMonitoringBase(state.companyId, deviceId)}/eventos/${eventId}`] = registro;
  }
  await db.ref().update(updates);
  const resumo = await updateSummary(deviceId, state.status, seconds, state.companyId);

  if (ENABLE_LEGACY_MIRROR && deviceId === DEFAULT_DEVICE_ID) {
    const legacyEvent = db.ref("eventos").push();
    await db.ref().update({
      [`eventos/${legacyEvent.key}`]: registro,
      resumo,
    });
  }

  return { registro, resumo };
}

async function persistCurrent(deviceId, reading, state, nowMs) {
  const now = new Date(nowMs);
  const parts = localParts(now, state.timezone);
  const current = {
    deviceId,
    companyId: state.companyId || "",
    employeeId: state.employeeId || "",
    helmetId: state.helmetId || "",
    worksiteId: state.worksiteId || "",
    funcionario: state.funcionario,
    epi: state.epi,
    obra: state.obra,
    raw: reading.raw,
    rawAtual: reading.raw,
    sensorStatus: state.sensorStatus,
    status: state.status,
    statusAtual: state.status,
    titulo: textStatus(state.status),
    data: parts.dateText,
    horaFim: parts.timeText,
    atualizadoEm: now.toISOString(),
    ultimaLeituraISO: new Date(state.lastReadingAtMs).toISOString(),
    estadoDesdeISO: new Date(state.startedAtMs).toISOString(),
    descricao: descriptionStatus(state.status, state.scheduleReason),
    alarme: alarmStatus(state.status),
    valor: statusValue(state.status),
    scheduleReason: state.scheduleReason || "",
    excludedFromCompliance: state.status === "PAUSA" || state.status === "FORA_JORNADA",
  };
  const open = {
    status: state.status,
    sensorStatus: state.sensorStatus,
    raw: state.raw,
    inicioISO: new Date(state.startedAtMs).toISOString(),
    ultimaLeituraISO: new Date(state.lastReadingAtMs).toISOString(),
    funcionario: state.funcionario,
    epi: state.epi,
    obra: state.obra,
    companyId: state.companyId || "",
    employeeId: state.employeeId || "",
    helmetId: state.helmetId || "",
    worksiteId: state.worksiteId || "",
    scheduleReason: state.scheduleReason || "",
    timezone: state.timezone || "America/Sao_Paulo",
    activeAlertId: state.activeAlertId || "",
  };
  const meta = {
    deviceId,
    companyId: state.companyId || "",
    employeeId: state.employeeId || "",
    helmetId: state.helmetId || "",
    worksiteId: state.worksiteId || "",
    funcionario: state.funcionario,
    epi: state.epi,
    obra: state.obra,
    ultimaLeituraISO: new Date(state.lastReadingAtMs).toISOString(),
  };

  const updates = {
    [`devices/${deviceId}/ultimo`]: current,
    [`devices/${deviceId}/estadoAberto`]: open,
    [`devices/${deviceId}/meta`]: meta,
  };
  if (state.companyId) {
    const base = companyMonitoringBase(state.companyId, deviceId);
    updates[`${base}/ultimo`] = current;
    updates[`companies/${state.companyId}/monitoring/current/${deviceId}`] = current;
    updates[`${base}/estadoAberto`] = open;
    updates[`${base}/meta`] = meta;
  }
  if (ENABLE_LEGACY_MIRROR && deviceId === DEFAULT_DEVICE_ID) {
    updates.ultimo = current;
  }
  await db.ref().update(updates);
}

async function collectAuthorizedTokens(companyId = "") {
  const [authSnap, usersSnap] = await Promise.all([
    db.ref("authorizedUsers").once("value"),
    db.ref("users").once("value"),
  ]);
  const authorized = authSnap.val() || {};
  const users = usersSnap.val() || {};
  const items = [];
  for (const [uid, allowed] of Object.entries(authorized)) {
    const enabled = allowed === true || (allowed && allowed.enabled === true);
    if (!enabled) continue;
    const profile = asObject(users?.[uid]?.profile);
    if (profile.enabled === false) continue;
    if (companyId) {
      const sameCompany = String(profile.companyId || "") === companyId;
      const platformAdmin = profile.platformAdmin === true;
      if (!sameCompany && !platformAdmin) continue;
    }
    const tokenMap = users?.[uid]?.fcmTokens || {};
    for (const [tokenId, item] of Object.entries(tokenMap)) {
      if (item && typeof item.token === "string" && item.token.length > 20) {
        items.push({ uid, tokenId, token: item.token });
      }
    }
  }
  return items;
}

async function createNoHelmetAlert(reading, state, nowMs) {
  if (!state.companyId) return "";
  const ref = db.ref(`companies/${state.companyId}/alerts`).push();
  const alert = {
    alertId: ref.key,
    type: "SEM_CAPACETE",
    severity: "critical",
    source: "mary",
    companyId: state.companyId,
    deviceId: reading.deviceId,
    employeeId: state.employeeId || "",
    helmetId: state.helmetId || "",
    worksiteId: state.worksiteId || "",
    funcionario: state.funcionario,
    epi: state.epi,
    obra: state.obra,
    startedAt: new Date(nowMs).toISOString(),
    active: true,
    acknowledged: false,
    message: `${state.funcionario} está sem capacete`,
    createdAt: new Date(nowMs).toISOString(),
    updatedAt: new Date(nowMs).toISOString(),
  };
  await ref.set(alert);
  return ref.key || "";
}

async function sendNoHelmetNotification(reading, state) {
  try {
    const tokenItems = await collectAuthorizedTokens(state.companyId);
    if (!tokenItems.length) return;
    const unique = new Map(tokenItems.map((item) => [item.token, item]));
    const entries = [...unique.values()];
    const location = state.obra ? ` • ${state.obra}` : "";

    for (let i = 0; i < entries.length; i += 500) {
      const batch = entries.slice(i, i + 500);
      const response = await admin.messaging().sendEachForMulticast({
        tokens: batch.map((item) => item.token),
        notification: {
          title: "Mary • Alerta de segurança",
          body: `${state.funcionario} retirou o capacete${location}`,
        },
        data: {
          source: "mary",
          alertType: "SEM_CAPACETE",
          alertId: state.activeAlertId || "",
          companyId: state.companyId || "",
          deviceId: reading.deviceId,
          status: "INATIVO",
          funcionario: state.funcionario,
          epi: state.epi,
          obra: state.obra || "",
        },
        android: {
          priority: "high",
          notification: {
            priority: "max",
          },
        },
      });

      const removals = {};
      response.responses.forEach((item, index) => {
        if (item.success) return;
        const code = item.error?.code || "";
        if (code === "messaging/registration-token-not-registered" ||
            code === "messaging/invalid-registration-token") {
          const tokenItem = batch[index];
          removals[`users/${tokenItem.uid}/fcmTokens/${tokenItem.tokenId}`] = null;
        }
      });
      if (Object.keys(removals).length) await db.ref().update(removals);
    }
  } catch (error) {
    console.error("FCM:", error.message);
  }
}

function contextChanged(state, next) {
  return String(state.companyId || "") !== String(next.companyId || "") ||
    String(state.employeeId || "") !== String(next.employeeId || "") ||
    String(state.helmetId || "") !== String(next.helmetId || "") ||
    String(state.worksiteId || "") !== String(next.worksiteId || "");
}

function makeState(reading, context, scheduleResult, nowMs) {
  const status = effectiveStatus(reading.status, scheduleResult);
  return {
    status,
    sensorStatus: reading.status,
    raw: reading.raw,
    startedAtMs: nowMs,
    lastReadingAtMs: nowMs,
    funcionario: context.funcionario,
    epi: context.epi,
    obra: context.obra,
    companyId: context.companyId,
    employeeId: context.employeeId,
    helmetId: context.helmetId,
    worksiteId: context.worksiteId,
    scheduleReason: scheduleResult.reason || "",
    timezone: scheduleResult.timezone || context.timezone || "America/Sao_Paulo",
    activeAlertId: "",
  };
}

async function processReading(reading) {
  // Legacy ESP32 is intentionally exempt. New devices require registration
  // by an approved administrator, preventing random topics polluting Firebase.
  const registrySnap = await db.ref(`deviceRegistry/${reading.deviceId}`).once('value');
  const registry = registrySnap.val();
  if (!canAcceptDeviceReading(reading.deviceId, registry, DEFAULT_DEVICE_ID)) {
    console.warn(`Dispositivo não cadastrado/inativo: ${reading.deviceId}`);
    return;
  }
  const nowMs = Date.now();
  const context = await resolveDeviceContext(reading.deviceId, reading, nowMs);
  const scheduleResult = evaluateSchedule(context.schedule, new Date(nowMs));
  const nextState = makeState(reading, context, scheduleResult, nowMs);
  let state = await loadOpenState(reading.deviceId);
  let enteredInactive = false;

  if (!state) {
    state = nextState;
    deviceCache.set(reading.deviceId, state);
    enteredInactive = state.status === "INATIVO";
  } else {
    const gapMs = nowMs - state.lastReadingAtMs;
    const mustTransition = nextState.status !== state.status || contextChanged(state, nextState);

    if (gapMs > OFFLINE_GAP_SECONDS * 1000) {
      if (state.status === "INATIVO") await closeActiveAlert(state, state.lastReadingAtMs, "LACUNA_OFFLINE");
      await saveClosedEvent(reading.deviceId, state, state.lastReadingAtMs, "LACUNA_OFFLINE");
      state = nextState;
      deviceCache.set(reading.deviceId, state);
      enteredInactive = state.status === "INATIVO";
    } else if (mustTransition) {
      if (state.status === "INATIVO") {
        const normalization = nextState.status === "ATIVO" ? "CAPACETE_RECOLOCADO" : "MUDANCA_DE_JORNADA";
        await closeActiveAlert(state, nowMs, normalization);
      }
      await saveClosedEvent(reading.deviceId, state, nowMs, "TRANSICAO");
      state = nextState;
      deviceCache.set(reading.deviceId, state);
      enteredInactive = state.status === "INATIVO";
    } else {
      state.raw = reading.raw;
      state.sensorStatus = reading.status;
      state.lastReadingAtMs = nowMs;
      state.funcionario = context.funcionario;
      state.epi = context.epi;
      state.obra = context.obra;
      state.scheduleReason = scheduleResult.reason || state.scheduleReason;
      state.timezone = scheduleResult.timezone || state.timezone;
    }
  }

  if (enteredInactive) {
    state.activeAlertId = await createNoHelmetAlert(reading, state, nowMs);
  }

  state.lastReadingAtMs = nowMs;
  await persistCurrent(reading.deviceId, reading, state, nowMs);

  if (enteredInactive) {
    await sendNoHelmetNotification(reading, state);
  }

  console.log(
    `${new Date(nowMs).toISOString()} ${reading.deviceId}: ${reading.raw} => sensor=${reading.status} efetivo=${state.status}`,
  );
}


async function applyScheduleTickForDevice(deviceId, state, nowMs) {
  if (!state || !["ATIVO", "INATIVO"].includes(state.sensorStatus)) return;
  // Um relógio de jornada nunca transforma ausência de comunicação em
  // "sem capacete". Se a leitura estiver velha, o app mostrará OFFLINE.
  if (nowMs - state.lastReadingAtMs > OFFLINE_GAP_SECONDS * 1000) return;

  const reading = {
    deviceId,
    status: state.sensorStatus,
    raw: state.raw,
    funcionario: state.funcionario,
    epi: state.epi,
    obra: state.obra,
  };
  const context = await resolveDeviceContext(deviceId, reading, nowMs);
  const scheduleResult = evaluateSchedule(context.schedule, new Date(nowMs));
  const next = makeState(reading, context, scheduleResult, nowMs);
  next.lastReadingAtMs = state.lastReadingAtMs;

  if (next.status === state.status && !contextChanged(state, next)) return;

  if (state.status === "INATIVO") {
    const normalization = next.status === "ATIVO" ? "CAPACETE_RECOLOCADO" : "MUDANCA_DE_JORNADA";
    await closeActiveAlert(state, nowMs, normalization);
  }
  await saveClosedEvent(deviceId, state, nowMs, "TRANSICAO_JORNADA");

  if (next.status === "INATIVO") {
    next.activeAlertId = await createNoHelmetAlert(reading, next, nowMs);
  }
  deviceCache.set(deviceId, next);
  await persistCurrent(deviceId, reading, next, nowMs);
  if (next.status === "INATIVO") {
    await sendNoHelmetNotification(reading, next);
  }
  console.log(`${new Date(nowMs).toISOString()} ${deviceId}: transição automática de jornada => ${next.status}`);
}

async function applyScheduledTransitions() {
  const nowMs = Date.now();
  for (const [deviceId, state] of deviceCache.entries()) {
    try {
      await applyScheduleTickForDevice(deviceId, state, nowMs);
    } catch (error) {
      console.error(`Jornada ${deviceId}:`, error.message);
    }
  }
}

const scheduleTimer = setInterval(() => {
  enqueue(() => applyScheduledTransitions());
}, 30_000);
scheduleTimer.unref();

const client = mqtt.connect(`mqtts://${MQTT_HOST}:${MQTT_PORT}`, {
  username: MQTT_USER,
  password: MQTT_PASS,
  protocolVersion: 4,
  reconnectPeriod: 5000,
  connectTimeout: 20_000,
  clean: true,
  rejectUnauthorized: true,
});

client.on("connect", () => {
  mqttConnected = true;
  console.log("MQTT conectado com TLS.");
  client.subscribe(MQTT_TOPICS, { qos: 1 }, (error) => {
    if (error) console.error("Erro ao assinar MQTT:", error.message);
    else console.log("Tópicos MQTT ativos:", MQTT_TOPICS.join(", "));
  });
});
client.on("offline", () => { mqttConnected = false; console.warn("MQTT offline."); });
client.on("close", () => { mqttConnected = false; });
client.on("error", (error) => { mqttConnected = false; console.error("MQTT:", error.message); });
client.on("message", (topic, message) => {
  const reading = parseSensorMessage(topic, message.toString(), {
    deviceId: DEFAULT_DEVICE_ID,
    funcionario: DEFAULT_FUNCIONARIO,
    epi: DEFAULT_EPI,
    obra: DEFAULT_OBRA,
  });
  if (!reading) {
    console.warn("Leitura MQTT ignorada por status inválido.");
    return;
  }
  enqueue(() => processReading(reading));
});

app.get("/", (req, res) => {
  res.json({ ok: true, service: "capacete-inteligente-backend", version: "3.5.0", maryAiConfigured: MARY_AI_CONFIGURED });
});

app.get("/health", async (req, res) => {
  let firebaseOk = false;
  try {
    await db.ref(".info/connected").once("value");
    firebaseOk = true;
  } catch (_) {
    firebaseOk = false;
  }
  res.status(firebaseOk ? 200 : 503).json({
    ok: firebaseOk && mqttConnected,
    service: "capacete-inteligente-backend",
    firebase: firebaseOk,
    mqtt: mqttConnected,
    uptimeSeconds: Math.floor(process.uptime()),
    version: "3.5.0",
    maryAiConfigured: MARY_AI_CONFIGURED,
  });
});


async function requireAuthorizedUser(req, res, next) {
  try {
    const header = String(req.header("authorization") || "");
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match) return res.status(401).json({ ok: false, error: "Token ausente" });
    const decoded = await admin.auth().verifyIdToken(match[1], true);
    const [profileSnap, authorizedSnap] = await Promise.all([
      db.ref(`users/${decoded.uid}/profile`).once("value"),
      db.ref(`authorizedUsers/${decoded.uid}`).once("value"),
    ]);
    const profile = asObject(profileSnap.val());
    const authorizedRaw = authorizedSnap.val();
    const authorized = asObject(authorizedRaw);
    const authorizedEnabled = authorizedRaw === true || authorized.enabled === true;
    if (profile.enabled !== true || !authorizedEnabled || authorized.enabled === false) {
      return res.status(403).json({ ok: false, error: "Usuário não autorizado" });
    }
    req.appUser = {
      uid: decoded.uid,
      email: decoded.email || "",
      companyId: String(profile.companyId || "").trim(),
      role: String(profile.role || "viewer").trim(),
      platformAdmin: profile.platformAdmin === true,
    };
    return next();
  } catch (_) {
    return res.status(401).json({ ok: false, error: "Sessão inválida" });
  }
}


// Novo acesso empresarial: somente o servidor pode criar, aprovar e notificar.
const APPROVAL_ADMIN_EMAIL = String(process.env.APPROVAL_ADMIN_EMAIL || '').trim();
// Render Free blocks SMTP (25/465/587). Use transactional mail HTTPS instead.
const mailConfigured = isEmailReady(process.env);
const sendApprovalEmail = makeApprovalEmailSender({ env: process.env, fetchImpl: fetch });
app.get('/access-requests/health', (_req, res) => res.json({
  ok: true,
  registrationEnabled: mailConfigured,
  emailProvider: mailConfigured ? 'brevo-https' : 'not-configured',
}));
app.post('/access-requests/register', adminLimiter, async (req, res) => {
  // Falha fechada: não crie conta sem capacidade de enviar a solicitação por e-mail.
  if (!mailConfigured) return res.status(503).json({ok:false,error:'O cadastro aguarda a configuração do e-mail de autorização no servidor.'});
  let data;
  try { data = validRegistration(req.body || {}); }
  catch (e) { return res.status(400).json({ok:false,error:e.message}); }
  let created;
  try {
    created = await admin.auth().createUser({email:data.email,password:data.password,displayName:data.name,disabled:false});
    const now = new Date().toISOString();
    try {
      await db.ref().update({
      [`users/${created.uid}/profile`]: {displayName:data.name,role:'viewer',companyId:'',enabled:false,platformAdmin:false},
      [`authorizedUsers/${created.uid}`]: {enabled:false},
      [`enterpriseAccessRequests/${created.uid}`]: {uid:created.uid,email:data.email,displayName:data.name,company:data.company,cnpj:data.cnpj,status:'pending',requestedAt:now,emailDelivered:false},
      });
    } catch (writeError) {
      try { await admin.auth().deleteUser(created.uid); } catch (_) {}
      throw writeError;
    }
    try {
      await sendApprovalEmail({
        subject: 'Capacete Empresa - nova solicitação de acesso',
        text: `Uma conta aguarda sua autorização.\nNome: ${data.name}\nEmpresa: ${data.company}\nCNPJ: ${data.cnpj}\nE-mail: ${data.email}\nUID: ${created.uid}\n\nAprove/rejeite somente com credenciais de administração geral usando a rota segura /platform/access-requests. Não autorize respondendo a este e-mail.`,
      });
      await db.ref(`enterpriseAccessRequests/${created.uid}/emailDelivered`).set(true);
    } catch(e) {
      console.error('Falha ao enviar solicitação empresarial:', e.message);
      return res.status(503).json({ok:false,error:'Conta criada aguardando autorização, mas o e-mail não foi entregue. Contate a administração. Não crie uma segunda conta.'});
    }
    return res.status(201).json({ok:true,status:'pending',message:'Solicitação enviada por e-mail à administração. Aguarde a aprovação.'});
  } catch(e) {
    if (e.code === 'auth/email-already-exists') return res.status(409).json({ok:false,error:'Este e-mail já está cadastrado. Use Entrar.'});
    console.error('Falha no cadastro empresarial:', e.message);
    return res.status(500).json({ok:false,error:'Não foi possível concluir o cadastro. Tente novamente.'});
  }
});

app.get('/access-requests/status', adminLimiter, async(req,res) => {
  try {
    const match=String(req.header('authorization')||'').match(/^Bearer\s+(.+)$/i);
    if(!match) return res.status(401).json({ok:false,error:'Sessão ausente'});
    const token=await admin.auth().verifyIdToken(match[1],true);
    const [profileSnap,authSnap,requestSnap]=await Promise.all([
      db.ref(`users/${token.uid}/profile`).once('value'),
      db.ref(`authorizedUsers/${token.uid}`).once('value'),
      db.ref(`enterpriseAccessRequests/${token.uid}`).once('value')]);
    const approved=isAuthorized(asObject(profileSnap.val()),authSnap.val());
    const request=asObject(requestSnap.val());
    return res.json({ok:true,status:approved?'approved':request.status==='rejected'?'rejected':'pending'});
  } catch(_) {return res.status(401).json({ok:false,error:'Não foi possível validar o acesso'});}
});

app.get('/platform/access-requests', adminLimiter, requirePlatformAdmin, async(req,res) => {
  const snap=await db.ref('enterpriseAccessRequests').once('value');
  const all=asObject(snap.val());
  const requests=Object.values(all).filter(x=>x&&x.status==='pending').map(x=>({
    uid:x.uid,email:x.email,displayName:x.displayName,company:x.company,cnpj:x.cnpj,requestedAt:x.requestedAt,emailDelivered:x.emailDelivered===true,
  }));
  res.json({ok:true,requests});
});

app.post('/platform/access-requests/:uid/decision', adminLimiter, requirePlatformAdmin, async(req,res) => {
  const uid=String(req.params.uid||'').trim();
  const decision=String(req.body?.decision||'').trim();
  if(!/^[A-Za-z0-9_-]{15,128}$/.test(uid)||!['approve','reject'].includes(decision))return res.status(400).json({ok:false,error:'Pedido inválido'});
  const r=await db.ref(`enterpriseAccessRequests/${uid}`).once('value');
  const request=asObject(r.val());
  if(request.status!=='pending')return res.status(409).json({ok:false,error:'Solicitação não está pendente'});
  if(uid===req.platformAdmin.uid)return res.status(400).json({ok:false,error:'Não é permitido aprovar a própria conta'});
  try {
    const now=new Date().toISOString(),approved=decision==='approve';
    await db.ref().update({
      [`users/${uid}/profile`]:{displayName:request.displayName,role:approved?'admin':'viewer',companyId:'',enabled:approved,platformAdmin:false},
      [`authorizedUsers/${uid}`]: {enabled:approved,email:request.email},
      [`enterpriseAccessRequests/${uid}/status`]: approved?'approved':'rejected',
      [`enterpriseAccessRequests/${uid}/decidedAt`]: now,
      [`enterpriseAccessRequests/${uid}/decidedBy`]: req.platformAdmin.uid,
    });
    return res.json({ok:true,status:approved?'approved':'rejected'});
  } catch(e) {console.error('Erro na decisão de acesso:',e.message);return res.status(500).json({ok:false,error:'Não foi possível finalizar a decisão'});}
});

app.post("/account/companies", adminLimiter, requireAuthorizedUser, async (req, res) => {
  try {
    const body = asObject(req.body);
    const cnpj = String(body.cnpj || "").replace(/\D/g, "");
    const legalName = String(body.legalName || "").trim();
    const tradeName = String(body.tradeName || legalName).trim();
    if (!isValidCnpj(cnpj)) return res.status(400).json({ ok: false, error: "CNPJ inválido" });
    if (!legalName) return res.status(400).json({ ok: false, error: "Razão social obrigatória" });

    const currentCompanyId = String(req.appUser.companyId || "").trim();
    const mayCreate = req.appUser.platformAdmin === true || !currentCompanyId || req.appUser.role === "admin";
    if (!mayCreate) {
      return res.status(403).json({ ok: false, error: "Seu perfil não pode adicionar empresas" });
    }

    const companyId = `cnpj_${cnpj}`;
    const existing = await db.ref(`companies/${companyId}/profile`).once("value");
    if (existing.exists()) {
      return res.status(409).json({ ok: false, error: "Já existe uma empresa cadastrada com este CNPJ" });
    }

    const now = new Date().toISOString();
    const profile = {
      cnpj,
      legalName,
      tradeName,
      email: String(body.email || "").trim(),
      phone: String(body.phone || "").trim(),
      address: String(body.address || "").trim(),
      city: String(body.city || "").trim(),
      state: String(body.state || "").trim().toUpperCase(),
      responsibleName: String(body.responsibleName || "").trim(),
      sstResponsible: String(body.sstResponsible || "").trim(),
      pgrResponsible: String(body.pgrResponsible || "").trim(),
      risks: String(body.risks || "").trim(),
      active: body.active !== false,
      createdAt: now,
      updatedAt: now,
    };

    const membership = {
      uid: req.appUser.uid,
      email: req.appUser.email || "",
      displayName: String(body.ownerName || req.appUser.email || "Administrador").trim(),
      role: "admin",
      enabled: true,
      updatedAt: now,
    };

    const updates = {
      [`companies/${companyId}/profile`]: profile,
      [`companies/${companyId}/members/${req.appUser.uid}`]: membership,
      [`users/${req.appUser.uid}/companies/${companyId}`]: {
        role: "admin",
        enabled: true,
        updatedAt: now,
      },
      [`authorizedUsers/${req.appUser.uid}`]: {
        enabled: true,
        email: req.appUser.email || "",
        companyId: currentCompanyId || companyId,
        updatedAt: now,
      },
    };

    if (!currentCompanyId) {
      updates[`users/${req.appUser.uid}/profile`] = {
        companyId,
        displayName: membership.displayName,
        role: "admin",
        enabled: true,
        platformAdmin: req.appUser.platformAdmin === true,
        updatedAt: now,
      };

      // Migração única do dashboard legado: preserva leitura atual, resumo e
      // histórico no primeiro capacete da primeira empresa criada.
      const [ultimoSnap, resumoSnap, eventosSnap] = await Promise.all([
        db.ref("ultimo").once("value"),
        db.ref("resumo").once("value"),
        db.ref("eventos").once("value"),
      ]);
      const ultimo = asObject(ultimoSnap.val());
      const resumo = asObject(resumoSnap.val());
      const eventos = asObject(eventosSnap.val());
      if (Object.keys(ultimo).length > 0 || Object.keys(resumo).length > 0 || Object.keys(eventos).length > 0) {
        if (Object.keys(ultimo).length > 0) updates[`companies/${companyId}/monitoring/devices/default/ultimo`] = ultimo;
        if (Object.keys(resumo).length > 0) updates[`companies/${companyId}/monitoring/devices/default/resumo`] = resumo;
        if (Object.keys(eventos).length > 0) updates[`companies/${companyId}/monitoring/devices/default/eventos`] = eventos;
        updates[`companies/${companyId}/helmets/default`] = {
          code: String(ultimo.epi || "Capacete 01"),
          deviceId: "default",
          employeeId: "",
          worksiteId: "",
          active: true,
          updatedAt: now,
        };
        updates[`deviceRegistry/default`] = {
          companyId,
          helmetId: "default",
          helmetCode: String(ultimo.epi || "Capacete 01"),
          employeeId: "",
          worksiteId: "",
          active: true,
          updatedAt: now,
        };
      }
    }

    await db.ref().update(updates);
    return res.status(201).json({ ok: true, companyId, selected: !currentCompanyId, migratedLegacy: !currentCompanyId });
  } catch (error) {
    console.error("Criar empresa da conta:", error.message);
    return res.status(500).json({ ok: false, error: "Não foi possível cadastrar a empresa" });
  }
});

app.post("/mary/chat", maryLimiter, requireAuthorizedUser, async (req, res) => {
  if (!MARY_AI_CONFIGURED) {
    return res.status(503).json({ ok: false, error: "IA online da Mary não configurada no servidor" });
  }

  const message = String(req.body?.message || "").trim();
  if (!message || message.length > 2000) {
    return res.status(400).json({ ok: false, error: "Mensagem inválida" });
  }

  let companyName = String(req.body?.companyName || "").trim();
  if (req.appUser.companyId) {
    try {
      const companySnap = await db.ref(`companies/${req.appUser.companyId}/profile`).once("value");
      const profile = asObject(companySnap.val());
      companyName = String(profile.tradeName || profile.legalName || companyName || "empresa atual").trim();
    } catch (_) {}
  }

  const systemPrompt = [
    "Você é Mary, assistente de SST do aplicativo Capacete Inteligente Pro.",
    "Responda sempre em português do Brasil, de forma clara, profissional e curta.",
    "Ajude com segurança do trabalho, NRs, prevenção, organização, treinamento e uso do aplicativo.",
    "Nunca invente dados em tempo real, nomes, alertas, ASO, funcionários ou medições da empresa.",
    "Quando a pergunta exigir dados atuais da empresa, oriente o usuário a usar os comandos locais do app.",
    "Não faça diagnóstico médico nem decisão jurídica; em temas críticos, indique a necessidade de profissional habilitado e fonte oficial.",
    `Contexto: empresa=${companyName || "não informada"}; perfil=${req.appUser.role || "viewer"}.`,
  ].join(" ");

  try {
    const headers = {
      "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "X-Title": "Capacete Inteligente Pro - Mary",
    };
    if (OPENROUTER_SITE_URL) headers["HTTP-Referer"] = OPENROUTER_SITE_URL;

    const upstream = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        temperature: 0.2,
        max_tokens: 700,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: message },
        ],
      }),
      signal: AbortSignal.timeout(30_000),
    });

    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      console.error("Mary OpenRouter:", upstream.status, data?.error?.message || "erro externo");
      return res.status(502).json({ ok: false, error: "A IA online não respondeu agora" });
    }

    const text = String(data?.choices?.[0]?.message?.content || "").trim();
    if (!text) return res.status(502).json({ ok: false, error: "Resposta vazia da IA online" });
    return res.json({ ok: true, text });
  } catch (error) {
    console.error("Mary IA:", error.message);
    return res.status(502).json({ ok: false, error: "Falha temporária na IA online" });
  }
});


async function requirePlatformAdmin(req, res, next) {
  try {
    const header = String(req.header("authorization") || "");
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match) return res.status(401).json({ ok: false, error: "Token ausente" });
    const decoded = await admin.auth().verifyIdToken(match[1], true);
    const [profileSnap, authorizedSnap] = await Promise.all([
      db.ref(`users/${decoded.uid}/profile`).once("value"),
      db.ref(`authorizedUsers/${decoded.uid}`).once("value"),
    ]);
    const profile = asObject(profileSnap.val());
    const enabled = authorizedSnap.val();
    const allowed = enabled === true || (enabled && enabled.enabled === true);
    const ownerEmailMatches = Boolean(APPROVAL_ADMIN_EMAIL) &&
      String(decoded.email || '').trim().toLowerCase() === APPROVAL_ADMIN_EMAIL.toLowerCase();
    if (profile.enabled !== true || profile.platformAdmin !== true || !allowed ||
        !ownerEmailMatches || decoded.email_verified !== true) {
      return res.status(403).json({ ok: false, error: "Acesso restrito à administração geral" });
    }
    req.platformAdmin = { uid: decoded.uid, email: decoded.email || "" };
    return next();
  } catch (error) {
    return res.status(401).json({ ok: false, error: "Sessão administrativa inválida" });
  }
}


async function requireCompanyAdmin(req, res, next) {
  try {
    const header = String(req.header("authorization") || "");
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match) return res.status(401).json({ ok: false, error: "Token ausente" });
    const decoded = await admin.auth().verifyIdToken(match[1], true);
    const [profileSnap, authorizedSnap] = await Promise.all([
      db.ref(`users/${decoded.uid}/profile`).once("value"),
      db.ref(`authorizedUsers/${decoded.uid}`).once("value"),
    ]);
    const profile = asObject(profileSnap.val());
    const rawAllowed = authorizedSnap.val();
    const isAllowed = rawAllowed === true || (rawAllowed && rawAllowed.enabled === true);
    if (profile.enabled !== true || !isAllowed) {
      return res.status(403).json({ ok: false, error: "Conta ainda não autorizada" });
    }
    const platformAdmin = profile.platformAdmin === true &&
      Boolean(APPROVAL_ADMIN_EMAIL) &&
      String(decoded.email || '').toLowerCase() === APPROVAL_ADMIN_EMAIL.toLowerCase() &&
      decoded.email_verified === true;
    const companyId = String(req.body?.companyId || profile.companyId || "").trim();
    const membershipSnap = companyId ? await db.ref(`users/${decoded.uid}/companies/${companyId}`).once("value") : null;
    const companyAdmin = companyRole(profile, membershipSnap?.val(), companyId) === "admin";
    if (!companyId || (!platformAdmin && !companyAdmin)) {
      return res.status(403).json({ ok: false, error: "Acesso restrito ao administrador da empresa" });
    }
    req.companyAdmin = {
      uid: decoded.uid,
      email: decoded.email || "",
      companyId,
      platformAdmin,
    };
    return next();
  } catch (_) {
    return res.status(401).json({ ok: false, error: "Sessão administrativa inválida" });
  }
}

// Bind a new ESP32 to a company/helmet without exposing hardware settings in
// the Capacete Empresa UI. A future Meu Capacete provisioning flow calls this.
app.post('/company/devices/link', adminLimiter, requireCompanyAdmin, async (req, res) => {
  const companyId = req.companyAdmin.companyId;
  const deviceId = String(req.body?.deviceId || '').trim();
  const helmetId = String(req.body?.helmetId || '').trim();
  const employeeId = String(req.body?.employeeId || '').trim();
  const worksiteId = String(req.body?.worksiteId || '').trim();
  if (!/^[a-zA-Z0-9_-]{3,64}$/.test(deviceId) ||
      !/^[a-zA-Z0-9_-]{1,96}$/.test(helmetId) ||
      (employeeId && !/^[a-zA-Z0-9_-]{1,96}$/.test(employeeId)) ||
      (worksiteId && !/^[a-zA-Z0-9_-]{1,96}$/.test(worksiteId))) {
    return res.status(400).json({ ok:false, error:'Identificação de capacete ou dispositivo inválida' });
  }
  if (deviceId === DEFAULT_DEVICE_ID) {
    return res.status(409).json({ok:false,error:'O dispositivo legado default é reservado.'});
  }
  try {
    const helmetSnap = await db.ref(`companies/${companyId}/helmets/${helmetId}`).once('value');
    const helmetItem = asObject(helmetSnap.val());
    if (!helmetSnap.exists()) return res.status(404).json({ok:false,error:'Cadastre o capacete na empresa antes de vincular a placa.'});
    if (helmetItem.deviceId && helmetItem.deviceId !== deviceId) {
      return res.status(409).json({ok:false,error:'Este capacete já está vinculado a outra placa.'});
    }
    const registryRef = db.ref(`deviceRegistry/${deviceId}`);
      const result = await registryRef.transaction(current => {
      if (current && (current.companyId !== companyId ||
          (current.helmetId && current.helmetId !== helmetId))) {
        return;
      }
      return {
        companyId, helmetId, helmetCode:String(helmetItem.code || helmetId),
        employeeId, worksiteId, active:true,
        updatedAt: new Date().toISOString(),
      };
    },undefined,false);
    if (!result.committed) return res.status(409).json({ok:false,error:'Esta placa já está vinculada a outro capacete ou empresa.'});
    await db.ref(`companies/${companyId}/helmets/${helmetId}`).update({
      deviceId, employeeId, worksiteId, active:true,
      updatedAt:new Date().toISOString(),
    });
    contextCache.delete(deviceId);
    return res.status(200).json({ok:true,deviceId,helmetId,companyId});
  } catch (e) {
    console.error('Vinculação de capacete:', e.message);
    return res.status(500).json({ok:false,error:'Não foi possível vincular o dispositivo.'});
  }
});

app.post("/company/users", adminLimiter, requireCompanyAdmin, async (req, res) => {
  let createdUser = false;
  let userRecord = null;
  try {
    const body = asObject(req.body);
    const companyId = req.companyAdmin.companyId;
    const email = String(body.email || "").trim().toLowerCase();
    const displayName = String(body.displayName || "").trim();
    const role = String(body.role || "viewer").trim().toLowerCase();
    const temporaryPassword = String(body.temporaryPassword || "");
    const allowedRoles = new Set(["admin", "sst", "supervisor", "viewer"]);
    if (!email.includes("@")) return res.status(400).json({ ok: false, error: "E-mail inválido" });
    if (!displayName) return res.status(400).json({ ok: false, error: "Nome do usuário obrigatório" });
    if (!allowedRoles.has(role)) return res.status(400).json({ ok: false, error: "Perfil de acesso inválido" });

    try {
      userRecord = await admin.auth().getUserByEmail(email);
      const currentProfileSnap = await db.ref(`users/${userRecord.uid}/profile`).once("value");
      const currentProfile = asObject(currentProfileSnap.val());
      const currentCompanyId = String(currentProfile.companyId || "").trim();
      if (currentCompanyId && currentCompanyId !== companyId) {
        return res.status(409).json({ ok: false, error: "Este e-mail já está vinculado a outra empresa" });
      }
    } catch (error) {
      if (error?.code !== "auth/user-not-found") throw error;
      if (temporaryPassword.length < 8) {
        return res.status(400).json({ ok: false, error: "Informe uma senha temporária com ao menos 8 caracteres" });
      }
      userRecord = await admin.auth().createUser({
        email,
        password: temporaryPassword,
        displayName,
        disabled: false,
      });
      createdUser = true;
    }

    const now = new Date().toISOString();
    const updates = {
      [`users/${userRecord.uid}/profile`]: {
        companyId,
        displayName,
        role,
        enabled: true,
        platformAdmin: false,
        updatedAt: now,
      },
      [`authorizedUsers/${userRecord.uid}`]: {
        enabled: true,
        email,
        companyId,
        updatedAt: now,
      },
      [`companies/${companyId}/members/${userRecord.uid}`]: {
        uid: userRecord.uid,
        email,
        displayName,
        role,
        enabled: true,
        updatedAt: now,
      },
      [`companies/${companyId}/audit/${db.ref().push().key}`]: {
        action: "USER_ACCESS_CREATED",
        actorUid: req.companyAdmin.uid,
        actorEmail: req.companyAdmin.email,
        targetUid: userRecord.uid,
        targetEmail: email,
        role,
        createdAt: now,
      },
    };
    await db.ref().update(updates);
    return res.status(201).json({ ok: true, uid: userRecord.uid, email, role, createdUser });
  } catch (error) {
    if (createdUser && userRecord?.uid) {
      try { await admin.auth().deleteUser(userRecord.uid); } catch (_) {}
    }
    console.error("Criar acesso:", error.message);
    return res.status(500).json({ ok: false, error: "Não foi possível criar o acesso" });
  }
});

app.post("/platform/companies", adminLimiter, requirePlatformAdmin, async (req, res) => {
  try {
    const body = asObject(req.body);
    const cnpj = String(body.cnpj || "").replace(/\D/g, "");
    const legalName = String(body.legalName || "").trim();
    const tradeName = String(body.tradeName || legalName).trim();
    const adminEmail = String(body.adminEmail || "").trim().toLowerCase();
    const adminName = String(body.adminName || "").trim();
    const temporaryPassword = String(body.temporaryPassword || "");
    if (!isValidCnpj(cnpj)) return res.status(400).json({ ok: false, error: "CNPJ inválido" });
    if (!legalName) return res.status(400).json({ ok: false, error: "Razão social obrigatória" });
    if (!adminEmail.includes("@")) return res.status(400).json({ ok: false, error: "E-mail do administrador inválido" });

    const companyId = `cnpj_${cnpj}`;
    const existingCompany = await db.ref(`companies/${companyId}/profile`).once("value");
    if (existingCompany.exists()) {
      return res.status(409).json({ ok: false, error: "Já existe uma empresa cadastrada com este CNPJ" });
    }

    let companyAdmin;
    let createdUser = false;
    try {
      companyAdmin = await admin.auth().getUserByEmail(adminEmail);
      const existingProfileSnap = await db.ref(`users/${companyAdmin.uid}/profile`).once("value");
      const existingProfile = asObject(existingProfileSnap.val());
      const existingCompanyId = String(existingProfile.companyId || "").trim();
      if (existingCompanyId && existingCompanyId !== companyId) {
        return res.status(409).json({ ok: false, error: "O e-mail do administrador já pertence a outra empresa" });
      }
    } catch (error) {
      if (error?.code !== "auth/user-not-found") throw error;
      if (temporaryPassword.length < 8) {
        return res.status(400).json({ ok: false, error: "Informe uma senha temporária com ao menos 8 caracteres" });
      }
      companyAdmin = await admin.auth().createUser({
        email: adminEmail,
        password: temporaryPassword,
        displayName: adminName || tradeName,
        disabled: false,
      });
      createdUser = true;
    }

    const now = new Date().toISOString();
    const updates = {
      [`companies/${companyId}/profile`]: {
        cnpj,
        legalName,
        tradeName,
        email: String(body.email || "").trim(),
        phone: String(body.phone || "").trim(),
        address: String(body.address || "").trim(),
        city: String(body.city || "").trim(),
        state: String(body.state || "").trim().toUpperCase(),
        responsibleName: String(body.responsibleName || adminName || "").trim(),
        sstResponsible: String(body.sstResponsible || "").trim(),
        active: true,
        createdAt: now,
        updatedAt: now,
      },
      [`users/${companyAdmin.uid}/profile`]: {
        companyId,
        displayName: adminName || companyAdmin.displayName || adminEmail,
        role: "admin",
        enabled: true,
        platformAdmin: false,
        createdAt: now,
        updatedAt: now,
      },
      [`authorizedUsers/${companyAdmin.uid}`]: {
        enabled: true,
        email: adminEmail,
        companyId,
        updatedAt: now,
      },
      [`companies/${companyId}/members/${companyAdmin.uid}`]: {
        uid: companyAdmin.uid,
        email: adminEmail,
        displayName: adminName || companyAdmin.displayName || adminEmail,
        role: "admin",
        enabled: true,
        updatedAt: now,
      },
      [`companies/${companyId}/audit/${db.ref().push().key}`]: {
        action: "COMPANY_CREATED",
        actorUid: req.platformAdmin.uid,
        actorEmail: req.platformAdmin.email,
        companyAdminUid: companyAdmin.uid,
        createdAt: now,
      },
    };
    try {
      await db.ref().update(updates);
    } catch (error) {
      if (createdUser) {
        try { await admin.auth().deleteUser(companyAdmin.uid); } catch (_) {}
      }
      throw error;
    }
    return res.status(201).json({
      ok: true,
      companyId,
      adminUid: companyAdmin.uid,
      adminEmail,
      createdUser,
    });
  } catch (error) {
    console.error("Criar empresa:", error.message);
    return res.status(500).json({ ok: false, error: "Não foi possível criar a empresa" });
  }
});

function validAdminToken(req) {
  if (!ENABLE_TEST_ENDPOINTS || !ADMIN_TEST_TOKEN) return false;
  const supplied = String(req.header("x-admin-token") || "");
  const a = Buffer.from(supplied);
  const b = Buffer.from(ADMIN_TEST_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

app.post("/admin/test", adminLimiter, async (req, res) => {
  if (!validAdminToken(req)) return res.status(404).json({ ok: false });
  const reading = parseSensorMessage("capacete/status", req.body?.status, {
    deviceId: req.body?.deviceId || DEFAULT_DEVICE_ID,
    funcionario: req.body?.funcionario || DEFAULT_FUNCIONARIO,
    epi: req.body?.epi || DEFAULT_EPI,
    obra: req.body?.obra || DEFAULT_OBRA,
  });
  if (!reading) return res.status(400).json({ ok: false, error: "Status inválido" });
  await enqueue(() => processReading(reading));
  return res.json({ ok: true, convertido: reading.status, deviceId: reading.deviceId });
});

app.post("/admin/reset", adminLimiter, async (req, res) => {
  if (!validAdminToken(req)) return res.status(404).json({ ok: false });
  const deviceId = normalizeDeviceId(req.body?.deviceId || DEFAULT_DEVICE_ID);
  deviceCache.delete(deviceId);
  contextCache.delete(deviceId);
  await db.ref(`devices/${deviceId}/estadoAberto`).remove();
  return res.json({ ok: true, deviceId });
});

const server = app.listen(PORT, () => {
  console.log(`Backend Capacete Inteligente v3.5 online na porta ${PORT}.`);
  console.log("Regra: DETECTOU=ATIVO | LIVRE=INATIVO; jornada pode resultar em PAUSA/FORA_JORNADA.");
  console.log(`Endpoints administrativos: ${ENABLE_TEST_ENDPOINTS ? "habilitados e protegidos" : "desativados"}.`);
});

async function shutdown(signal) {
  console.log(`${signal}: encerrando de forma segura.`);
  clearInterval(scheduleTimer);
  client.end(true);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
