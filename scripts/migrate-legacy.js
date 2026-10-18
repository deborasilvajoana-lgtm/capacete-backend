"use strict";

const admin = require("firebase-admin");

function required(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`Variável ausente: ${name}`);
  return value;
}

const serviceAccount = JSON.parse(String(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || process.env.FIREBASE_SERVICE_ACCOUNT || ""));
const databaseURL = required("FIREBASE_DATABASE_URL");
const deviceId = String(process.env.DEFAULT_DEVICE_ID || "default")
  .replace(/[^a-zA-Z0-9_-]/g, "-")
  .slice(0, 64) || "default";

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL,
});
const db = admin.database();

(async () => {
  const target = await db.ref(`devices/${deviceId}`).once("value");
  if (target.exists()) {
    console.log(`Nada feito: devices/${deviceId} já existe.`);
    return;
  }

  const [ultimoSnap, resumoSnap, eventosSnap] = await Promise.all([
    db.ref("ultimo").once("value"),
    db.ref("resumo").once("value"),
    db.ref("eventos").once("value"),
  ]);
  const ultimo = ultimoSnap.val();
  const resumo = resumoSnap.val();
  const eventos = eventosSnap.val();
  if (!ultimo && !resumo && !eventos) {
    console.log("Nada para migrar no banco legado.");
    return;
  }

  const updates = {};
  if (ultimo) updates[`devices/${deviceId}/ultimo`] = { ...ultimo, deviceId };
  if (resumo) updates[`devices/${deviceId}/resumo`] = resumo;
  if (eventos) updates[`devices/${deviceId}/eventos`] = eventos;
  updates[`devices/${deviceId}/meta`] = {
    deviceId,
    funcionario: ultimo?.funcionario || "",
    epi: ultimo?.epi || "Capacete 01",
    migradoEm: new Date().toISOString(),
  };
  await db.ref().update(updates);
  console.log(`Migração concluída para devices/${deviceId}.`);
})()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("ERRO:", error.message);
    process.exit(1);
  });
