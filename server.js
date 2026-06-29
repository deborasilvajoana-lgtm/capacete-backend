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

function converterStatus(valor) {
  const estado = String(valor || "").trim().toUpperCase();

  // CORRETO AGORA:
  // DETECTOU = CAPACETE EM USO
  // LIVRE = SEM CAPACETE
  if (estado === "DETECTOU" || estado === "ATIVO" || estado === "1") {
    return "ATIVO";
  }

  if (estado === "LIVRE" || estado === "INATIVO" || estado === "0") {
    return "INATIVO";
  }

  return "INATIVO";
}

  if (estado === "DETECTOU" || estado === "INATIVO" || estado === "0") {
    return "INATIVO";
  }

  return "INATIVO";
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
  return await r.json();
}

async function firebasePatch(path, data) {
  const r = await fetch(`${FIREBASE_DATABASE_URL}/${path}.json`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data)
  });

  if (!r.ok) throw new Error(await r.text());
  return await r.json();
}

async function firebasePost(path, data) {
  const r = await fetch(`${FIREBASE_DATABASE_URL}/${path}.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data)
  });

  if (!r.ok) throw new Error(await r.text());
  return await r.json();
}

async function salvarEvento(statusFechado, inicio, fim, raw) {
  const tempoSegundos = Math.max(0, Math.floor((fim - inicio) / 1000));
  const tempo = formatarTempo(tempoSegundos);

  const registro = {
    funcionario,
    epi,
    raw,
    data: fim.toLocaleDateString("pt-BR"),
    horaInicio: inicio.toLocaleTimeString("pt-BR"),
    horaFim: fim.toLocaleTimeString("pt-BR"),
    dataHoraISO: fim.toISOString(),
    status: statusFechado,
    statusAtual: statusFechado,
    tempoSegundos,
    tempo,
    descricao:
      statusFechado === "ATIVO"
        ? `Capacete em uso por ${tempo}`
        : `Sem capacete por ${tempo}`,
    alarme:
      statusFechado === "ATIVO"
        ? "✅ CAPACETE EM USO"
        : "⚠ SEM CAPACETE",
    valor: statusFechado === "ATIVO" ? 1 : 0
  };

  await firebasePost("eventos", registro);

  const resumo = await firebaseGet("resumo") || {
    totalEventos: 0,
    totalAlertas: 0,
    tempoAtivoSegundos: 0,
    tempoInativoSegundos: 0
  };

  resumo.totalEventos += 1;

  if (statusFechado === "ATIVO") {
    resumo.tempoAtivoSegundos += tempoSegundos;
  } else {
    resumo.totalAlertas += 1;
    resumo.tempoInativoSegundos += tempoSegundos;
  }

  const total = resumo.tempoAtivoSegundos + resumo.tempoInativoSegundos;

  resumo.conformidade =
    total > 0 ? Math.round((resumo.tempoAtivoSegundos / total) * 100) : 0;

  resumo.tempoAtivo = formatarTempo(resumo.tempoAtivoSegundos);
  resumo.tempoInativo = formatarTempo(resumo.tempoInativoSegundos);

  await firebasePatch("", { resumo });

  return registro;
}

async function atualizarUltimo(status, raw) {
  const agora = new Date();

  await firebasePatch("ultimo", {
    funcionario,
    epi,
    raw,
    status,
    statusAtual: status,
    data: agora.toLocaleDateString("pt-BR"),
    horaFim: agora.toLocaleTimeString("pt-BR"),
    atualizadoEm: agora.toISOString(),
    descricao:
      status === "ATIVO"
        ? "Capacete detectado em uso"
        : "Capacete não está em uso",
    alarme:
      status === "ATIVO"
        ? "✅ CAPACETE EM USO"
        : "⚠ SEM CAPACETE",
    valor: status === "ATIVO" ? 1 : 0
  });
}

async function processar(payload) {
  const raw = String(payload || "").trim().toUpperCase();
  const novoStatus = converterStatus(raw);
  const agoraMs = Date.now();

  if (statusAtualSistema === null) {
    statusAtualSistema = novoStatus;
    inicioStatus = agoraMs;
    await atualizarUltimo(novoStatus, raw);
    console.log("Estado inicial:", raw, "=>", novoStatus);
    return;
  }

  if (novoStatus !== statusAtualSistema) {
    const inicio = new Date(inicioStatus);
    const fim = new Date(agoraMs);

    await salvarEvento(statusAtualSistema, inicio, fim, raw);

    statusAtualSistema = novoStatus;
    inicioStatus = agoraMs;
  }

  await atualizarUltimo(novoStatus, raw);

  console.log("MQTT recebido:", raw);
  console.log("Status atual:", novoStatus);
}

const client = mqtt.connect(`mqtts://${MQTT_HOST}:${MQTT_PORT}`, {
  username: MQTT_USER,
  password: MQTT_PASS,
  protocolVersion: 4,
  reconnectPeriod: 5000
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
    const payload = message.toString();
    await processar(payload);
  } catch (e) {
    console.error("Erro:", e.message);
  }
});

client.on("error", (err) => {
  console.error("MQTT erro:", err.message);
});

app.get("/", (req, res) => {
  res.json({
    ok: true,
    sistema: "Capacete Inteligente",
    regra: "LIVRE = ATIVO / DETECTOU = INATIVO",
    mqttTopic: MQTT_TOPIC,
    firebase: FIREBASE_DATABASE_URL
  });
});

app.get("/teste/:status", async (req, res) => {
  try {
    await processar(req.params.status);
    res.json({
      ok: true,
      recebido: req.params.status,
      convertido: converterStatus(req.params.status)
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      erro: e.message
    });
  }
});

app.listen(PORT, () => {
  console.log("🚀 Backend online na porta", PORT);
});
