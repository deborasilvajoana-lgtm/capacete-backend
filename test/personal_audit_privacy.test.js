"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname,'..');
const rules = JSON.parse(fs.readFileSync(path.join(root,'firebase-database.rules.json'),'utf8')).rules;
const server = fs.readFileSync(path.join(root,'server.js'),'utf8');
const ownPath = "root.child('personalHelmetOwners').child($deviceId).child(auth.uid).val() === true";
test('auditoria pessoal fora da arvore devices de leitura ampla',()=>{
 assert.equal(server.includes('`personalAudits/${DEFAULT_DEVICE_ID}`'),true);
 assert.equal(rules.personalAudits['.read'],false);
 assert.equal(rules.personalAudits['.write'],false);
 assert.equal(rules.personalAudits.$deviceId['.write'],false);
 assert.equal(rules.personalAudits.$deviceId['.read'].includes(ownPath),true);
 assert.equal(rules.personalAudits.$deviceId['.read'].includes('platformAdmin'),false);
 assert.equal(rules.devices['.write'],false);
});
test('API exige vinculo mesmo de administrador da plataforma',()=>{
 const route = server.slice(server.indexOf("app.get('/monitoring/devices/:deviceId/physical-audit'"),server.indexOf('app.post("/mary/chat"'));
 assert.ok(route.includes('requireAuthorizedUser'));
 assert.ok(route.includes('own.val()!==true'));
 assert.ok(route.includes('res.status(403)'));
 assert.equal(route.includes('if(req.appUser.platformAdmin!==true)'),false);
});
test('vinculo pessoal jamais gravado pelo cliente e nao expõe outros UIDs',()=>{
 assert.equal(rules.personalHelmetOwners['.read'],false);
 assert.equal(rules.personalHelmetOwners['.write'],false);
 assert.equal(rules.personalHelmetOwners.$deviceId.$uid['.write'],false);
 assert.equal(rules.personalHelmetOwners.$deviceId.$uid['.read'], 'auth != null && auth.uid === $uid');
});
test('nenhuma escrita da nova auditoria se flag desabilitada por padrao',()=>{
 assert.ok(server.includes('const ENABLE_PERSONAL_PHYSICAL_AUDIT=boolEnv("ENABLE_PERSONAL_PHYSICAL_AUDIT",false);'));
 assert.ok(server.includes('if (!ENABLE_PERSONAL_PHYSICAL_AUDIT || deviceId !== DEFAULT_DEVICE_ID) return;'));
});
