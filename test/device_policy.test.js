'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {canAcceptDeviceReading}=require('../lib/device_policy');
test('ESP32 legado continua aceito sem registro',()=>assert.equal(canAcceptDeviceReading('default',null),true));
test('dispositivo desconhecido não cria histórico na empresa',()=>assert.equal(canAcceptDeviceReading('cap-003',null),false));
test('dispositivo cadastrado na empresa aceita mensagens',()=>assert.equal(canAcceptDeviceReading('cap-003',{companyId:'company-1',active:true}),true));
test('equipamento desativado não recebe novas leituras',()=>assert.equal(canAcceptDeviceReading('cap-003',{companyId:'company-1',active:false}),false));
