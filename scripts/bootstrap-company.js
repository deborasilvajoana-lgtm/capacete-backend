"use strict";

const admin = require("firebase-admin");

function required(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`Variável obrigatória ausente: ${name}`);
  return value;
}

const databaseURL = required("FIREBASE_DATABASE_URL");
const account = JSON.parse(String(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || process.env.FIREBASE_SERVICE_ACCOUNT || ""));
const email = required("BOOTSTRAP_USER_EMAIL").toLowerCase();
const cnpjDigits = required("BOOTSTRAP_COMPANY_CNPJ").replace(/\D/g, "");
if (cnpjDigits.length !== 14) throw new Error("BOOTSTRAP_COMPANY_CNPJ deve ter 14 dígitos.");

const companyId = `cnpj_${cnpjDigits}`;
const legalName = required("BOOTSTRAP_COMPANY_LEGAL_NAME");
const tradeName = String(process.env.BOOTSTRAP_COMPANY_TRADE_NAME || legalName).trim();
const role = String(process.env.BOOTSTRAP_USER_ROLE || "admin").trim().toLowerCase();
if (!["admin", "sst", "supervisor", "viewer"].includes(role)) throw new Error("BOOTSTRAP_USER_ROLE inválido.");

admin.initializeApp({ credential: admin.credential.cert(account), databaseURL });

(async () => {
  let user;
  try {
    user = await admin.auth().getUserByEmail(email);
  } catch (error) {
    if (error?.code !== "auth/user-not-found") throw error;
    const password = required("BOOTSTRAP_USER_PASSWORD");
    if (password.length < 8) throw new Error("BOOTSTRAP_USER_PASSWORD deve ter ao menos 8 caracteres.");
    user = await admin.auth().createUser({
      email,
      password,
      emailVerified: false,
      displayName: String(process.env.BOOTSTRAP_USER_NAME || email.split("@")[0]).trim(),
      disabled: false,
    });
    console.log("Novo usuário Firebase Auth criado.");
  }
  const now = new Date().toISOString();
  const updates = {
    [`companies/${companyId}/profile`]: {
      cnpj: cnpjDigits,
      legalName,
      tradeName,
      email: String(process.env.BOOTSTRAP_COMPANY_EMAIL || "").trim(),
      phone: String(process.env.BOOTSTRAP_COMPANY_PHONE || "").trim(),
      address: String(process.env.BOOTSTRAP_COMPANY_ADDRESS || "").trim(),
      city: String(process.env.BOOTSTRAP_COMPANY_CITY || "São Paulo").trim(),
      state: String(process.env.BOOTSTRAP_COMPANY_STATE || "SP").trim(),
      responsibleName: String(process.env.BOOTSTRAP_COMPANY_RESPONSIBLE || "").trim(),
      sstResponsible: String(process.env.BOOTSTRAP_SST_RESPONSIBLE || "").trim(),
      active: true,
      updatedAt: now,
    },
    [`users/${user.uid}/profile`]: {
      companyId,
      displayName: user.displayName || email,
      role,
      enabled: true,
      platformAdmin: false,
      updatedAt: now,
    },
    [`authorizedUsers/${user.uid}`]: {
      enabled: true,
      email,
      companyId,
      updatedAt: now,
    },
    [`companies/${companyId}/members/${user.uid}`]: {
      uid: user.uid,
      email,
      displayName: user.displayName || email,
      role,
      enabled: true,
      updatedAt: now,
    },
  };

  const deviceId = String(process.env.BOOTSTRAP_DEVICE_ID || "").trim();
  if (deviceId) {
    updates[`deviceRegistry/${deviceId}`] = {
      companyId,
      employeeId: String(process.env.BOOTSTRAP_EMPLOYEE_ID || "").trim(),
      helmetId: String(process.env.BOOTSTRAP_HELMET_ID || "").trim(),
      helmetCode: String(process.env.BOOTSTRAP_HELMET_CODE || "Capacete 01").trim(),
      worksiteId: String(process.env.BOOTSTRAP_WORKSITE_ID || "").trim(),
      active: true,
      updatedAt: now,
    };
  }

  await admin.database().ref().update(updates);
  console.log(`Empresa criada/vinculada: ${companyId}`);
  console.log(`Usuário: ${email} (${role})`);
  if (deviceId) console.log(`Dispositivo vinculado: ${deviceId}`);
  process.exit(0);
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
