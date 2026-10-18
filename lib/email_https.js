"use strict";

// E-mail de solicitação de acesso via HTTPS; Render Free bloqueia SMTP.
function isEmailReady(env) {
  return Boolean(String(env.BREVO_API_KEY || '').trim() &&
    String(env.BREVO_SENDER_EMAIL || '').trim() &&
    String(env.APPROVAL_ADMIN_EMAIL || '').trim());
}

function makeApprovalEmailSender({ env, fetchImpl }) {
  return async function sendApprovalEmail({ subject, text }) {
    if (!isEmailReady(env)) throw Error('E-mail HTTPS não configurado.');
    const senderEmail = String(env.BREVO_SENDER_EMAIL).trim();
    const adminEmail = String(env.APPROVAL_ADMIN_EMAIL).trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(senderEmail) ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail)) {
      throw Error('Endereço de e-mail inválido na configuração do servidor.');
    }
    const result = await fetchImpl('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'content-type':'application/json',
        'accept':'application/json',
        'api-key': String(env.BREVO_API_KEY),
      },
      body: JSON.stringify({
        sender: { name:'Capacete Empresa', email:senderEmail },
        to: [{email:adminEmail}],
        subject:String(subject || '').slice(0,180),
        textContent:String(text || '').slice(0,7000),
      }),
      signal:AbortSignal.timeout(12000),
    });
    if (!result.ok) throw Error('Provedor de e-mail não aceitou a mensagem (HTTP '+result.status+').');
    return true;
  };
}

module.exports={isEmailReady,makeApprovalEmailSender};
