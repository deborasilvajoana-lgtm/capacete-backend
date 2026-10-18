"use strict";

function converterStatus(valor) {
  const estado = String(valor ?? "").trim().toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (!estado) return null;
  if (/NAO[ _]DETECTOU/.test(estado)) return "INATIVO";
  if (estado.includes("DETECTOU")) return "ATIVO";
  if (estado.includes("LIVRE")) return "INATIVO";
  if (["ATIVO", "1", "TRUE", "ON"].includes(estado)) return "ATIVO";
  if (["INATIVO", "0", "FALSE", "OFF"].includes(estado)) return "INATIVO";
  return null;
}

function cleanText(value, fallback, max = 120) {
  const text = String(value ?? "").trim();
  return (text || fallback).slice(0, max);
}

function normalizeDeviceId(value, fallback = "default") {
  const raw = String(value ?? "").trim();
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-");
  return (cleaned || fallback).slice(0, 64);
}

function deviceIdFromTopic(topic) {
  const match = String(topic ?? "").match(/^capacete\/([^/]+)\/status$/i);
  return match ? normalizeDeviceId(match[1]) : null;
}

function parseSensorMessage(topic, payload, defaults = {}) {
  const text = String(payload ?? "").trim();
  let body = null;
  if (text.startsWith("{") && text.endsWith("}")) {
    try {
      body = JSON.parse(text);
    } catch (_) {
      body = null;
    }
  }

  const rawValue = body
    ? body.status ?? body.estado ?? body.sensor ?? body.raw ?? body.valor
    : text;
  const status = converterStatus(rawValue);
  if (!status) return null;

  const raw = String(rawValue ?? "").trim().toUpperCase();
  const topicDeviceId = deviceIdFromTopic(topic);
  const claimedDeviceId = body?.deviceId ?? body?.dispositivo;
  // Um pacote em capacete/ABC/status não pode se passar pelo capacete XYZ.
  if (topicDeviceId && claimedDeviceId != null &&
      normalizeDeviceId(claimedDeviceId) !== topicDeviceId) return null;
  const deviceId = topicDeviceId || normalizeDeviceId(
    claimedDeviceId,
    defaults.deviceId || "default",
  );

  return {
    deviceId,
    status,
    raw,
    funcionario: cleanText(
      body?.funcionario ?? body?.worker,
      defaults.funcionario || "Funcionário não identificado",
    ),
    epi: cleanText(body?.epi ?? body?.helmet, defaults.epi || "Capacete"),
    obra: cleanText(body?.obra ?? body?.worksite, defaults.obra || "", 160),
  };
}

module.exports = {
  converterStatus,
  parseSensorMessage,
  normalizeDeviceId,
};
