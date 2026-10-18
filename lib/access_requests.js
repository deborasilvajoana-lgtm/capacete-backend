"use strict";
function cleanText(value, max = 120) { return String(value || '').trim().slice(0, max); }
function validRegistration(input) {
  const email = cleanText(input.email, 254).toLowerCase();
  const name = cleanText(input.name);
  const company = cleanText(input.company);
  const cnpj = cleanText(input.cnpj, 24).replace(/\D/g, '');
  const password = String(input.password || '');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw Error('E-mail inválido');
  if (name.length < 3) throw Error('Informe o nome do responsável');
  if (company.length < 3) throw Error('Informe o nome da empresa');
  if (cnpj.length !== 14) throw Error('Informe o CNPJ com 14 números');
  if (password.length < 10 || password.length > 128) throw Error('Senha deve ter de 10 a 128 caracteres');
  return {email,name,company,cnpj,password};
}
function isAuthorized(profile, authorization) {
  return Boolean(profile && profile.enabled !== false &&
    (authorization === true || (authorization && authorization.enabled === true)));
}
module.exports={cleanText,validRegistration,isAuthorized};
