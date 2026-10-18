"use strict";
const test=require('node:test');
const assert=require('node:assert/strict');
const {isApprovedDashboardOrigin:allowed}=require('../lib/cors_policy');
test('Hosting web.app tem CORS autorizado',()=>assert.equal(allowed('https://capacete-inteligente-bf599.web.app'),true));
test('Hosting firebaseapp.com tem CORS autorizado',()=>assert.equal(allowed('https://capacete-inteligente-bf599.firebaseapp.com'),true));
test('Sites externos e HTTP sao recusados',()=>{
 for(const origin of ['','null','https://capacete-inteligente-bf599.web.app.attacker.com','http://capacete-inteligente-bf599.web.app','https://example.com','https://capacete-inteligente-bf599.web.app:444','*'])assert.equal(allowed(origin),false);
});
test('Origens extras precisam ser configuradas explicitamente',()=>{
 assert.equal(allowed('https://app.exemplo.com','https://app.exemplo.com'),true);
 assert.equal(allowed('https://outro.exemplo.com','https://app.exemplo.com'),false);
});
test('Rotas de historico e preflight estao no servidor',()=>{
 const fs=require('fs');const source=fs.readFileSync(require.resolve('../server.js'),'utf8');
 assert.match(source,/isApprovedDashboardOrigin/);
 assert.match(source,/Access-Control-Allow-Origin/);
 assert.match(source,/req.method==='OPTIONS'/);
 assert.match(source,/req.query.status==='all'/);
 assert.match(source,/requirePlatformAdmin, async\(req,res\)/);
});
