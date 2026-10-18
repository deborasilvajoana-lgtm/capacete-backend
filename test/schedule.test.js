"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { evaluateSchedule, effectiveStatus } = require("../lib/schedule");

const schedule = {
  timezone: "America/Sao_Paulo",
  days: {
    mon: { enabled: true, start: "07:00", end: "17:00", breaks: [{ label: "Almoço", start: "12:00", end: "13:00" }] },
    tue: { enabled: true, start: "07:00", end: "17:00", breaks: [{ label: "Almoço", start: "12:00", end: "13:00" }] },
    wed: { enabled: true, start: "07:00", end: "17:00", breaks: [] },
    thu: { enabled: true, start: "07:00", end: "17:00", breaks: [] },
    fri: { enabled: true, start: "07:00", end: "17:00", breaks: [] },
    sat: { enabled: false, start: "", end: "", breaks: [] },
    sun: { enabled: false, start: "", end: "", breaks: [] },
  },
};

test("expediente ativo mantém leitura do sensor", () => {
  const result = evaluateSchedule(schedule, new Date("2026-09-14T13:30:00Z")); // 10:30 BRT, segunda
  assert.equal(result.status, "MONITORAR");
  assert.equal(effectiveStatus("INATIVO", result), "INATIVO");
});

test("almoço vira PAUSA e não gera INATIVO", () => {
  const result = evaluateSchedule(schedule, new Date("2026-09-14T15:30:00Z")); // 12:30 BRT
  assert.equal(result.status, "PAUSA");
  assert.equal(effectiveStatus("INATIVO", result), "PAUSA");
});

test("fora do expediente vira FORA_JORNADA", () => {
  const result = evaluateSchedule(schedule, new Date("2026-09-14T22:00:00Z")); // 19:00 BRT
  assert.equal(result.status, "FORA_JORNADA");
  assert.equal(effectiveStatus("INATIVO", result), "FORA_JORNADA");
});

test("sem escala cadastrada preserva monitoramento antigo", () => {
  const result = evaluateSchedule(null, new Date());
  assert.equal(result.status, "MONITORAR");
  assert.equal(effectiveStatus("INATIVO", result), "INATIVO");
});


test("pausa adicional programada também vira PAUSA", () => {
  const withExtraPause = structuredClone(schedule);
  withExtraPause.days.mon.breaks.push({ label: "Pausa da tarde", start: "15:30", end: "15:45" });
  const result = evaluateSchedule(withExtraPause, new Date("2026-09-14T18:35:00Z")); // 15:35 BRT
  assert.equal(result.status, "PAUSA");
  assert.equal(result.reason, "Pausa da tarde");
  assert.equal(effectiveStatus("INATIVO", result), "PAUSA");
});

test("turno noturno permanece ativo depois da meia-noite", () => {
  const night = structuredClone(schedule);
  night.days.mon = { enabled: true, start: "22:00", end: "06:00", breaks: [{ label: "Pausa noturna", start: "02:00", end: "02:20" }] };
  night.days.tue = { enabled: false, start: "", end: "", breaks: [] };
  const result = evaluateSchedule(night, new Date("2026-09-15T04:30:00Z")); // 01:30 BRT, terça, turno de segunda
  assert.equal(result.status, "MONITORAR");
  assert.equal(effectiveStatus("INATIVO", result), "INATIVO");
});

test("turno noturno encerra corretamente no horário final", () => {
  const night = structuredClone(schedule);
  night.days.mon = { enabled: true, start: "22:00", end: "06:00", breaks: [] };
  night.days.tue = { enabled: false, start: "", end: "", breaks: [] };
  const result = evaluateSchedule(night, new Date("2026-09-15T09:01:00Z")); // 06:01 BRT, terça
  assert.equal(result.status, "FORA_JORNADA");
});


test("hora extra autorizada prolonga o monitoramento apos a jornada", () => {
  const overtime = structuredClone(schedule);
  overtime.overtimeUntil = "2026-09-14T22:30:00Z"; // 19:30 BRT
  const result = evaluateSchedule(overtime, new Date("2026-09-14T21:30:00Z")); // 18:30 BRT
  assert.equal(result.status, "MONITORAR");
  assert.equal(result.reason, "Hora extra autorizada");
  assert.equal(effectiveStatus("INATIVO", result), "INATIVO");
});

test('pausa depois da meia-noite pertence ao turno anterior',()=>{
 const night=structuredClone(schedule);
 night.days.mon={enabled:true,start:'22:00',end:'06:00',breaks:[{label:'Pausa noturna',start:'02:00',end:'02:20'}]};
 night.days.tue={enabled:false,start:'',end:'',breaks:[]};
 const result=evaluateSchedule(night,new Date('2026-09-15T05:10:00Z'));
 assert.equal(result.status,'PAUSA');assert.equal(result.reason,'Pausa noturna');
});
test('hora extra não cancela pausa programada',()=>{
 const extra=structuredClone(schedule);extra.overtimeUntil='2026-09-14T22:30:00Z';
 assert.equal(evaluateSchedule(extra,new Date('2026-09-14T15:30:00Z')).status,'PAUSA');
});
