const express = require("express");
const cors = require("cors");
const mqtt = require("mqtt");

const app = express();
app.use(cors());
app.use(express.json());

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
const VERIFICACAO_MS = 5000;
const REGRAVAR_OFFLINE_MS = 30000;

let statusAtualSistema = "INATIVO";
let rawAtualSistema = "SEM_LEITURA";
let inicioStatusMs = Date.now();
let ultimaLeituraMs = 0;
let ultimoOfflinePatchMs = 0;
let mqttConectado = false;

function converterStatus(valor) {
  const estado = String(valor || "").trim().toUpperCase();
  if (estado.includes("DETECTOU")) return "ATIVO";
  if (estado.includes("LIVRE")) return "INATIVO";
  if (estado.includes("SEM_LEITURA")) return "INATIVO";
  if (estado.includes("OFFLINE")) return "INATIVO";
  if (estado === "ATIVO" || estado === "1" || estado === "TRUE") return "ATIVO";
  return "INATIVO";
}

function titulo(status) {
  return status === "ATIVO" ? "CAPACETE EM USO" : "SEM CAPACETE";
}

function alarme(status) {
  return status === "ATIVO" ? "✅ CAPACETE EM USO" : "⚠ SEM CAPACETE";
}

function descricao(status, raw) {
  if (raw === "SEM_LEITURA") return "ESP32 sem leitura. Sistema considerado sem capacete.";
  if (raw === "OFFLINE") return "MQTT offline/reconectando. Sistema considerado sem capacete.";
  return status === "ATIVO" ? "Sensor detectou o capacete em uso" : "Sensor livre, capacete sem uso";
}

function formatarTempo(segundos) {
  const h = Math.floor(segundos / 3600);
  const m = Math.floor((segundos % 3600) / 60);
  const s = segundos % 60;
  if (h > 0) return `${h}h ${m}min ${s}s`;
  if (m > 0) return `${m} min ${s} seg`;
  return `${s} seg`;
}

async function firebaseGet(path) {
  const r = await fetch(`${FIREBASE_DATABASE_URL}/${path}.json`);
  if (!r.ok) throw new Error(`Firebase GET ${r.status}: ${await r.text()}`);
  return await r.json();
}

async function firebasePatch(path, data) {
  const r = await fetch(`${FIREBASE_DATABASE_URL}/${path}.json`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data)
  });
  if (!r.ok) throw new Error(`Firebase PATCH ${r.status}: ${await r.text()}`);
  return await r.json();
}

async function firebasePost(path, data) {
  const r = await fetch(`${FIREBASE_DATABASE_URL}/${path}.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data)
  });
  if (!r.ok) throw new Error(`Firebase POST ${r.status}: ${await r.text()}`);
  return await r.json();
}

async function atualizarUltimo(status, raw) {
  const agora = new Date();
  await firebasePatch("ultimo", {
    funcionario: FUNCIONARIO,
    epi: EPI,
    raw,
    rawAtual: raw,
    status,
    statusAtual: status,
    titulo: titulo(status),
    data: agora.toLocaleDateString("pt-BR"),
    horaFim: agora.toLocaleTimeString("pt-BR"),
    atualizadoEm: agora.toISOString(),
    descricao: descricao(status, raw),
    alarme: alarme(status),
    valor: status === "ATIVO" ? 1 : 0,
    mqttConectado,
    backendOnline: true
  });
}

async function salvarEvento(statusFechado, inicioMs, fimMs, rawFechado) {
  const tempoSegundos = Math.max(0, Math.floor((fimMs - inicioMs) / 1000));
  if (tempoSegundos <= 0) return;

  const inicio = new Date(inicioMs);
  const fim = new Date(fimMs);
  const tempo = formatarTempo(tempoSegundos);

  const registro = {
    funcionario: FUNCIONARIO,
    epi: EPI,
    raw: rawFechado,
    rawAtual: rawFechado,
    data: fim.toLocaleDateString("pt-BR"),
    horaInicio: inicio.toLocaleTimeString("pt-BR"),
    horaFim: fim.toLocaleTimeString("pt-BR"),
    dataHoraISO: fim.toISOString(),
    status: statusFechado,
    statusAtual: statusFechado,
    titulo: titulo(statusFechado),
    tempoSegundos,
    tempo,
    descricao: statusFechado === "ATIVO" ? `Capacete em uso por ${tempo}` : `Sem capacete por ${tempo}`,
    alarme: alarme(statusFechado),
    valor: statusFechado === "ATIVO" ? 1 : 0
  };

  await firebasePost("eventos", registro);

  const resumo = (await firebaseGet("resumo")) || {
    totalEventos: 0,
    totalAlertas: 0,
    tempoAtivoSegundos: 0,
    tempoInativoSegundos: 0
  };

  resumo.totalEventos = Number(resumo.totalEventos || 0) + 1;

  if (statusFechado === "ATIVO") {
    resumo.tempoAtivoSegundos = Number(resumo.tempoAtivoSegundos || 0) + tempoSegundos;
  } else {
    resumo.totalAlertas = Number(resumo.totalAlertas || 0) + 1;
    resumo.tempoInativoSegundos = Number(resumo.tempoInativoSegundos || 0) + tempoSegundos;
  }

  const total = Number(resumo.tempoAtivoSegundos || 0) + Number(resumo.tempoInativoSegundos || 0);
  resumo.conformidade = total > 0 ? Math.round((Number(resumo.tempoAtivoSegundos || 0) / total) * 100) : 0;
  resumo.tempoAtivo = formatarTempo(Number(resumo.tempoAtivoSegundos || 0));
  resumo.tempoInativo = formatarTempo(Number(resumo.tempoInativoSegundos || 0));

  await firebasePatch("", { resumo });
}

async function mudarStatus(novoStatus, raw, motivo) {
  const agoraMs = Date.now();

  if (novoStatus !== statusAtualSistema) {
    await salvarEvento(statusAtualSistema, inicioStatusMs, agoraMs, rawAtualSistema);
    statusAtualSistema = novoStatus;
    rawAtualSistema = raw;
    inicioStatusMs = agoraMs;
    console.log(`Mudança de status (${motivo}): ${raw} => ${novoStatus}`);
  } else {
    rawAtualSistema = raw;
  }

  await atualizarUltimo(novoStatus, raw);
}

async function processarMensagem(payload) {
  const raw = String(payload || "").trim().toUpperCase();
  const novoStatus = converterStatus(raw);
  ultimaLeituraMs = Date.now();
  console.log("MQTT recebido:", raw, "=>", novoStatus);
  await mudarStatus(novoStatus, raw, "MQTT");
}

async function verificarSemLeitura() {
  try {
    const agoraMs = Date.now();

    if (!ultimaLeituraMs) {
      if (agoraMs - ultimoOfflinePatchMs >= REGRAVAR_OFFLINE_MS) {
        ultimoOfflinePatchMs = agoraMs;
        await atualizarUltimo("INATIVO", "SEM_LEITURA");
      }
      return;
    }

    const semLeituraHa = agoraMs - ultimaLeituraMs;

    if (semLeituraHa >= TEMPO_SEM_LEITURA_MS) {
      if (statusAtualSistema !== "INATIVO") {
        await mudarStatus("INATIVO", "SEM_LEITURA", "SEM_LEITURA");
      } else if (agoraMs - ultimoOfflinePatchMs >= REGRAVAR_OFFLINE_MS) {
        ultimoOfflinePatchMs = agoraMs;
        await atualizarUltimo("INATIVO", "SEM_LEITURA");
      }
    }
  } catch (e) {
    console.error("Erro no monitor sem leitura:", e.message);
  }
}

const client = mqtt.connect(`mqtts://${MQTT_HOST}:${MQTT_PORT}`, {
  username: MQTT_USER,
  password: MQTT_PASS,
  protocolVersion: 4,
  reconnectPeriod: 3000,
  connectTimeout: 15000,
  keepalive: 30,
  clean: true
});

client.on("connect", async () => {
  mqttConectado = true;
  console.log("✅ Conectado ao HiveMQ");
  client.subscribe(MQTT_TOPIC, async (err) => {
    if (err) console.error("Erro ao assinar tópico:", err);
    else console.log("📡 Assinando tópico:", MQTT_TOPIC);
  });
  await atualizarUltimo(statusAtualSistema, rawAtualSistema || "SEM_LEITURA");
});

client.on("message", async (topic, message) => {
  try {
    await processarMensagem(message.toString());
  } catch (e) {
    console.error("Erro ao processar MQTT:", e.message);
  }
});

client.on("close", async () => {
  mqttConectado = false;
  console.log("MQTT desconectado. Tentando reconectar...");
  try { await mudarStatus("INATIVO", "OFFLINE", "MQTT_CLOSE"); } catch (e) { console.error(e.message); }
});

client.on("offline", async () => {
  mqttConectado = false;
  console.log("MQTT offline.");
  try { await mudarStatus("INATIVO", "OFFLINE", "MQTT_OFFLINE"); } catch (e) { console.error(e.message); }
});

client.on("error", (err) => {
  mqttConectado = false;
  console.error("MQTT erro:", err.message);
});

setInterval(verificarSemLeitura, VERIFICACAO_MS);

app.get("/", (req, res) => {
  res.json({
    ok: true,
    sistema: "Capacete Inteligente",
    versao: "backend-v2-estavel",
    regra: "DETECTOU=ATIVO/VERDE; LIVRE=INATIVO/VERMELHO; SEM_LEITURA/OFFLINE=INATIVO/VERMELHO",
    mqttConectado,
    statusAtualSistema,
    rawAtualSistema,
    ultimaLeituraSegundos: ultimaLeituraMs ? Math.floor((Date.now() - ultimaLeituraMs) / 1000) : null,
    mqttTopic: MQTT_TOPIC
  });
});

app.get("/teste/:status", async (req, res) => {
  try {
    const recebido = req.params.status;
    const convertido = converterStatus(recebido);
    await processarMensagem(recebido);
    res.json({ ok: true, recebido, convertido });
  } catch (e) {
    res.status(500).json({ ok: false, erro: e.message });
  }
});

app.get("/forcar-inativo", async (req, res) => {
  try {
    ultimaLeituraMs = Date.now() - TEMPO_SEM_LEITURA_MS;
    await mudarStatus("INATIVO", "SEM_LEITURA", "FORCADO");
    res.json({ ok: true, status: "INATIVO", mensagem: "Forçado para vermelho/sem capacete." });
  } catch (e) {
    res.status(500).json({ ok: false, erro: e.message });
  }
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    backendOnline: true,
    mqttConectado,
    statusAtualSistema,
    rawAtualSistema,
    timestamp: new Date().toISOString()
  });
});

app.listen(PORT, async () => {
  console.log("🚀 Backend online na porta", PORT);
  console.log("REGRA: DETECTOU=ATIVO/VERDE | LIVRE=INATIVO/VERMELHO | SEM_LEITURA=INATIVO/VERMELHO");
  try {
    await atualizarUltimo("INATIVO", "SEM_LEITURA");
  } catch (e) {
    console.error("Erro ao iniciar Firebase em vermelho:", e.message);
  }
});
