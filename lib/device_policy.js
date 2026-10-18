'use strict';
// Device default remains compatible with the existing single ESP32; all other
// device IDs must be explicitly linked in deviceRegistry and active.
function canAcceptDeviceReading(deviceId, registry, defaultDeviceId = 'default') {
  if (registry?.active === false) return false;
  if (deviceId === defaultDeviceId) return true;
  return Boolean(registry && typeof registry.companyId === 'string' && registry.companyId.trim());
}
module.exports={canAcceptDeviceReading};
