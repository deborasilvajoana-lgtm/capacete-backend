"use strict";

const admin = require("firebase-admin");

function required(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`Variável ausente: ${name}`);
  return value;
}

const email = String(process.argv[2] || "").trim().toLowerCase();
if (!email || !email.includes("@")) {
  console.error("Uso: npm run authorize -- usuario@empresa.com");
  process.exit(2);
}

const serviceAccount = JSON.parse(String(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || process.env.FIREBASE_SERVICE_ACCOUNT || ""));
const databaseURL = required("FIREBASE_DATABASE_URL");
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL,
});

(async () => {
  const user = await admin.auth().getUserByEmail(email);
  await admin.database().ref(`authorizedUsers/${user.uid}`).set({
    enabled: true,
    role: "supervisor",
    email,
    updatedAt: new Date().toISOString(),
  });
  console.log(`AUTORIZADO: ${email} (${user.uid}) - role supervisor`);
  process.exit(0);
})().catch((error) => {
  console.error("ERRO:", error.message);
  process.exit(1);
});
