'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {companyRole}=require('../lib/access');
test('vínculo desativado bloqueia administrador do perfil principal',()=>{
 assert.equal(companyRole({companyId:'a',role:'admin'},{enabled:false,role:'admin'},'a'),null);
});
test('papel do vínculo da empresa prevalece sobre papel principal',()=>{
 assert.equal(companyRole({companyId:'a',role:'admin'},{enabled:true,role:'viewer'},'a'),'viewer');
 assert.equal(companyRole({companyId:'a',role:'admin'},{enabled:true,role:'sst'},'b'),'sst');
});
test('perfil antigo só autoriza empresa principal quando não existe vínculo',()=>{
 assert.equal(companyRole({companyId:'a',role:'admin'},undefined,'a'),'admin');
 assert.equal(companyRole({companyId:'a',role:'admin'},undefined,'b'),null);
 assert.equal(companyRole({companyId:'a',role:'admin'},{role:'admin'},'a'),null);
});
test('conta global desativada bloqueia também administrador da plataforma',()=>{
 assert.equal(companyRole({enabled:false,platformAdmin:true},{enabled:true,role:'admin'},'a'),null);
});
