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

let ultimoEstado = null;
let ultimoTempo = Date.now();

function converterStatus(valor) {
  const estado = String(valor || "").trim().toUpperCase();
  if (estado === "LIVRE" || estado === "ATIVO" || estado === "1") return "ATIVO";
  return "INATIVO";
}

function formatarTempo(segundos) {
  const h = Math.floor(segundos / 3600);
  const m = Math.floor((segundos % 3600) / 60);
  const s = segundos % 60;
  if (h > 0) return `${h}h ${m}min ${s}s`;
  return `${m} min ${s} seg`;
}

async function firebaseGet(path) {
  const r = await fetch(`${FIREBASE_DATABASE_URL}/${path}.json`);
  return await r.json();
}

async function firebasePatch(path, data) {
  const r = await fetch(`${FIREBASE_DATABASE_URL}/${path}.json`, {
    method: "PATCH",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify(data)
  });
  if (!r.ok) throw new Error(`Firebase PATCH ${r.status}: ${await r.text()}`);
  return await r.json();
}

async function firebasePost(path, data) {
  const r = await fetch(`${FIREBASE_DATABASE_URL}/${path}.json`, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify(data)
  });
  if (!r.ok) throw new Error(`Firebase POST ${r.status}: ${await r.text()}`);
  return await r.json();
}

async function processar(payload) {
  const agora = new Date();
  const estadoAtual = String(payload || "").trim().toUpperCase();

  if (ultimoEstado === null) {
    ultimoEstado = estadoAtual;
    ultimoTempo = Date.now();
  }

  const statusRegistro = converterStatus(ultimoEstado);
  const statusAtual = converterStatus(estadoAtual);

  const inicio = new Date(ultimoTempo);
  const fim = agora;
  const tempoSegundos = Math.max(0, Math.floor((fim - inicio) / 1000));
  const tempo = formatarTempo(tempoSegundos);

  const registro = {
    funcionario,
    epi,
    raw: estadoAtual,
    data: fim.toLocaleDateString("pt-BR"),
    horaInicio: inicio.toLocaleTimeString("pt-BR"),
    horaFim: fim.toLocaleTimeString("pt-BR"),
    dataHoraISO: fim.toISOString(),
    status: statusRegistro,
    statusAtual,
    tempoSegundos,
    tempo,
    descricao: `Ficou ${statusRegistro} por ${tempo}`,
    alarme: statusAtual === "INATIVO" ? "⚠ SEM CAPACETE" : "✅ CAPACETE EM USO",
    valor: statusAtual === "ATIVO" ? 1 : 0
  };

  await firebasePost("eventos", registro);

  const resumo = await firebaseGet("resumo") || {
    totalEventos: 0,
    totalAlertas: 0,
    tempoAtivoSegundos: 0,
    tempoInativoSegundos: 0
  };

  resumo.totalEventos += 1;
  if (statusRegistro === "INATIVO") resumo.totalAlertas += 1;
  if (statusRegistro === "ATIVO") resumo.tempoAtivoSegundos += tempoSegundos;
  if (statusRegistro === "INATIVO") resumo.tempoInativoSegundos += tempoSegundos;

  const total = resumo.tempoAtivoSegundos + resumo.tempoInativoSegundos;
  resumo.conformidade = total > 0 ? Math.round((resumo.tempoAtivoSegundos / total) * 100) : 0;
  resumo.tempoAtivo = formatarTempo(resumo.tempoAtivoSegundos);
  resumo.tempoInativo = formatarTempo(resumo.tempoInativoSegundos);

  await firebasePatch("", {
    ultimo: {...registro, atualizadoEm: fim.toISOString()},
    resumo
  });

  ultimoEstado = estadoAtual;
  ultimoTempo = Date.now();

  console.log("Gravado no Firebase:", registro.statusAtual, registro.raw, registro.horaFim);
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
    if (err) console.error("Erro ao assinar tópico:", err);
    else console.log("📡 Assinando tópico:", MQTT_TOPIC);
  });
});

client.on("message", async (topic, message) => {
  const payload = message.toString();
  console.log("MQTT recebido:", topic, payload);
  try {
    await processar(payload);
  } catch (e) {
    console.error("Erro ao gravar no Firebase:", e.message);
  }
});

client.on("error", (err) => console.error("MQTT erro:", err.message));

app.get("/", (req, res) => {
  res.json({
    ok: true,
    sistema: "Capacete Inteligente",
    mqttTopic: MQTT_TOPIC,
    firebase: FIREBASE_DATABASE_URL
  });
});

app.post("/teste/:status", async (req, res) => {
  try {
    await processar(req.params.status);
    res.json({ok: true, status: req.params.status});
  } catch (e) {
    res.status(500).json({ok: false, erro: e.message});
  }
});

app.listen(PORT, () => console.log("🚀 Backend online na porta", PORT));