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

const FIREBASE_DATABASE_URL =
  process.env.FIREBASE_DATABASE_URL ||
  "https://capacete-inteligente-bf599-default-rtdb.firebaseio.com";

const funcionario = "Débora da Silva Costa";
const epi = "Capacete 01";

let statusAtualSistema = null;
let inicioStatus = Date.now();
let rawAtualSistema = "";

/*
  REGRA DEFINITIVA DO SENSOR:
  DETECTOU = ATIVO = CAPACETE EM USO = VERDE
  LIVRE    = INATIVO = SEM CAPACETE = VERMELHO
*/
function converterStatus(valor) {
  const estado = String(valor || "").trim().toUpperCase();

  if (estado.includes("DETECTOU")) return "ATIVO";
  if (estado.includes("LIVRE")) return "INATIVO";

  if (estado === "ATIVO" || estado === "1" || estado === "TRUE") return "ATIVO";
  if (estado === "INATIVO" || estado === "0" || estado === "FALSE") return "INATIVO";

  return "INATIVO";
}

function textoStatus(status) {
  return status === "ATIVO" ? "CAPACETE EM USO" : "SEM CAPACETE";
}

function descricaoStatus(status) {
  return status === "ATIVO"
    ? "Sensor detectou o capacete em uso"
    : "Sensor livre, capacete sem uso";
}

function alarmeStatus(status) {
  return status === "ATIVO"
    ? "✅ CAPACETE EM USO"
    : "⚠ SEM CAPACETE";
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

async function limparUltimo() {
  const agora = new Date();
  await firebasePatch("ultimo", {
    funcionario,
    epi,
    raw: "AGUARDANDO",
    rawAtual: "AGUARDANDO",
    status: "INATIVO",
    statusAtual: "INATIVO",
    titulo: "SEM CAPACETE",
    data: agora.toLocaleDateString("pt-BR"),
    horaFim: agora.toLocaleTimeString("pt-BR"),
    atualizadoEm: agora.toISOString(),
    descricao: "Sistema iniciado. Aguardando leitura do sensor.",
    alarme: "⚠ SEM CAPACETE",
    valor: 0
  });
}

async function salvarEvento(statusFechado, inicio, fim, rawFechado) {
  const tempoSegundos = Math.max(0, Math.floor((fim - inicio) / 1000));
  const tempo = formatarTempo(tempoSegundos);

  const registro = {
    funcionario,
    epi,
    raw: rawFechado,
    rawAtual: rawFechado,
    data: fim.toLocaleDateString("pt-BR"),
    horaInicio: inicio.toLocaleTimeString("pt-BR"),
    horaFim: fim.toLocaleTimeString("pt-BR"),
    dataHoraISO: fim.toISOString(),
    status: statusFechado,
    statusAtual: statusFechado,
    titulo: textoStatus(statusFechado),
    tempoSegundos,
    tempo,
    descricao:
      statusFechado === "ATIVO"
        ? `Capacete em uso por ${tempo}`
        : `Sem capacete por ${tempo}`,
    alarme: alarmeStatus(statusFechado),
    valor: statusFechado === "ATIVO" ? 1 : 0
  };

  await firebasePost("eventos", registro);

  const resumoAtual = await firebaseGet("resumo");
  const resumo = resumoAtual || {
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

  resumo.conformidade =
    total > 0 ? Math.round((Number(resumo.tempoAtivoSegundos || 0) / total) * 100) : 0;

  resumo.tempoAtivo = formatarTempo(Number(resumo.tempoAtivoSegundos || 0));
  resumo.tempoInativo = formatarTempo(Number(resumo.tempoInativoSegundos || 0));

  await firebasePatch("", { resumo });

  return registro;
}

async function atualizarUltimo(status, raw) {
  const agora = new Date();

  await firebasePatch("ultimo", {
    funcionario,
    epi,
    raw,
    rawAtual: raw,
    status,
    statusAtual: status,
    titulo: textoStatus(status),
    data: agora.toLocaleDateString("pt-BR"),
    horaFim: agora.toLocaleTimeString("pt-BR"),
    atualizadoEm: agora.toISOString(),
    descricao: descricaoStatus(status),
    alarme: alarmeStatus(status),
    valor: status === "ATIVO" ? 1 : 0
  });
}

async function processar(payload) {
  const raw = String(payload || "").trim().toUpperCase();
  const novoStatus = converterStatus(raw);
  const agoraMs = Date.now();

  console.log("MQTT recebido:", raw);
  console.log("Convertido:", novoStatus);

  if (statusAtualSistema === null) {
    statusAtualSistema = novoStatus;
    rawAtualSistema = raw;
    inicioStatus = agoraMs;

    await atualizarUltimo(novoStatus, raw);

    console.log("Estado inicial:", raw, "=>", novoStatus);
    return;
  }

  if (novoStatus !== statusAtualSistema) {
    const inicio = new Date(inicioStatus);
    const fim = new Date(agoraMs);

    await salvarEvento(statusAtualSistema, inicio, fim, rawAtualSistema);

    statusAtualSistema = novoStatus;
    rawAtualSistema = raw;
    inicioStatus = agoraMs;
  } else {
    rawAtualSistema = raw;
  }

  await atualizarUltimo(novoStatus, raw);
}

const client = mqtt.connect(`mqtts://${MQTT_HOST}:${MQTT_PORT}`, {
  username: MQTT_USER,
  password: MQTT_PASS,
  protocolVersion: 4,
  reconnectPeriod: 5000,
  clean: true
});

client.on("connect", () => {
  console.log("✅ Conectado ao HiveMQ");
  client.subscribe(MQTT_TOPIC, (err) => {
    if (err) {
      console.error("Erro ao assinar tópico:", err);
    } else {
      console.log("📡 Assinando tópico:", MQTT_TOPIC);
    }
  });
});

client.on("message", async (topic, message) => {
  try {
    await processar(message.toString());
  } catch (e) {
    console.error("Erro ao processar MQTT:", e.message);
  }
});

client.on("error", (err) => {
  console.error("MQTT erro:", err.message);
});

app.get("/", (req, res) => {
  res.json({
    ok: true,
    sistema: "Capacete Inteligente",
    regra: "DETECTOU = ATIVO/VERDE; LIVRE = INATIVO/VERMELHO",
    mqttTopic: MQTT_TOPIC,
    firebase: FIREBASE_DATABASE_URL
  });
});

app.get("/teste/:status", async (req, res) => {
  try {
    const recebido = req.params.status;
    const convertido = converterStatus(recebido);

    await processar(recebido);

    res.json({
      ok: true,
      recebido,
      convertido,
      regra: "DETECTOU = ATIVO/VERDE; LIVRE = INATIVO/VERMELHO"
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      erro: e.message
    });
  }
});

app.get("/resetar-ultimo", async (req, res) => {
  try {
    statusAtualSistema = null;
    inicioStatus = Date.now();
    rawAtualSistema = "";
    await limparUltimo();
    res.json({ ok: true, mensagem: "Último status resetado para INATIVO." });
  } catch (e) {
    res.status(500).json({ ok: false, erro: e.message });
  }
});

app.listen(PORT, () => {
  console.log("🚀 Backend online na porta", PORT);
  console.log("REGRA ATIVA: DETECTOU = ATIVO/VERDE | LIVRE = INATIVO/VERMELHO");
});
