"use strict";

const admin = require("firebase-admin");

function required(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`Variável obrigatória ausente: ${name}`);
  return value;
}

const databaseURL = required("FIREBASE_DATABASE_URL");
const account = JSON.parse(String(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || process.env.FIREBASE_SERVICE_ACCOUNT || ""));
const email = required("PLATFORM_ADMIN_EMAIL").toLowerCase();
const displayName = String(process.env.PLATFORM_ADMIN_NAME || "Administração Geral").trim();

admin.initializeApp({ credential: admin.credential.cert(account), databaseURL });

(async () => {
  let user;
  try {
    user = await admin.auth().getUserByEmail(email);
  } catch (error) {
    if (error?.code !== "auth/user-not-found") throw error;
    const password = required("PLATFORM_ADMIN_PASSWORD");
    if (password.length < 8) throw new Error("PLATFORM_ADMIN_PASSWORD deve ter ao menos 8 caracteres.");
    user = await admin.auth().createUser({
      email,
      password,
      displayName,
      disabled: false,
    });
    console.log("Novo usuário Firebase Auth criado.");
  }

  const now = new Date().toISOString();
  await admin.database().ref().update({
    [`users/${user.uid}/profile`]: {
      companyId: "",
      displayName: user.displayName || displayName || email,
      role: "admin",
      enabled: true,
      platformAdmin: true,
      updatedAt: now,
    },
    [`authorizedUsers/${user.uid}`]: {
      enabled: true,
      email,
      platformAdmin: true,
      updatedAt: now,
    },
  });

  console.log(`ADMINISTRAÇÃO GERAL ATIVADA: ${email} (${user.uid})`);
  process.exit(0);
})().catch((error) => {
  console.error("ERRO:", error.message);
  process.exit(1);
});
