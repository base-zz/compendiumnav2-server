// Extract and transform AIS targets from SignalK full data
export function extractAISTargetsFromSignalK(signalKData, selfMmsi) {
  // signalKData is expected to be the full vessels object (e.g., signalKData.vessels)
  // selfMmsi is the MMSI of the user's own vessel (from stateData.vessel.info.mmsi)
  if (!signalKData || typeof signalKData !== "object") return [];
  const aisTargets = [];
  for (const mmsi in signalKData) {
    if (!Object.prototype.hasOwnProperty.call(signalKData, mmsi)) continue;
    if (mmsi === "self" || mmsi === selfMmsi) continue; // skip self
    const vessel = signalKData[mmsi];
    if (!vessel) continue;
    let nm = vessel.name?.value || vessel.name;
    if (nm) {
      nm = nm.replace(/\u0000/g, '');
    }
    // Build AISTarget object
    aisTargets.push({
      mmsi: mmsi.split(':').pop(),
      name: nm,
      class: vessel['ais']?.class?.value || null,
      shipType: vessel['ais']?.shipType?.value || null,
      position: {
        latitude: vessel.navigation?.position?.value?.latitude ?? null,
        longitude: vessel.navigation?.position?.value?.longitude ?? null,
        timestamp: vessel.navigation?.position?.timestamp ?? null,
      },
      cog: vessel.navigation?.courseOverGroundTrue?.value ?? null,
      sog: vessel.navigation?.speedOverGround?.value ?? null,
      heading: vessel.navigation?.headingTrue?.value ?? null,
      destination: vessel['ais']?.destination?.value || null,
      callsign: vessel.communication?.callsignVhf?.value || null,
      status: vessel['ais']?.navStatus?.value || null,
      eta: vessel['ais']?.eta?.value || null,
    });
  }
  return aisTargets;
}

// Add to StateService.js:
// 1. Import this utility at the top (if in another file), or define it inside StateService.js if preferred.
// 2. Add a method to update anchor.aisTargets from the latest SignalK vessels data.

// ---- In StateService class ----

export async function updateAISTargetsFromSignalK(fullSignalKData, stateData) {
  // fullSignalKData should be the root SignalK document (with .vessels)
  const selfMmsi = stateData.vessel?.info?.mmsi;
  const aisTargets = extractAISTargetsFromSignalK(fullSignalKData.vessels, selfMmsi);
  stateData.aisTargets = aisTargets; // Update top-level aisTargets property
  console.log(`[AIS] Updated ${aisTargets.length} AIS targets from SignalK`);
}
 
