"use strict";
// Origem HTTPS exata; nao aceita subdominios aproximados, barra final, porta surpresa ou wildcard.
const approved = Object.freeze([
 'https://capacete-inteligente-bf599.web.app',
 'https://capacete-inteligente-bf599.firebaseapp.com',
]);
function isApprovedDashboardOrigin(origin,additional=''){
 if(typeof origin!=='string'||!origin)return false;
 const extra=String(additional||'').split(',').map(s=>s.trim()).filter(Boolean);
 const allow=new Set([...approved,...extra]);
 return allow.has(origin);
}
module.exports={isApprovedDashboardOrigin};
