'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {advanceAudit,projectAudit}=require('../lib/helmet_audit');
const m=minutes=>minutes*60000;
function move(state,minutes,sensor,schedule='MONITORAR',extras={}){
 return advanceAudit(state,{nowMs:m(minutes),sensorStatus:sensor,scheduleStatus:schedule,
  scheduleReason:schedule==='PAUSA'?'Almoco':'',offlineAfterMs:m(2),...extras});
}
test('Leitura inicial EM_USO nao gera retirada falsa',()=>{
 const a=move(null,0,'ATIVO');assert.equal(a.state.atual.fisico,'EM_USO');
 assert.equal(a.state.resumo.quantidadeRetiradas,0);
 assert.equal(a.events.length,0);
});
test('Retirada apos uso: contagem correta e tempo de uso independente',()=>{
 let v=move(null,0,'ATIVO').state;
 v=move(v,2,'ATIVO').state;
 v=move(v,4,'ATIVO').state;
 const r=move(v,5,'INATIVO');
 assert.equal(r.events.length,1);assert.equal(r.events[0].estadoFisico,'EM_USO');
 assert.equal(r.events[0].duracaoMs,m(5));assert.equal(r.state.resumo.tempoUsoMs,m(5));
 assert.equal(r.state.resumo.quantidadeRetiradas,1);
 const v2=move(r.state,6.5,'INATIVO').state;
 const r2=move(v2,8,'ATIVO');
 assert.equal(r2.events[0].estadoFisico,'RETIRADO');
 assert.equal(r2.state.resumo.tempoRetiradoMs,m(3));
 assert.equal(r2.state.resumo.tempoUsoMs,m(5));
 assert.equal(r2.state.resumo.quantidadeRetiradas,1);
});
test('Pausa reconhece retirada fisica mas nao a contabiliza como irregularidade',()=>{
 let v=move(null,0,'ATIVO').state;
 // tick na virada do almoco (sem fingir leitura no segundo da virada)
 v=advanceAudit(v,{nowMs:m(1),sensorStatus:null,scheduleStatus:'PAUSA',scheduleReason:'Almoco',offlineAfterMs:m(2),observed:false}).state;
 assert.equal(v.atual.jornada,'PAUSA_AUTORIZADA');
 assert.equal(v.atual.ultimaLeituraMs,0); // ultimo pacote do ESP32 foi em t=0
 const r=move(v,1.5,'INATIVO','PAUSA');
 assert.equal(r.state.resumo.quantidadeRetiradas,1);
 assert.equal(r.state.atual.jornada,'PAUSA_AUTORIZADA');
 const closed=move(r.state,2,'ATIVO','PAUSA');
 assert.equal(closed.state.resumo.tempoRetiradoNaPausaMs,m(.5));
 assert.equal(closed.state.resumo.tempoRetiradoNoTrabalhoMs,0);
 assert.equal(closed.state.resumo.tempoRetiradoMs,m(.5));
 assert.equal(closed.state.resumo.quantidadeRetiradas,1);
});
test('Fora da jornada tambem separa os tempos sem misturar uso e retirada',()=>{
 let v=move(null,0,'INATIVO','FORA_JORNADA').state;
 v=move(v,1,'ATIVO','FORA_JORNADA').state;
 assert.equal(v.resumo.tempoRetiradoForaJornadaMs,m(1));
 assert.equal(v.resumo.quantidadeRetiradas,0); // iniciou retirado, desconhecido quando retirou
});
test('Leituras repetidas de INATIVO nao contam novas retiradas',()=>{
 let v=move(null,0,'ATIVO').state;
 v=move(v,1,'INATIVO').state;
 for(const t of [1.2,1.3,1.4]){const r=move(v,t,'INATIVO');assert.equal(r.events.length,0);v=r.state;}
 assert.equal(v.resumo.quantidadeRetiradas,1);
});
test('Lacuna sem comunicacao nao vira retirada e nunca conta periodo offline como uso',()=>{
 let v=move(null,0,'ATIVO').state;
 v=move(v,1,'ATIVO').state;
 const tick=advanceAudit(v,{nowMs:m(5),sensorStatus:null,offlineAfterMs:m(2),observed:false});
 assert.equal(tick.state.atual.fisico,'SEM_COMUNICACAO');
 assert.equal(tick.state.resumo.tempoUsoMs,m(1));
 assert.equal(tick.events[0].fimISO,new Date(m(1)).toISOString());
 const recovered=move(tick.state,6,'INATIVO');
 assert.equal(recovered.state.resumo.tempoSemComunicacaoMs,m(5));
 assert.equal(recovered.state.resumo.quantidadeRetiradas,0); // Nao se sabe quando retirou
 assert.equal(recovered.state.resumo.tempoRetiradoMs,0);
});
test('Pausa nao cria leitura falsa se o sensor estiver offline',()=>{
 let v=move(null,0,'ATIVO').state;
 v=advanceAudit(v,{nowMs:m(3),sensorStatus:null,offlineAfterMs:m(2),observed:false}).state;
 const r=advanceAudit(v,{nowMs:m(4),sensorStatus:null,scheduleStatus:'PAUSA',observed:false,offlineAfterMs:m(2)});
 assert.equal(r.changed,false);assert.equal(r.state.atual.fisico,'SEM_COMUNICACAO');
});
test('Projecao e conservadora: uso parado nao continua contando como uso apos timeout',()=>{
 let v=move(null,0,'ATIVO').state;
 v=move(v,1,'ATIVO').state;
 const snap=projectAudit(v,m(10),m(2));
 assert.equal(snap.estadoFisico,'SEM_COMUNICACAO');
 assert.equal(snap.tempoUsoMs,m(1));
 assert.equal(snap.tempoSemComunicacaoMs,m(9));
 assert.equal(snap.alertaRetirada,false);
});
test('Projecao de retirada em pausa sem alerta indevido',()=>{
 let v=move(null,0,'INATIVO','PAUSA').state;
 let p=projectAudit(v,m(1),m(2));
 assert.equal(p.tempoRetiradoMs,m(1));
 assert.equal(p.tempoRetiradoNaPausaMs,m(1));
 assert.equal(p.alertaRetirada,false);
 assert.equal(p.classificacaoConfirmada,'RETIRADA_EM_PAUSA');
});
test('Nao aceita status desconhecido, relogio anterior, ou timestamps ruins',()=>{
 assert.throws(()=>advanceAudit(null,{nowMs:-1,sensorStatus:'ATIVO'}),/Timestamp/);
 assert.throws(()=>advanceAudit(null,{nowMs:1,sensorStatus:'INDEFINIDO'}),/Sensor/);
 const v=move(null,5,'ATIVO').state;
 const r=move(v,4,'INATIVO');
 assert.equal(r.changed,false);assert.equal(r.state.atual.fisico,'EM_USO');
});
test('Sessoes separadas nao compartilham contadores ou estado',()=>{
 let a=move(null,0,'ATIVO').state,b=move(null,0,'INATIVO').state;
 a=move(a,1,'INATIVO').state;
 b=move(b,1,'INATIVO').state;
 assert.equal(a.resumo.quantidadeRetiradas,1);
 assert.equal(b.resumo.quantidadeRetiradas,0);
 assert.equal(b.resumo.tempoUsoMs,0);
});
const {parseSensorMessage}=require('../lib/status');
test('200 capacetes: cada equipamento tem contagem e historico independente',()=>{
 const states=new Map();
 for(let id=1;id<=200;id++){
  const code=`CAP-${String(id).padStart(3,'0')}`;
  const first=parseSensorMessage(`capacete/${code}/status`,JSON.stringify({status:'DETECTOU',deviceId:code}));
  assert.equal(first.deviceId,code);
  states.set(code,move(null,0,first.status).state);
 }
 for(let id=1;id<=200;id++){
  const code=`CAP-${String(id).padStart(3,'0')}`;
  const sensor=id%2===0?'INATIVO':'ATIVO';
  const reading=parseSensorMessage(`capacete/${code}/status`,JSON.stringify({status:sensor,deviceId:code}));
  const updated=move(states.get(code),1,reading.status).state;
  states.set(code,updated);
 }
 assert.equal(states.size,200);
 assert.equal([...states.values()].filter(v=>v.resumo.quantidadeRetiradas===1).length,100);
 assert.equal([...states.values()].filter(v=>v.resumo.quantidadeRetiradas===0).length,100);
 for(const v of states.values())assert.equal(projectAudit(v,m(1),m(2)).tempoUsoMs,m(1));
});

test('Mudanca de jornada sem leitura seguida de perda de sinal nunca inverte horarios',()=>{
 let state=move(null,0,'ATIVO').state;
 // pausa iniciada aos 60s, ultima leitura fisica foi aos 0s
 state=advanceAudit(state,{nowMs:m(1),sensorStatus:null,scheduleStatus:'PAUSA',scheduleReason:'Almoco',offlineAfterMs:m(2),observed:false}).state;
 assert.equal(state.atual.inicioMs,m(1));
 const gap=advanceAudit(state,{nowMs:m(4),sensorStatus:null,scheduleStatus:'PAUSA',offlineAfterMs:m(2),observed:false});
 assert.equal(gap.state.atual.fisico,'SEM_COMUNICACAO');
 assert.ok(gap.events.every(e=>Date.parse(e.fimISO)>=Date.parse(e.inicioISO)));
 assert.equal(gap.state.resumo.tempoUsoMs,m(1));
 assert.equal(gap.state.resumo.quantidadeRetiradas,0);
 assert.equal(projectAudit(gap.state,m(4),m(2)).tempoSemComunicacaoMs,m(3));
});

const {makeAuditEventId}=require('../lib/helmet_audit');
test('IDs de eventos ordenam por data e hora de fim, nao por hash',()=>{
 const events=[
  {inicioISO:'2026-10-22T10:00:00.000Z',fimISO:'2026-10-22T10:05:00.000Z',estadoFisico:'RETIRADO',contextoJornada:'PAUSA_AUTORIZADA'},
  {inicioISO:'2026-10-22T09:00:00.000Z',fimISO:'2026-10-22T09:25:00.000Z',estadoFisico:'EM_USO',contextoJornada:'TRABALHO'},
  {inicioISO:'2026-10-22T11:00:00.000Z',fimISO:'2026-10-22T11:05:00.000Z',estadoFisico:'EM_USO',contextoJornada:'TRABALHO'},
 ];
 const ids=events.map(e=>makeAuditEventId('default',e));
 assert.deepEqual([...ids].sort(),[ids[1],ids[0],ids[2]]);
 assert.equal(makeAuditEventId('default',events[0]),ids[0]);
 assert.match(ids[0],/^ev_\d{13}_[a-f0-9]{16}$/);
 assert.notEqual(makeAuditEventId('outro',events[0]),ids[0]);
});
test('Selecao dos 50 registros mais recentes usa ordenacao cronologica de chave',()=>{
 const created=Array.from({length:55},(_,i)=>{
  const d=new Date(Date.UTC(2026,9,22,0,i));
  return {inicioISO:new Date(+d-20000).toISOString(),fimISO:d.toISOString(),estadoFisico:'EM_USO',contextoJornada:'TRABALHO'};
 });
 const keys=created.map(e=>makeAuditEventId('default',e));
 const recent=[...keys].sort().slice(-50);
 assert.deepEqual(recent,keys.slice(5));
});
