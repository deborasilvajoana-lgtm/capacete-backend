"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { converterStatus, parseSensorMessage } = require("../lib/status");

test("DETECTOU vira ATIVO", () => {
  assert.equal(converterStatus("DETECTOU"), "ATIVO");
});

test("LIVRE vira INATIVO", () => {
  assert.equal(converterStatus("LIVRE"), "INATIVO");
});

test("valor desconhecido não vira falso alerta", () => {
  assert.equal(converterStatus("QUALQUER_COISA"), null);
});

test("payload JSON aceita múltiplos capacetes", () => {
  const reading = parseSensorMessage(
    "capacete/cap-02/status",
    JSON.stringify({ status: "DETECTOU", funcionario: "Maria", epi: "Capacete 02" }),
    { deviceId: "default", funcionario: "Padrão", epi: "Capacete" },
  );
  assert.equal(reading.deviceId, "cap-02");
  assert.equal(reading.status, "ATIVO");
  assert.equal(reading.funcionario, "Maria");
});

test('negação de DETECTOU não vira capacete ativo',()=>{
 for(const text of ['NÃO DETECTOU','NAO_DETECTOU','NAO DETECTOU'])assert.equal(converterStatus(text),'INATIVO');
});

test('topic de novo capacete não pode ser sobreposto pelo JSON',()=>{
 const reading=parseSensorMessage('capacete/cap-02/status',JSON.stringify({status:'DETECTOU',deviceId:'cap-03'}));
 assert.equal(reading,null);
});
test('tópico legado funciona sem id',()=>{
 const reading=parseSensorMessage('capacete/status','LIVRE',{deviceId:'default'});
 assert.equal(reading.deviceId,'default');
 assert.equal(reading.status,'INATIVO');
});
