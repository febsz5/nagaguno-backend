/**
 * NagaGuno - Demand Forecast Routes
 * Place this file in your backend/routes/ folder.
 *
 * Mount in server.js:
 *   const demandRoutes = require('./routes/demand');
 *   app.use('/api/demand', demandRoutes);
 */

const express = require("express");
const router = express.Router();
const demandForecast = require("../services/demandForecastService");

// ─────────────────────────────────────────────
// POST /api/demand/predict
// Predict demand & price for a single crop
// ─────────────────────────────────────────────
router.post("/predict", async (req, res) => {
  const { date, crop_name, weather_condition, market_type, is_holiday } = req.body;

  if (!date || !crop_name || !weather_condition || !market_type) {
    return res.status(400).json({
      success: false,
      message: "Required fields: date, crop_name, weather_condition, market_type",
    });
  }

  const result = await demandForecast.predictDemand({
    date,
    crop_name,
    weather_condition,
    market_type,
    is_holiday: is_holiday ?? 0,
  });

  if (!result.success) {
    return res.status(503).json({ success: false, message: result.error });
  }

  return res.status(200).json({ success: true, prediction: result.data });
});

// ─────────────────────────────────────────────
// POST /api/demand/predict/batch
// Predict demand for multiple crops at once
// ─────────────────────────────────────────────
router.post("/predict/batch", async (req, res) => {
  const { predictions } = req.body;

  if (!Array.isArray(predictions) || predictions.length === 0) {
    return res.status(400).json({
      success: false,
      message: "Provide a non-empty 'predictions' array",
    });
  }

  const result = await demandForecast.predictDemandBatch(predictions);

  if (!result.success) {
    return res.status(503).json({ success: false, message: result.error });
  }

  return res.status(200).json({ success: true, ...result.data });
});

// ─────────────────────────────────────────────
// GET /api/demand/health
// Check if ML service is running
// ─────────────────────────────────────────────
router.get("/health", async (req, res) => {
  const status = await demandForecast.healthCheck();
  const httpStatus = status.status === "ok" ? 200 : 503;
  return res.status(httpStatus).json(status);
});

// ─────────────────────────────────────────────
// GET /api/demand/model-info
// Returns valid crops, weather, market types
// ─────────────────────────────────────────────
router.get("/model-info", async (req, res) => {
  const result = await demandForecast.getModelInfo();
  if (!result.success) {
    return res.status(503).json({ success: false, message: result.error });
  }
  return res.status(200).json({ success: true, ...result.data });
});

module.exports = router;