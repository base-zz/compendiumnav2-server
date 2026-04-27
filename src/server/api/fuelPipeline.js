import { spawn } from "child_process";
import path from "path";

/**
 * Fuel Pipeline API
 *
 * Provides HTTP endpoints to trigger the Python-based fuel extraction pipeline:
 * 1. Discovery/Reconcile/Seed - sweep region for marinas
 * 2. Fuel Extraction - process pending seeds
 * 3. Full Pipeline - both steps
 */

function runPythonScript(scriptPath, args) {
  return new Promise((resolve, reject) => {
    const venvPython = path.resolve(
      process.cwd(),
      "fuel_extractor/.venv/bin/python"
    );
    const fullScriptPath = path.resolve(process.cwd(), scriptPath);

    const python = spawn(venvPython, [fullScriptPath, ...args]);

    let stdout = "";
    let stderr = "";

    python.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    python.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    python.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(`Python script exited with code ${code}: ${stderr || stdout}`)
        );
        return;
      }

      try {
        // Try to parse JSON output
        const result = JSON.parse(stdout);
        resolve({ result, stderr: stderr || null });
      } catch (_err) {
        // Return raw stdout if not JSON
        resolve({ result: stdout.trim(), stderr: stderr || null });
      }
    });

    python.on("error", (err) => {
      reject(new Error(`Failed to spawn Python: ${err.message}`));
    });
  });
}

/**
 * Trigger geographic sweep for marina discovery
 */
export async function triggerDiscovery(options) {
  const {
    dbPath,
    lat,
    lon,
    sweepRadius = 50,
    discoveryRadius = 5,
    gridSpacing = 10,
    timeout = 45,
    scrollCycles = 10,
  } = options;

  if (!dbPath || !lat || !lon) {
    throw new Error("dbPath, lat, and lon are required");
  }

  const args = [
    "--db-path",
    dbPath,
    "--center-lat",
    String(lat),
    "--center-lon",
    String(lon),
    "--sweep-radius",
    String(sweepRadius),
    "--discovery-radius",
    String(discoveryRadius),
    "--grid-spacing",
    String(gridSpacing),
    "--timeout",
    String(timeout),
    "--scroll-cycles",
    String(scrollCycles),
  ];

  return runPythonScript("marina_management_v2/run_geographic_sweep.py", args);
}

/**
 * Trigger fuel extraction worker
 */
export async function triggerFuelExtraction(options) {
  const { dbPath, batchSize = 50 } = options;

  if (!dbPath) {
    throw new Error("dbPath is required");
  }

  const args = ["--db-path", dbPath, "--batch-size", String(batchSize)];

  return runPythonScript("fuel_extractor_v2/run_fuel_worker_once.py", args);
}

/**
 * Run full pipeline: discovery + extraction
 */
export async function runFullPipeline(options) {
  const discoveryResult = await triggerDiscovery(options);
  const extractionResult = await triggerFuelExtraction({
    dbPath: options.dbPath,
    batchSize: options.batchSize || 50,
  });

  return {
    discovery: discoveryResult.result,
    extraction: extractionResult.result,
  };
}

/**
 * Register fuel pipeline routes on Express app
 */
export function registerFuelPipelineRoutes(app, options = {}) {
  const dbPath = options.dbPath || process.env.MARINA_DB_PATH;

  if (!dbPath) {
    console.warn(
      "[FuelPipeline] No dbPath provided, fuel pipeline routes disabled"
    );
    return;
  }

  /**
   * POST /api/fuel/discover
   * Trigger geographic sweep for marina discovery
   *
   * Body: {
   *   lat: number (required) - Center latitude
   *   lon: number (required) - Center longitude
   *   sweepRadius?: number - Total sweep radius in miles (default: 50)
   *   discoveryRadius?: number - Discovery radius per point in miles (default: 5)
   *   gridSpacing?: number - Grid spacing in miles (default: 10)
   *   timeout?: number - Discovery timeout in seconds (default: 45)
   *   scrollCycles?: number - Scroll cycles for discovery (default: 10)
   * }
   */
  app.post("/api/fuel/discover", async (req, res) => {
    try {
      const { lat, lon, sweepRadius, discoveryRadius, gridSpacing, timeout, scrollCycles } =
        req.body;

      if (typeof lat !== "number" || typeof lon !== "number") {
        return res.status(400).json({
          error: "lat and lon are required and must be numbers",
        });
      }

      const result = await triggerDiscovery({
        dbPath,
        lat,
        lon,
        sweepRadius,
        discoveryRadius,
        gridSpacing,
        timeout,
        scrollCycles,
      });

      res.json({
        success: true,
        result: result.result,
        warnings: result.stderr,
      });
    } catch (error) {
      console.error("[FuelPipeline] Discovery failed:", error);
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  });

  /**
   * POST /api/fuel/extract
   * Trigger fuel extraction worker
   *
   * Body: {
   *   batchSize?: number - Max seeds to process (default: 50)
   * }
   */
  app.post("/api/fuel/extract", async (req, res) => {
    try {
      const { batchSize } = req.body;

      const result = await triggerFuelExtraction({
        dbPath,
        batchSize,
      });

      res.json({
        success: true,
        result: result.result,
        warnings: result.stderr,
      });
    } catch (error) {
      console.error("[FuelPipeline] Extraction failed:", error);
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  });

  /**
   * POST /api/fuel/pipeline
   * Run full pipeline: discovery + extraction
   *
   * Body: {
   *   lat: number (required) - Center latitude
   *   lon: number (required) - Center longitude
   *   sweepRadius?: number (default: 50)
   *   discoveryRadius?: number (default: 5)
   *   gridSpacing?: number (default: 10)
   *   batchSize?: number (default: 50)
   * }
   */
  app.post("/api/fuel/pipeline", async (req, res) => {
    try {
      const {
        lat,
        lon,
        sweepRadius,
        discoveryRadius,
        gridSpacing,
        timeout,
        scrollCycles,
        batchSize,
      } = req.body;

      if (typeof lat !== "number" || typeof lon !== "number") {
        return res.status(400).json({
          error: "lat and lon are required and must be numbers",
        });
      }

      const result = await runFullPipeline({
        dbPath,
        lat,
        lon,
        sweepRadius,
        discoveryRadius,
        gridSpacing,
        timeout,
        scrollCycles,
        batchSize,
      });

      res.json({
        success: true,
        result,
      });
    } catch (error) {
      console.error("[FuelPipeline] Full pipeline failed:", error);
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  });

  /**
   * GET /api/fuel/status
   * Check pipeline status (pending seeds, recent logs)
   */
  app.get("/api/fuel/status", async (req, res) => {
    try {
      // Quick DB query for status
      const Database = await import("better-sqlite3");
      const db = new Database.default(dbPath);

      const pendingSeeds = db
        .prepare("SELECT COUNT(*) as count FROM fuel_seed_queue WHERE queue_status = 'pending'")
        .get();

      const recentLogs = db
        .prepare(
          `SELECT fuel_log_id, outcome_state, diesel_price, gasoline_price, fetched_at_utc
           FROM fuel_logs
           ORDER BY fetched_at_utc DESC
           LIMIT 5`
        )
        .all();

      const recentEvents = db
        .prepare(
          `SELECT sync_event_id, event_type, entity_ref, occurred_at_utc
           FROM sync_events
           ORDER BY occurred_at_utc DESC
           LIMIT 5`
        )
        .all();

      db.close();

      res.json({
        success: true,
        status: {
          pendingSeeds: pendingSeeds.count,
          recentLogs,
          recentEvents,
        },
      });
    } catch (error) {
      console.error("[FuelPipeline] Status check failed:", error);
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  });

  console.log("[FuelPipeline] Routes registered:");
  console.log("  POST /api/fuel/discover");
  console.log("  POST /api/fuel/extract");
  console.log("  POST /api/fuel/pipeline");
  console.log("  GET  /api/fuel/status");
}
