'use strict';
function mqttOwnsTelemetry(marker) {
  return marker == null || marker.transport === 'mqtt';
}
module.exports = { mqttOwnsTelemetry };
