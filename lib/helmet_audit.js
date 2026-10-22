"use strict";
/**
 * Auditoria independente: presença física do capacete, classificação da jornada
 * e ausência de telemetria são DIMENSÕES DIFERENTES.
 * Estado só deve ser atualizado pelo backend autenticado que recebe MQTT.
 * Data/hora é do servidor; não deduz o motivo humano de uma retirada.
 */
const PHYSICAL = Object.freeze({ WORN: "EM_USO", REMOVED: "RETIRADO", OFFLINE: "SEM_COMUNICACAO" });
const PERIOD = Object.freeze({ WORK: "TRABALHO", BREAK: "PAUSA_AUTORIZADA", OUT: "FORA_JORNADA" });
const COUNTER = Object.freeze({
  wornMs: "tempoUsoMs", removedMs: "tempoRetiradoMs", offlineMs: "tempoSemComunicacaoMs",
  breakMs: "tempoPausaMs", removedAtBreakMs: "tempoRetiradoNaPausaMs",
  removedAtWorkMs: "tempoRetiradoNoTrabalhoMs", removedOutsideMs: "tempoRetiradoForaJornadaMs",
});
const EMPTY = Object.freeze({
  tempoUsoMs:0, tempoRetiradoMs:0, tempoSemComunicacaoMs:0, tempoPausaMs:0,
  tempoRetiradoNaPausaMs:0, tempoRetiradoNoTrabalhoMs:0, tempoRetiradoForaJornadaMs:0,
  quantidadeRetiradas:0, totalIntervalos:0,
});
function validTime(ms) {return Number.isSafeInteger(ms) && ms >= 0;}
function physicalFromSensor(sensor){
  if(sensor==="ATIVO")return PHYSICAL.WORN;
  if(sensor==="INATIVO")return PHYSICAL.REMOVED;
  throw Error("Status fisico invalido. Nenhum registro deve ser criado.");
}
function periodFromSchedule(schedule){
  if(schedule?.status==="PAUSA")return PERIOD.BREAK;
  if(schedule?.status==="FORA_JORNADA")return PERIOD.OUT;
  return PERIOD.WORK;
}
function safeSummary(value){
  const next={...EMPTY};
  for(const field of Object.keys(next)){
    const input=Number(value?.[field]);
    if(Number.isSafeInteger(input)&&input>=0)next[field]=input;
  }
  return next;
}
function makeCurrent(physical,period,nowMs,reason="",lastReadingMs=nowMs){
  return {fisico:physical,jornada:period,inicioMs:nowMs,ultimaLeituraMs:lastReadingMs,
    motivoPausa:period===PERIOD.BREAK?String(reason||"Pausa autorizada").slice(0,120):""};
}
function ensureState(value){
  if(!value||typeof value!=="object")return null;
  const a=value.atual;
  if(!a||![...Object.values(PHYSICAL)].includes(a.fisico) ||
   !Object.values(PERIOD).includes(a.jornada) ||
   !validTime(a.inicioMs)||!validTime(a.ultimaLeituraMs)){return null;}
  return {atual:{...a},resumo:safeSummary(value.resumo)};
}
function formatEvent(start,end,segment,reason="TRANSICAO"){
  const duration=Math.max(0,end-start);
  return {
    inicioISO:new Date(start).toISOString(),fimISO:new Date(end).toISOString(),
    duracaoMs:duration,duracaoSegundos:Math.floor(duration/1000),
    estadoFisico:segment.fisico,contextoJornada:segment.jornada,
    pausa:segment.motivoPausa||"",motivoEncerramento:reason,
    origem:"MOTOR_DE_AUDITORIA",relogio:"SERVIDOR",
  };
}
function accumulate(summary,segment,duration){
  const r=safeSummary(summary);
  if(segment.fisico===PHYSICAL.WORN)r.tempoUsoMs+=duration;
  if(segment.fisico===PHYSICAL.REMOVED){
    r.tempoRetiradoMs+=duration;
    if(segment.jornada===PERIOD.BREAK)r.tempoRetiradoNaPausaMs+=duration;
    else if(segment.jornada===PERIOD.OUT)r.tempoRetiradoForaJornadaMs+=duration;
    else r.tempoRetiradoNoTrabalhoMs+=duration;
  }
  if(segment.fisico===PHYSICAL.OFFLINE)r.tempoSemComunicacaoMs+=duration;
  if(segment.jornada===PERIOD.BREAK && segment.fisico!==PHYSICAL.OFFLINE)r.tempoPausaMs+=duration;
  r.totalIntervalos+=1;
  return r;
}
function closeSegment(state,endMs,events,reason){
  const a=state.atual;
  const duration=Math.max(0,endMs-a.inicioMs);
  state.resumo=accumulate(state.resumo,a,duration);
  events.push(formatEvent(a.inicioMs,endMs,a,reason));
}
/** tick = temporal stale status without a new sensor message; NOT a removal */
function advanceAudit(value,{nowMs,sensorStatus=null,scheduleStatus="MONITORAR",scheduleReason="",offlineAfterMs=120000,observed=true}={}){
  if(!validTime(nowMs))throw Error("Timestamp invalido");
  if(sensorStatus!==null&&!['ATIVO','INATIVO'].includes(sensorStatus))throw Error('Sensor desconhecido');
  if(!Number.isSafeInteger(offlineAfterMs)||offlineAfterMs<1000)throw Error('Limite offline invalido');
  const period=periodFromSchedule({status:scheduleStatus});
  const prior=ensureState(value);
  // Tick da escala pode alterar jornada, mas nunca finge que houve nova leitura.
  const livePrevious=Boolean(prior && prior.atual.fisico!==PHYSICAL.OFFLINE &&
    nowMs-prior.atual.ultimaLeituraMs<=offlineAfterMs);
  const physical=sensorStatus!==null?physicalFromSensor(sensorStatus):!observed&&livePrevious?prior.atual.fisico:null;
  const events=[];
  if(!prior){
    if(physical===null)return {state:null,events,changed:false,reason:'SEM_LEITURA_INICIAL'};
    return {state:{atual:makeCurrent(physical,period,nowMs,scheduleReason),resumo:safeSummary(null)},events,changed:true,reason:'PRIMEIRA_LEITURA'};
  }
  const state=structuredClone(prior),cur=state.atual;
  // Clock regressions must never produce negative or duplicate durations.
  if(nowMs<cur.ultimaLeituraMs||nowMs<cur.inicioMs)
    return {state:prior,events,changed:false,reason:'HORA_ANTERIOR_IGNORADA'};
  let changed=false;
  if(cur.fisico!==PHYSICAL.OFFLINE && nowMs-cur.ultimaLeituraMs>offlineAfterMs){
    // Unknown from *last physical observation* onward (conservative).
    // Mudancas de jornada sem telemetria podem abrir um segmento depois da
    // ultima leitura. Fechar antes do inicio geraria evento com data invertida.
    // O tempo previamente encerrado nao pode ser contado outra vez.
    const last=Math.max(cur.inicioMs,cur.ultimaLeituraMs);
    closeSegment(state,last,events,'PERDA_COMUNICACAO');
    state.atual=makeCurrent(PHYSICAL.OFFLINE,cur.jornada,last,'',last);
    changed=true;
  }
  if(physical===null){
    return {state,events,changed,reason:changed?'OFFLINE_CONFIRMADO':'SEM_NOVA_LEITURA'};
  }
  const a=state.atual;
  if(a.fisico===physical && a.jornada===period){
    // Repeated readings refresh freshness only, do not create extra removals.
    if(observed)a.ultimaLeituraMs=nowMs;
    a.motivoPausa=period===PERIOD.BREAK?String(scheduleReason||'Pausa autorizada').slice(0,120):'';
    return {state,events,changed:true,reason:'LEITURA_REPETIDA'};
  }
  const left=a.fisico;
  closeSegment(state,nowMs,events,left===PHYSICAL.OFFLINE?'RETORNO_COMUNICACAO':'TRANSICAO');
  // Only a confirmed WORN => REMOVED transition increments. OFFLINE => REMOVED is unknown.
  if(left===PHYSICAL.WORN && physical===PHYSICAL.REMOVED)state.resumo.quantidadeRetiradas++;
  state.atual=makeCurrent(physical,period,nowMs,scheduleReason,observed?nowMs:a.ultimaLeituraMs);
  return {state,events,changed:true,reason:'TRANSICAO'};
}
/** Live view: current sensor information is counted only through the last actual reading.
 * Reporting never assumes the helmet is worn while no measurements arrive.
 */
function projectAudit(value,nowMs,offlineAfterMs=120000){
  const state=ensureState(value);
  if(!state)return null;
  if(!validTime(nowMs))throw Error('Timestamp invalido');
  const a=state.atual;
  const base=safeSummary(state.resumo);
  const time=Math.max(a.inicioMs,nowMs);
  const last=Math.max(a.inicioMs,a.ultimaLeituraMs);
  const fresh=a.fisico!==PHYSICAL.OFFLINE && time-last<=offlineAfterMs;
  // Last observation is NOT continuous proof; display ongoing segment tentatively only while fresh.
  const end=a.fisico===PHYSICAL.OFFLINE?time:(fresh?time:last);
  const virtual=accumulate(base,a,Math.max(0,end-a.inicioMs));
  virtual.totalIntervalos=base.totalIntervalos;
  if(!fresh&&a.fisico!==PHYSICAL.OFFLINE){
    virtual.tempoSemComunicacaoMs+=Math.max(0,time-last);
  }
  return {
    estadoFisico:fresh?a.fisico:PHYSICAL.OFFLINE,
    ultimaLeituraISO:new Date(a.ultimaLeituraMs).toISOString(),
    estadoDesdeISO:new Date(a.inicioMs).toISOString(),
    contextoJornada:a.jornada,
    pausa:a.motivoPausa||'',
    ...virtual,
    alertaRetirada:fresh&&a.fisico===PHYSICAL.REMOVED&&a.jornada===PERIOD.WORK,
    classificacaoConfirmada:!fresh?'SEM_COMUNICACAO':a.fisico===PHYSICAL.REMOVED&&a.jornada===PERIOD.BREAK?'RETIRADA_EM_PAUSA':a.fisico===PHYSICAL.REMOVED?'RETIRADA':a.fisico,
    tempoAtualMs:Math.max(0,time-a.inicioMs),
  };
}
/** Firebase ordena por chave, portanto prefixar pelo horario de FIM do evento.
 * O mesmo evento mantem o mesmo ID (reprocessamento idempotente).
 */
function makeAuditEventId(deviceId,event){
  const crypto=require('node:crypto');
  const millis=Date.parse(String(event?.fimISO||''));
  if(!Number.isSafeInteger(millis)||millis<0)throw Error('Data de fim invalida');
  const d=String(deviceId||'');
  if(!/^[a-zA-Z0-9_-]{1,64}$/.test(d))throw Error('Dispositivo invalido');
  const hash=crypto.createHash('sha256').update([
    d,event?.inicioISO,event?.fimISO,event?.estadoFisico,event?.contextoJornada,
  ].join('|')).digest('hex').slice(0,16);
  return `ev_${String(millis).padStart(13,'0')}_${hash}`;
}
module.exports={PHYSICAL,PERIOD,advanceAudit,projectAudit,physicalFromSensor,periodFromSchedule,makeAuditEventId};
