"use strict";
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {advanceAudit,projectAudit}=require('../lib/helmet_audit');
const tick=(state,nowMs,sensorStatus,period='MONITORAR',extra={})=>
  advanceAudit(state,{nowMs,sensorStatus,scheduleStatus:period,offlineAfterMs:120000,
    debounceMs:3000,observed:sensorStatus!==null,...extra});

test('Pico LIVRE com retorno rapido nao registra retirada',()=>{
  let a=tick(null,0,'ATIVO').state;
  a=tick(a,1000,'ATIVO').state;
  const pending=tick(a,2000,'INATIVO');
  assert.equal(pending.reason,'ESTABILIDADE_PENDENTE');
  assert.equal(pending.state.atual.fisico,'EM_USO');
  assert.equal(pending.state.resumo.quantidadeRetiradas,0);
  const restored=tick(pending.state,2500,'ATIVO');
  assert.equal(restored.state.atual.fisico,'EM_USO');
  assert.equal(restored.state.atual.estabilidadePendente,undefined);
  assert.equal(restored.events.length,0);
  assert.equal(restored.state.resumo.quantidadeRetiradas,0);
});

test('LIVRE repetido apos 3 segundos registra retirada unica no primeiro sinal',()=>{
  let a=tick(null,0,'ATIVO').state;
  a=tick(a,5000,'ATIVO').state;
  a=tick(a,6000,'INATIVO').state;
  assert.equal(tick(a,7500,'INATIVO').reason,'AGUARDANDO_ESTABILIDADE');
  const confirmed=tick(a,10000,'INATIVO');
  assert.equal(confirmed.state.resumo.quantidadeRetiradas,1);
  assert.equal(confirmed.state.atual.fisico,'RETIRADO');
  assert.equal(confirmed.state.atual.inicioMs,6000);
  assert.equal(confirmed.state.resumo.tempoUsoMs,6000);
  assert.equal(confirmed.state.resumo.tempoRetiradoMs,0);
  const view=projectAudit(confirmed.state,10000,120000);
  assert.equal(view.tempoRetiradoMs,4000);
  assert.equal(view.tempoUsoMs,6000);
  a=tick(confirmed.state,15000,'INATIVO').state;
  assert.equal(a.resumo.quantidadeRetiradas,1);
});

test('Retorno a EM_USO tambem precisa permanecer estavel por 3s',()=>{
  let a=tick(null,0,'ATIVO').state;
  a=tick(a,5000,'INATIVO').state;
  a=tick(a,9000,'INATIVO').state;
  assert.equal(a.resumo.quantidadeRetiradas,1);
  a=tick(a,10000,'ATIVO').state;
  assert.equal(a.atual.fisico,'RETIRADO');
  a=tick(a,11000,'INATIVO').state;
  assert.equal(a.atual.fisico,'RETIRADO');
  a=tick(a,15000,'ATIVO').state;
  const v=tick(a,19000,'ATIVO');
  assert.equal(v.state.atual.fisico,'EM_USO');
  assert.equal(v.state.resumo.quantidadeRetiradas,1);
  assert.equal(v.state.resumo.tempoRetiradoMs,10000);
  assert.equal(v.state.resumo.tempoUsoMs,5000);
});

test('Retirada confirmada na pausa preserva tempos separados',()=>{
  let a=tick(null,0,'ATIVO','PAUSA').state;
  a=tick(a,6000,'INATIVO','PAUSA').state;
  a=tick(a,10000,'INATIVO','PAUSA').state;
  a=tick(a,15000,'INATIVO','PAUSA').state;
  assert.equal(a.resumo.quantidadeRetiradas,1);
  assert.equal(projectAudit(a,15000).alertaRetirada,false);
  a=tick(a,16000,'ATIVO','PAUSA').state;
  a=tick(a,20000,'ATIVO','PAUSA').state;
  assert.equal(a.resumo.tempoRetiradoNaPausaMs,10000);
  assert.equal(a.resumo.tempoRetiradoNoTrabalhoMs,0);
  assert.equal(a.resumo.tempoUsoMs,6000);
});

test('Sem nova leitura candidata, intervalo vencido nao vira retirada',()=>{
  let a=tick(null,0,'ATIVO').state;
  a=tick(a,1000,'INATIVO').state;
  const offline=tick(a,125000,null);
  assert.equal(offline.state.atual.fisico,'SEM_COMUNICACAO');
  assert.equal(offline.state.resumo.quantidadeRetiradas,0);
  assert.equal(offline.state.resumo.tempoRetiradoMs,0);
  assert.equal(offline.state.resumo.tempoUsoMs,0);
});

test('Primeira leitura INATIVO e retomada apos offline nao inventam retirada',()=>{
  let a=tick(null,0,'INATIVO').state;
  assert.equal(a.resumo.quantidadeRetiradas,0);
  a=tick(a,2000,'ATIVO').state;
  a=tick(a,6000,'ATIVO').state;
  a=tick(a,130000,null).state;
  assert.equal(a.atual.fisico,'SEM_COMUNICACAO');
  a=tick(a,131000,'INATIVO').state;
  assert.equal(a.resumo.quantidadeRetiradas,0);
});

test('Debounce nao altera comportamento antigo quando desligado',()=>{
  let a=advanceAudit(null,{nowMs:0,sensorStatus:'ATIVO'}).state;
  a=advanceAudit(a,{nowMs:1000,sensorStatus:'INATIVO'}).state;
  assert.equal(a.resumo.quantidadeRetiradas,1);
  assert.throws(()=>tick(a,2000,'ATIVO','MONITORAR',{debounceMs:-1}),/Filtro/);
});

test('Afastamentos distintos nao contam o mesmo pico como duas retiradas',()=>{
  let a=tick(null,0,'ATIVO').state;
  a=tick(a,2000,'INATIVO').state;
  a=tick(a,2300,'ATIVO').state;
  a=tick(a,3000,'INATIVO').state;
  a=tick(a,7000,'INATIVO').state;
  a=tick(a,8000,'INATIVO').state;
  assert.equal(a.resumo.quantidadeRetiradas,1);
});
