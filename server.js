const express = require("express");
const cors = require("cors");
const mqtt = require("mqtt");
const app = express();
app.use(cors()); app.use(express.json());
const PORT = process.env.PORT || 3000;
const MQTT_HOST = process.env.MQTT_HOST || "14acbc646e274caaaf10971e5b3b335e.s1.eu.hivemq.cloud";
const MQTT_PORT = process.env.MQTT_PORT || "8883";
const MQTT_USER = process.env.MQTT_USER || "esp32";
const MQTT_PASS = process.env.MQTT_PASS || "Capacete2026@";
const MQTT_TOPIC = process.env.MQTT_TOPIC || "capacete/status";
const FIREBASE_DATABASE_URL = process.env.FIREBASE_DATABASE_URL || "https://capacete-inteligente-bf599-default-rtdb.firebaseio.com";
const FUNCIONARIO = "Débora da Silva Costa";
const EPI = "Capacete 01";
const TEMPO_SEM_LEITURA_MS = 20000;
let statusAtualSistema = "INATIVO";
let rawAtualSistema = "SEM_LEITURA";
let inicioStatusMs = Date.now();
let ultimaLeituraMs = 0;
let mqttConectado = false;
function converterStatus(valor){const e=String(valor||"").trim().toUpperCase(); if(e.includes("DETECTOU"))return "ATIVO"; if(e.includes("LIVRE"))return "INATIVO"; if(e.includes("SEM_LEITURA")||e.includes("OFFLINE"))return "INATIVO"; if(e==="ATIVO"||e==="1"||e==="TRUE")return "ATIVO"; return "INATIVO";}
function titulo(s){return s==="ATIVO"?"CAPACETE EM USO":"SEM CAPACETE"} function alarme(s){return s==="ATIVO"?"✅ CAPACETE EM USO":"⚠ SEM CAPACETE"} function desc(s,raw){if(raw==="SEM_LEITURA")return "ESP32 sem leitura. Sistema considerado sem capacete."; if(raw==="OFFLINE")return "MQTT offline/reconectando. Sistema considerado sem capacete."; return s==="ATIVO"?"Sensor detectou o capacete em uso":"Sensor livre, capacete sem uso"}
function formatarTempo(seg){const h=Math.floor(seg/3600),m=Math.floor((seg%3600)/60),s=seg%60; if(h>0)return `${h}h ${m}min ${s}s`; if(m>0)return `${m} min ${s} seg`; return `${s} seg`}
async function fget(p){const r=await fetch(`${FIREBASE_DATABASE_URL}/${p}.json`); if(!r.ok)throw new Error(await r.text()); return await r.json()}
async function fpatch(p,d){const r=await fetch(`${FIREBASE_DATABASE_URL}/${p}.json`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify(d)}); if(!r.ok)throw new Error(await r.text()); return await r.json()}
async function fpost(p,d){const r=await fetch(`${FIREBASE_DATABASE_URL}/${p}.json`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(d)}); if(!r.ok)throw new Error(await r.text()); return await r.json()}
async function atualizarUltimo(status,raw){const agora=new Date(); await fpatch("ultimo",{funcionario:FUNCIONARIO,epi:EPI,raw,rawAtual:raw,status,statusAtual:status,titulo:titulo(status),data:agora.toLocaleDateString("pt-BR"),horaFim:agora.toLocaleTimeString("pt-BR"),atualizadoEm:agora.toISOString(),descricao:desc(status,raw),alarme:alarme(status),valor:status==="ATIVO"?1:0,mqttConectado,backendOnline:true})}
async function salvarEvento(status,inicioMs,fimMs,raw){const tempoSegundos=Math.max(0,Math.floor((fimMs-inicioMs)/1000)); if(tempoSegundos<=0)return; const inicio=new Date(inicioMs),fim=new Date(fimMs),tempo=formatarTempo(tempoSegundos); await fpost("eventos",{funcionario:FUNCIONARIO,epi:EPI,raw,rawAtual:raw,data:fim.toLocaleDateString("pt-BR"),horaInicio:inicio.toLocaleTimeString("pt-BR"),horaFim:fim.toLocaleTimeString("pt-BR"),dataHoraISO:fim.toISOString(),status,statusAtual:status,titulo:titulo(status),tempoSegundos,tempo,descricao:status==="ATIVO"?`Capacete em uso por ${tempo}`:`Sem capacete por ${tempo}`,alarme:alarme(status),valor:status==="ATIVO"?1:0}); const resumo=await fget("resumo")||{totalEventos:0,totalAlertas:0,tempoAtivoSegundos:0,tempoInativoSegundos:0}; resumo.totalEventos=Number(resumo.totalEventos||0)+1; if(status==="ATIVO")resumo.tempoAtivoSegundos=Number(resumo.tempoAtivoSegundos||0)+tempoSegundos; else{resumo.totalAlertas=Number(resumo.totalAlertas||0)+1; resumo.tempoInativoSegundos=Number(resumo.tempoInativoSegundos||0)+tempoSegundos;} const total=Number(resumo.tempoAtivoSegundos||0)+Number(resumo.tempoInativoSegundos||0); resumo.conformidade=total>0?Math.round((Number(resumo.tempoAtivoSegundos||0)/total)*100):0; resumo.tempoAtivo=formatarTempo(Number(resumo.tempoAtivoSegundos||0)); resumo.tempoInativo=formatarTempo(Number(resumo.tempoInativoSegundos||0)); await fpatch("",{resumo})}
async function mudarStatus(novo,raw,motivo){const agora=Date.now(); if(novo!==statusAtualSistema){await salvarEvento(statusAtualSistema,inicioStatusMs,agora,rawAtualSistema); statusAtualSistema=novo; rawAtualSistema=raw; inicioStatusMs=agora; console.log(`Mudança (${motivo}): ${raw} => ${novo}`)} else rawAtualSistema=raw; await atualizarUltimo(novo,raw)}
async function processar(payload){const raw=String(payload||"").trim().toUpperCase(); const novo=converterStatus(raw); ultimaLeituraMs=Date.now(); console.log("MQTT recebido:",raw,"=>",novo); await mudarStatus(novo,raw,"MQTT")}
async function verificar(){try{const agora=Date.now(); if(!ultimaLeituraMs){await atualizarUltimo("INATIVO","SEM_LEITURA"); return;} if(agora-ultimaLeituraMs>=TEMPO_SEM_LEITURA_MS){await mudarStatus("INATIVO","SEM_LEITURA","SEM_LEITURA")}}catch(e){console.error(e.message)}}
const client=mqtt.connect(`mqtts://${MQTT_HOST}:${MQTT_PORT}`,{username:MQTT_USER,password:MQTT_PASS,protocolVersion:4,reconnectPeriod:3000,connectTimeout:15000,keepalive:30,clean:true});
client.on("connect",async()=>{mqttConectado=true; console.log("✅ Conectado ao HiveMQ"); client.subscribe(MQTT_TOPIC); await atualizarUltimo(statusAtualSistema,rawAtualSistema)});
client.on("message",async(t,m)=>{try{await processar(m.toString())}catch(e){console.error(e.message)}});
client.on("close",async()=>{mqttConectado=false; try{await mudarStatus("INATIVO","OFFLINE","MQTT_CLOSE")}catch(e){}}); client.on("offline",async()=>{mqttConectado=false; try{await mudarStatus("INATIVO","OFFLINE","MQTT_OFFLINE")}catch(e){}}); client.on("error",e=>{mqttConectado=false; console.error(e.message)});
setInterval(verificar,5000);
app.get("/",(req,res)=>res.json({ok:true,sistema:"Capacete Inteligente",versao:"final-definitivo",regra:"DETECTOU=ATIVO/VERDE; LIVRE=INATIVO/VERMELHO; SEM_LEITURA/OFFLINE=INATIVO/VERMELHO",mqttConectado,statusAtualSistema,rawAtualSistema}));
app.get("/teste/:status",async(req,res)=>{try{const recebido=req.params.status,convertido=converterStatus(recebido); await processar(recebido); res.json({ok:true,recebido,convertido})}catch(e){res.status(500).json({ok:false,erro:e.message})}});
app.get("/forcar-inativo",async(req,res)=>{try{ultimaLeituraMs=Date.now()-TEMPO_SEM_LEITURA_MS; await mudarStatus("INATIVO","SEM_LEITURA","FORCADO"); res.json({ok:true,status:"INATIVO"})}catch(e){res.status(500).json({ok:false,erro:e.message})}});
app.get("/health",(req,res)=>res.json({ok:true,backendOnline:true,mqttConectado,statusAtualSistema,rawAtualSistema,timestamp:new Date().toISOString()}));
app.listen(PORT,async()=>{console.log("🚀 Backend online",PORT); try{await atualizarUltimo("INATIVO","SEM_LEITURA")}catch(e){console.error(e.message)}});
