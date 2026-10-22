'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const rules=require('../firebase-database.rules.json').rules;
test('devices raiz nao permite leitura herdada',()=>assert.equal(rules.devices['.read'],false));
test('default exige vinculo pessoal',()=>{
 const condition=rules.devices.$deviceId['.read'];
 assert.match(condition,/\$deviceId === 'default'/);
 assert.match(condition,/personalHelmetOwners/);
 assert.match(condition,/child\(auth.uid\).val\(\) === true/);
});
test('demais dispositivos mantem expressao anterior',()=>assert.match(rules.devices.$deviceId['.read'],/profile'\).child\('companyId'/));
test('escritas diretas em devices continuam proibidas',()=>{
 assert.equal(rules.devices['.write'],false);assert.equal(rules.devices.$deviceId['.write'],false);
});
test('dados pessoais separados e vinculados',()=>{
 assert.equal(rules.personalAudits['.read'],false);
 assert.match(rules.personalAudits.$deviceId['.read'],/personalHelmetOwners/);
});
