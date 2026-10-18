'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {validRegistration,isAuthorized}=require('../lib/access_requests');
const form={name:'Responsável pela empresa',company:'Construtora Exemplo',email:'RESP@example.com',cnpj:'12345678000190',password:'senha-de-teste-longa'};
test('normaliza e valida novo cadastro, sem autorizar sozinho',()=>{
  const r=validRegistration(form);
  assert.equal(r.email,'resp@example.com');
  assert.equal(r.cnpj,'12345678000190');
  assert.equal(isAuthorized({enabled:false}, {enabled:false}),false);
});
test('cadastro inválido ou senha fraca é rejeitado',()=>{
  assert.throws(()=>validRegistration({...form,password:'123'}));
  assert.throws(()=>validRegistration({...form,cnpj:'123'}));
  assert.throws(()=>validRegistration({...form,email:'nao-email'}));
});
test('aprovação exige dois indicadores positivos, negado não entra',()=>{
  assert.equal(isAuthorized({enabled:true},{enabled:true}),true);
  assert.equal(isAuthorized({enabled:true},{enabled:false}),false);
  assert.equal(isAuthorized({enabled:false},{enabled:true}),false);
  assert.equal(isAuthorized({},undefined),false);
});
