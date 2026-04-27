#!/usr/bin/env node
/**
 * Smoke test for Fuel Pipeline HTTP API integration
 *
 * Tests:
 * 1. API routes are registered
 * 2. Python scripts are executable
 * 3. Database is accessible
 * 4. End-to-end flow works (if MARINA_DB_PATH is set)
 *
 * Usage:
 *   node test/fuel_pipeline_smoke_test.js
 *
 * Environment:
 *   MARINA_DB_PATH - optional, enables full end-to-end test
 *   PORT - optional, default 3000
 */

import http from "http";
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const PORT = process.env.PORT || 3000;
const MARINA_DB_PATH = process.env.MARINA_DB_PATH;
const BASE_URL = `http://localhost:${PORT}`;

const COLORS = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
};

function log(msg, color = "reset") {
  console.log(`${COLORS[color]}${msg}${COLORS.reset}`);
}

function makeRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "localhost",
      port: PORT,
      path,
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
    };

    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve({
            status: res.statusCode,
            body: JSON.parse(data),
          });
        } catch (_err) {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });

    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function testPythonExecutable() {
  log("\n[TEST] Python executable check", "blue");

  const venvPython = path.join(REPO_ROOT, "fuel_extractor/.venv/bin/python");

  return new Promise((resolve) => {
    const python = spawn(venvPython, ["--version"]);
    let version = "";

    python.stdout.on("data", (data) => {
      version += data.toString();
    });

    python.on("close", (code) => {
      if (code === 0) {
        log(`  ✓ Python found: ${version.trim()}`, "green");
        resolve(true);
      } else {
        log(`  ✗ Python not found at ${venvPython}`, "red");
        resolve(false);
      }
    });

    python.on("error", () => {
      log(`  ✗ Failed to spawn Python at ${venvPython}`, "red");
      resolve(false);
    });
  });
}

async function testPythonScriptsExist() {
  log("\n[TEST] Python scripts exist", "blue");

  const scripts = [
    "marina_management_v2/run_geographic_sweep.py",
    "fuel_extractor_v2/run_fuel_worker_once.py",
  ];

  const fs = await import("fs");
  let allExist = true;

  for (const script of scripts) {
    const fullPath = path.join(REPO_ROOT, script);
    if (fs.existsSync(fullPath)) {
      log(`  ✓ ${script}`, "green");
    } else {
      log(`  ✗ ${script} not found`, "red");
      allExist = false;
    }
  }

  return allExist;
}

async function testStatusEndpoint() {
  log("\n[TEST] GET /api/fuel/status", "blue");

  try {
    const res = await makeRequest("GET", "/api/fuel/status");

    if (res.status === 200) {
      log(`  ✓ Status endpoint responding (HTTP ${res.status})`, "green");
      log(`  ✓ Pending seeds: ${res.body.status?.pendingSeeds ?? "N/A"}`, "green");
      return true;
    } else if (res.status === 404) {
      log(`  ⚠ Endpoint not found (HTTP ${res.status}) - routes may not be registered`, "yellow");
      return false;
    } else {
      log(`  ✗ Unexpected status: HTTP ${res.status}`, "red");
      log(`     ${JSON.stringify(res.body)}`, "red");
      return false;
    }
  } catch (err) {
    log(`  ✗ Connection failed: ${err.message}`, "red");
    return false;
  }
}

async function testDiscoveryEndpoint() {
  log("\n[TEST] POST /api/fuel/discover", "blue");

  if (!MARINA_DB_PATH) {
    log("  ⚠ Skipped (MARINA_DB_PATH not set)", "yellow");
    return null;
  }

  try {
    // Use a known marina location (Wormley Creek area)
    const res = await makeRequest("POST", "/api/fuel/discover", {
      lat: 37.2425,
      lon: -76.5069,
      sweepRadius: 5,
      discoveryRadius: 2,
      gridSpacing: 3,
    });

    if (res.status === 200 && res.body.success) {
      log(`  ✓ Discovery completed`, "green");
      log(`     Total discovered: ${res.body.result?.total_discovered ?? "N/A"}`, "green");
      log(`     New marinas: ${res.body.result?.new_marinas ?? "N/A"}`, "green");
      return true;
    } else {
      log(`  ✗ Discovery failed: ${res.body.error || JSON.stringify(res.body)}`, "red");
      return false;
    }
  } catch (err) {
    log(`  ✗ Request failed: ${err.message}`, "red");
    return false;
  }
}

async function testExtractEndpoint() {
  log("\n[TEST] POST /api/fuel/extract", "blue");

  if (!MARINA_DB_PATH) {
    log("  ⚠ Skipped (MARINA_DB_PATH not set)", "yellow");
    return null;
  }

  try {
    const res = await makeRequest("POST", "/api/fuel/extract", {
      batchSize: 5,
    });

    if (res.status === 200 && res.body.success) {
      log(`  ✓ Extraction completed`, "green");
      log(`     Processed: ${res.body.result?.processed ?? "N/A"}`, "green");
      log(`     Success: ${res.body.result?.succeeded ?? "N/A"}`, "green");
      log(`     Failed: ${res.body.result?.failed ?? "N/A"}`, "green");
      return true;
    } else {
      log(`  ✗ Extraction failed: ${res.body.error || JSON.stringify(res.body)}`, "red");
      return false;
    }
  } catch (err) {
    log(`  ✗ Request failed: ${err.message}`, "red");
    return false;
  }
}

async function testFullPipelineEndpoint() {
  log("\n[TEST] POST /api/fuel/pipeline", "blue");

  if (!MARINA_DB_PATH) {
    log("  ⚠ Skipped (MARINA_DB_PATH not set)", "yellow");
    return null;
  }

  try {
    const res = await makeRequest("POST", "/api/fuel/pipeline", {
      lat: 37.2425,
      lon: -76.5069,
      sweepRadius: 5,
      discoveryRadius: 2,
      gridSpacing: 3,
      batchSize: 5,
    });

    if (res.status === 200 && res.body.success) {
      log(`  ✓ Full pipeline completed`, "green");
      log(`     Discovery: ${JSON.stringify(res.body.result?.discovery ?? {})}`, "green");
      log(`     Extraction: processed=${res.body.result?.extraction?.processed ?? "N/A"}`, "green");
      return true;
    } else {
      log(`  ✗ Pipeline failed: ${res.body.error || JSON.stringify(res.body)}`, "red");
      return false;
    }
  } catch (err) {
    log(`  ✗ Request failed: ${err.message}`, "red");
    return false;
  }
}

async function main() {
  log("=".repeat(60), "blue");
  log("Fuel Pipeline Smoke Test", "blue");
  log("=".repeat(60), "blue");
  log(`\nServer: ${BASE_URL}`);
  log(`DB Path: ${MARINA_DB_PATH || "(not set - partial test only)"}`);

  const results = {
    python: await testPythonExecutable(),
    scripts: await testPythonScriptsExist(),
    status: await testStatusEndpoint(),
    discovery: await testDiscoveryEndpoint(),
    extract: await testExtractEndpoint(),
    pipeline: await testFullPipelineEndpoint(),
  };

  log("\n" + "=".repeat(60), "blue");
  log("SUMMARY", "blue");
  log("=".repeat(60), "blue");

  const criticalTests = ["python", "scripts", "status"];
  const e2eTests = ["discovery", "extract", "pipeline"];

  let criticalPassed = 0;
  let e2ePassed = 0;

  for (const test of criticalTests) {
    const passed = results[test] === true;
    const icon = passed ? "✓" : "✗";
    const color = passed ? "green" : "red";
    log(`${icon} ${test}: ${passed ? "PASS" : "FAIL"}`, color);
    if (passed) criticalPassed++;
  }

  if (MARINA_DB_PATH) {
    log("\nEnd-to-End Tests:", "blue");
    for (const test of e2eTests) {
      const result = results[test];
      if (result === null) {
        log(`⚠ ${test}: SKIPPED`, "yellow");
      } else if (result === true) {
        log(`✓ ${test}: PASS`, "green");
        e2ePassed++;
      } else {
        log(`✗ ${test}: FAIL`, "red");
      }
    }
  } else {
    log("\n⚠ End-to-End tests skipped (set MARINA_DB_PATH to enable)", "yellow");
  }

  const totalCritical = criticalTests.length;
  const totalE2E = MARINA_DB_PATH ? e2eTests.length : 0;

  log("\n" + "=".repeat(60), "blue");
  log(
    `Critical: ${criticalPassed}/${totalCritical} passed`,
    criticalPassed === totalCritical ? "green" : "red"
  );
  if (MARINA_DB_PATH) {
    log(
      `End-to-End: ${e2ePassed}/${totalE2E} passed`,
      e2ePassed === totalE2E ? "green" : "yellow"
    );
  }

  const exitCode = criticalPassed === totalCritical ? 0 : 1;
  process.exit(exitCode);
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
