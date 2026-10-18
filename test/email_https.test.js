"use strict";
const test=require('node:test');
const assert=require('node:assert/strict');
const {isEmailReady,makeApprovalEmailSender}=require('../lib/email_https');
test('sem credenciais HTTPS não libera cadastro empresarial',()=>{
 assert.equal(isEmailReady({APPROVAL_ADMIN_EMAIL:'admin@example.com'}),false);
});
test('email HTTPS usa Brevo sem expor chave no corpo',async()=>{
 let payload,options;
 const env={APPROVAL_ADMIN_EMAIL:'owner@example.com',BREVO_API_KEY:'chave-falsa-test',BREVO_SENDER_EMAIL:'sender@example.com'};
 const send=makeApprovalEmailSender({env,fetchImpl:async(uri,opts)=>{payload=uri;options=opts;return {ok:true,status:201};}});
 await send({subject:'Nova solicitação',text:'Pessoa A: empresa B'});
 assert.equal(payload,'https://api.brevo.com/v3/smtp/email');
 assert.equal(options.headers['api-key'],'chave-falsa-test');
 assert.equal(JSON.parse(options.body).to[0].email,'owner@example.com');
 assert.ok(!options.body.includes('chave-falsa-test'));
});
test('falha HTTP no provedor não libera cadastro silenciosamente',async()=>{
 const env={APPROVAL_ADMIN_EMAIL:'owner@example.com',BREVO_API_KEY:'chave-teste',BREVO_SENDER_EMAIL:'sender@example.com'};
 const send=makeApprovalEmailSender({env,fetchImpl:async()=>({ok:false,status:403})});
 await assert.rejects(()=>send({subject:'novo',text:'pedido'}),/403/);
});
