import fs from 'fs';

const gpxData = fs.readFileSync('/Users/basselabul-hajj/Downloads/sfl_test_1.gpx', 'utf-8');
console.log('GPX data length:', gpxData.length);
console.log('GPX data preview:', gpxData.substring(0, 200));

// Simple regex-based parsing for rtept elements
const rteptRegex = /<rtept\s+lat="([^"]+)"\s+lon="([^"]+)">/g;
const nameRegex = /<name>([^<]+)<\/name>/g;

const waypoints = [];
let match;
while ((match = rteptRegex.exec(gpxData)) !== null) {
  const lat = parseFloat(match[1]);
  const lon = parseFloat(match[2]);
  const nameMatch = nameRegex.exec(gpxData.substring(match.index, match.index + 100));
  const name = nameMatch ? nameMatch[1] : '';
  waypoints.push({ lat, lon, name });
}

console.log('Extracted waypoints:', waypoints.length);
console.log('First waypoint:', waypoints[0]);
console.log('Last waypoint:', waypoints[waypoints.length - 1]);
