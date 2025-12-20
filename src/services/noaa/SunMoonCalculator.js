const DEGREES_TO_RADIANS = Math.PI / 180;
const RADIANS_TO_DEGREES = 180 / Math.PI;

export function calculateSunTimes(latitude, longitude, date = new Date()) {
  const jd = getJulianDate(date);
  const jc = (jd - 2451545) / 36525;

  const geomMeanLongSun = (280.46646 + jc * (36000.76983 + 0.0003032 * jc)) % 360;
  const geomMeanAnomSun = 357.52911 + jc * (35999.05029 - 0.0001537 * jc);
  const eccentEarthOrbit = 0.016708634 - jc * (0.000042037 + 0.0000001267 * jc);
  const sunEqOfCtr =
    Math.sin(geomMeanAnomSun * DEGREES_TO_RADIANS) * (1.914602 - jc * (0.004817 + 0.000014 * jc)) +
    Math.sin(2 * geomMeanAnomSun * DEGREES_TO_RADIANS) * (0.019993 - 0.000101 * jc) +
    Math.sin(3 * geomMeanAnomSun * DEGREES_TO_RADIANS) * 0.000289;
  const sunTrueLong = geomMeanLongSun + sunEqOfCtr;
  const sunAppLong = sunTrueLong - 0.00569 - 0.00478 * Math.sin((125.04 - 1934.136 * jc) * DEGREES_TO_RADIANS);
  const meanObliqEcliptic = 23 + (26 + (21.448 - jc * (46.815 + jc * (0.00059 - jc * 0.001813))) / 60) / 60;
  const obliqCorr = meanObliqEcliptic + 0.00256 * Math.cos((125.04 - 1934.136 * jc) * DEGREES_TO_RADIANS);
  const sunDeclin = Math.asin(Math.sin(obliqCorr * DEGREES_TO_RADIANS) * Math.sin(sunAppLong * DEGREES_TO_RADIANS)) * RADIANS_TO_DEGREES;

  const varY = Math.tan((obliqCorr / 2) * DEGREES_TO_RADIANS) ** 2;
  const eqOfTime =
    4 *
    RADIANS_TO_DEGREES *
    (varY * Math.sin(2 * geomMeanLongSun * DEGREES_TO_RADIANS) -
      2 * eccentEarthOrbit * Math.sin(geomMeanAnomSun * DEGREES_TO_RADIANS) +
      4 * eccentEarthOrbit * varY * Math.sin(geomMeanAnomSun * DEGREES_TO_RADIANS) * Math.cos(2 * geomMeanLongSun * DEGREES_TO_RADIANS) -
      0.5 * varY * varY * Math.sin(4 * geomMeanLongSun * DEGREES_TO_RADIANS) -
      1.25 * eccentEarthOrbit * eccentEarthOrbit * Math.sin(2 * geomMeanAnomSun * DEGREES_TO_RADIANS));

  const haSunrise = Math.acos(
    Math.cos(90.833 * DEGREES_TO_RADIANS) / (Math.cos(latitude * DEGREES_TO_RADIANS) * Math.cos(sunDeclin * DEGREES_TO_RADIANS)) -
      Math.tan(latitude * DEGREES_TO_RADIANS) * Math.tan(sunDeclin * DEGREES_TO_RADIANS)
  ) * RADIANS_TO_DEGREES;

  const solarNoon = (720 - 4 * longitude - eqOfTime) / 1440;
  const sunriseTime = solarNoon - haSunrise * 4 / 1440;
  const sunsetTime = solarNoon + haSunrise * 4 / 1440;

  const civilTwilightAngle = 96;
  const nauticalTwilightAngle = 102;

  const haCivilTwilight = Math.acos(
    Math.cos(civilTwilightAngle * DEGREES_TO_RADIANS) / (Math.cos(latitude * DEGREES_TO_RADIANS) * Math.cos(sunDeclin * DEGREES_TO_RADIANS)) -
      Math.tan(latitude * DEGREES_TO_RADIANS) * Math.tan(sunDeclin * DEGREES_TO_RADIANS)
  ) * RADIANS_TO_DEGREES;

  const haNauticalTwilight = Math.acos(
    Math.cos(nauticalTwilightAngle * DEGREES_TO_RADIANS) / (Math.cos(latitude * DEGREES_TO_RADIANS) * Math.cos(sunDeclin * DEGREES_TO_RADIANS)) -
      Math.tan(latitude * DEGREES_TO_RADIANS) * Math.tan(sunDeclin * DEGREES_TO_RADIANS)
  ) * RADIANS_TO_DEGREES;

  const civilDawn = solarNoon - haCivilTwilight * 4 / 1440;
  const civilDusk = solarNoon + haCivilTwilight * 4 / 1440;
  const nauticalDawn = solarNoon - haNauticalTwilight * 4 / 1440;
  const nauticalDusk = solarNoon + haNauticalTwilight * 4 / 1440;

  const baseDate = new Date(date);
  baseDate.setUTCHours(0, 0, 0, 0);

  return {
    sunrise: fractionToDate(sunriseTime, baseDate),
    sunset: fractionToDate(sunsetTime, baseDate),
    solarNoon: fractionToDate(solarNoon, baseDate),
    civilDawn: fractionToDate(civilDawn, baseDate),
    civilDusk: fractionToDate(civilDusk, baseDate),
    nauticalDawn: fractionToDate(nauticalDawn, baseDate),
    nauticalDusk: fractionToDate(nauticalDusk, baseDate),
    dayLength: formatDuration((sunsetTime - sunriseTime) * 24 * 60),
  };
}

export function calculateMoonPhase(date = new Date()) {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();

  let c, e, jd, b;

  if (month < 3) {
    c = year - 1;
    e = month + 12;
  } else {
    c = year;
    e = month;
  }

  jd = Math.floor(365.25 * c) + Math.floor(30.6001 * (e + 1)) + day - 694039.09;
  jd /= 29.5305882;
  b = Math.floor(jd);
  jd -= b;
  const phase = Math.round(jd * 8);
  const normalizedPhase = phase >= 8 ? 0 : phase;

  const phaseNames = [
    "New Moon",
    "Waxing Crescent",
    "First Quarter",
    "Waxing Gibbous",
    "Full Moon",
    "Waning Gibbous",
    "Last Quarter",
    "Waning Crescent",
  ];

  const illumination = Math.round((1 - Math.cos(jd * 2 * Math.PI)) / 2 * 100);

  return {
    phase: normalizedPhase,
    phaseName: phaseNames[normalizedPhase],
    illumination,
    age: Math.round(jd * 29.5305882 * 10) / 10,
  };
}

export function calculateMoonTimes(latitude, longitude, date = new Date()) {
  const jd = getJulianDate(date);
  
  let moonrise = null;
  let moonset = null;

  for (let hour = 0; hour < 24; hour++) {
    const alt1 = getMoonAltitude(latitude, longitude, jd + (hour - 1) / 24);
    const alt2 = getMoonAltitude(latitude, longitude, jd + hour / 24);
    const alt3 = getMoonAltitude(latitude, longitude, jd + (hour + 1) / 24);

    if (alt1 < 0 && alt2 >= 0 && !moonrise) {
      const fraction = -alt1 / (alt2 - alt1);
      moonrise = new Date(date);
      moonrise.setUTCHours(hour - 1);
      moonrise.setUTCMinutes(Math.round(fraction * 60));
      moonrise.setUTCSeconds(0);
    }

    if (alt1 >= 0 && alt2 < 0 && !moonset) {
      const fraction = alt1 / (alt1 - alt2);
      moonset = new Date(date);
      moonset.setUTCHours(hour - 1);
      moonset.setUTCMinutes(Math.round(fraction * 60));
      moonset.setUTCSeconds(0);
    }
  }

  return {
    moonrise: moonrise ? moonrise.toISOString() : null,
    moonset: moonset ? moonset.toISOString() : null,
  };
}

function getMoonAltitude(latitude, longitude, jd) {
  const T = (jd - 2451545) / 36525;
  const L0 = (218.3164477 + 481267.88123421 * T) % 360;
  const M = (134.9633964 + 477198.8675055 * T) % 360;
  const F = (93.272095 + 483202.0175233 * T) % 360;

  const moonLon = L0 + 6.289 * Math.sin(M * DEGREES_TO_RADIANS);
  const moonLat = 5.128 * Math.sin(F * DEGREES_TO_RADIANS);

  const obliq = 23.439 - 0.00000036 * (jd - 2451545);
  const ra = Math.atan2(
    Math.sin(moonLon * DEGREES_TO_RADIANS) * Math.cos(obliq * DEGREES_TO_RADIANS) -
      Math.tan(moonLat * DEGREES_TO_RADIANS) * Math.sin(obliq * DEGREES_TO_RADIANS),
    Math.cos(moonLon * DEGREES_TO_RADIANS)
  ) * RADIANS_TO_DEGREES;
  const dec = Math.asin(
    Math.sin(moonLat * DEGREES_TO_RADIANS) * Math.cos(obliq * DEGREES_TO_RADIANS) +
      Math.cos(moonLat * DEGREES_TO_RADIANS) * Math.sin(obliq * DEGREES_TO_RADIANS) * Math.sin(moonLon * DEGREES_TO_RADIANS)
  ) * RADIANS_TO_DEGREES;

  const gmst = (280.46061837 + 360.98564736629 * (jd - 2451545)) % 360;
  const lmst = (gmst + longitude) % 360;
  const ha = lmst - ra;

  const alt = Math.asin(
    Math.sin(latitude * DEGREES_TO_RADIANS) * Math.sin(dec * DEGREES_TO_RADIANS) +
      Math.cos(latitude * DEGREES_TO_RADIANS) * Math.cos(dec * DEGREES_TO_RADIANS) * Math.cos(ha * DEGREES_TO_RADIANS)
  ) * RADIANS_TO_DEGREES;

  return alt;
}

function getJulianDate(date) {
  return date.getTime() / 86400000 + 2440587.5;
}

function fractionToDate(fraction, baseDate) {
  const ms = fraction * 24 * 60 * 60 * 1000;
  return new Date(baseDate.getTime() + ms).toISOString();
}

function formatDuration(minutes) {
  const hours = Math.floor(minutes / 60);
  const mins = Math.round(minutes % 60);
  return `${hours}h ${mins}m`;
}

export function getSunMoonData(latitude, longitude, date = new Date()) {
  const sunTimes = calculateSunTimes(latitude, longitude, date);
  const moonPhase = calculateMoonPhase(date);
  const moonTimes = calculateMoonTimes(latitude, longitude, date);

  return {
    sun: sunTimes,
    moon: {
      ...moonTimes,
      ...moonPhase,
    },
  };
}
