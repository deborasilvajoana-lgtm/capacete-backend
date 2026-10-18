"use strict";

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function parseClock(value) {
  const match = String(value || "").trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }
  return hour * 60 + minute;
}

function zonedParts(date, timeZone = "America/Sao_Paulo") {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(date).filter((p) => p.type !== "literal").map((p) => [p.type, p.value]),
  );
  const weekday = String(parts.weekday || "").slice(0, 3).toLowerCase();
  let hour = Number(parts.hour || 0);
  // Alguns runtimes Intl podem representar meia-noite como 24:00.
  if (hour === 24) hour = 0;
  return {
    weekday: WEEKDAYS.includes(weekday) ? weekday : "mon",
    minutes: hour * 60 + Number(parts.minute || 0),
  };
}

function previousWeekday(day) {
  const index = WEEKDAYS.indexOf(day);
  return WEEKDAYS[(index + 6) % 7];
}

function normalizeBreaks(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return Object.values(value);
  return [];
}

function inRange(minutes, start, end) {
  if (start === null || end === null) return false;
  if (start === end) return false;
  if (end > start) return minutes >= start && minutes < end;
  return minutes >= start || minutes < end;
}

function breakMatch(dayConfig, minutes, isPreviousOvernight = false) {
  for (const item of normalizeBreaks(dayConfig?.breaks)) {
    const start = parseClock(item?.start);
    const end = parseClock(item?.end);
    if (start === null || end === null) continue;

    // Para um turno originado no dia anterior, neste dia só interessa a parte
    // pós-meia-noite de pausas que também cruzam a meia-noite.
    if (isPreviousOvernight && end <= start) {
      if (minutes < end) {
        return String(item?.label || "Pausa programada").trim() || "Pausa programada";
      }
      continue;
    }
    if (isPreviousOvernight && start >= parseClock(dayConfig.end)) continue;

    if (inRange(minutes, start, end)) {
      return String(item?.label || "Pausa programada").trim() || "Pausa programada";
    }
  }
  return null;
}

function evaluateSchedule(schedule, date = new Date()) {
  // Sem escala cadastrada, preserva o comportamento antigo e monitora normalmente.
  if (!schedule || typeof schedule !== "object" || !schedule.days || typeof schedule.days !== "object") {
    return { status: "MONITORAR", reason: "Sem jornada cadastrada", timezone: "America/Sao_Paulo" };
  }

  const overtimeUntil = new Date(String(schedule.overtimeUntil || "")).getTime();
  const overtime = Number.isFinite(overtimeUntil) && date.getTime() < overtimeUntil;

  const timezone = String(schedule.timezone || "America/Sao_Paulo").trim() || "America/Sao_Paulo";
  let local;
  try {
    local = zonedParts(date, timezone);
  } catch (_) {
    local = zonedParts(date, "America/Sao_Paulo");
  }

  const today = schedule.days[local.weekday] || {};
  const previousKey = previousWeekday(local.weekday);
  const previous = schedule.days[previousKey] || {};

  const todayStart = parseClock(today.start);
  const todayEnd = parseClock(today.end);
  const previousStart = parseClock(previous.start);
  const previousEnd = parseClock(previous.end);

  let activeConfig = null;
  let previousOvernight = false;

  if (today.enabled === true && todayStart !== null && todayEnd !== null) {
    if (todayEnd > todayStart) {
      if (local.minutes >= todayStart && local.minutes < todayEnd) activeConfig = today;
    } else if (todayEnd < todayStart) {
      if (local.minutes >= todayStart) activeConfig = today;
    }
  }

  if (!activeConfig && previous.enabled === true && previousStart !== null && previousEnd !== null && previousEnd < previousStart) {
    if (local.minutes < previousEnd) {
      activeConfig = previous;
      previousOvernight = true;
    }
  }

  if (!activeConfig && overtime) { activeConfig = today.enabled === true ? today : previous; }
  if (!activeConfig) {
    return { status: "FORA_JORNADA", reason: "Fora do expediente", timezone };
  }

  const pauseLabel = breakMatch(activeConfig, local.minutes, previousOvernight);
  if (pauseLabel) {
    return { status: "PAUSA", reason: pauseLabel, timezone };
  }

  return { status: "MONITORAR", reason: overtime ? "Hora extra autorizada" : "Expediente ativo", timezone };
}

function effectiveStatus(sensorStatus, scheduleResult) {
  if (scheduleResult?.status === "PAUSA") return "PAUSA";
  if (scheduleResult?.status === "FORA_JORNADA") return "FORA_JORNADA";
  return sensorStatus === "INATIVO" ? "INATIVO" : "ATIVO";
}

module.exports = {
  parseClock,
  zonedParts,
  evaluateSchedule,
  effectiveStatus,
};
