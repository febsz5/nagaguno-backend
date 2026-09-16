/**
 * NagaGuno - Demand Forecast Service (Node.js)
 * Calls the Python Flask ML API from your Express backend.
 *
 * Usage in your routes:
 *   const demandForecast = require('./services/demandForecastService');
 *   const result = await demandForecast.predictDemand({ ... });
 */

const axios = require("axios");

// 127.0.0.1, not "localhost" -- on Windows, Node can resolve "localhost" to
// the IPv6 loopback (::1) first, which Flask's app.run() doesn't listen on
// by default (IPv4 only). That mismatch causes ECONNREFUSED even though
// the Flask server is genuinely running and reachable via IPv4.
// Normalizing here (not just in the default) means this is fixed even if
// .env has an explicit ML_API_URL=http://localhost:5001 from the template.
const ML_API_URL = (process.env.ML_API_URL || "http://127.0.0.1:5001").replace('://localhost', '://127.0.0.1');

/**
 * Predict demand quantity and price for a single crop.
 *
 * @param {Object} params
 * @param {string} params.date             - "YYYY-MM-DD"
 * @param {string} params.crop_name        - e.g. "Kamatis (Tomato)"
 * @param {string} params.weather_condition - "Sunny" | "Rainy" | "Cloudy" | "Typhoon"
 * @param {string} params.market_type      - "Public Market" | "Farm Gate" | "Supermarket" | "Online (NagaGuno)"
 * @param {number} [params.is_holiday]     - 0 or 1 (optional)
 *
 * @returns {Promise<Object>} prediction result
 */
async function predictDemand(params) {
  try {
    const response = await axios.post(
      `${ML_API_URL}/predict-demand`,
      params,
      { headers: { "Content-Type": "application/json" }, timeout: 10000 }
    );
    return { success: true, data: response.data };
  } catch (error) {
    const message =
      error.response?.data?.error || error.message || "ML API unavailable";
    return { success: false, error: message };
  }
}

/**
 * Predict demand for multiple crops/dates in one request.
 *
 * @param {Array<Object>} predictions - array of prediction param objects
 * @returns {Promise<Object>}
 */
async function predictDemandBatch(predictions) {
  try {
    const response = await axios.post(
      `${ML_API_URL}/predict-demand/batch`,
      { predictions },
      { headers: { "Content-Type": "application/json" }, timeout: 15000 }
    );
    return { success: true, data: response.data };
  } catch (error) {
    const message =
      error.response?.data?.error || error.message || "ML API unavailable";
    return { success: false, error: message };
  }
}

/**
 * Check if the ML API is running and models are loaded.
 */
async function healthCheck() {
  try {
    const response = await axios.get(`${ML_API_URL}/health`, { timeout: 5000 });
    return response.data;
  } catch {
    return { status: "offline", models_loaded: false };
  }
}

/**
 * Get available crops, weather types, and market types from the ML API.
 */
async function getModelInfo() {
  try {
    const response = await axios.get(`${ML_API_URL}/model-info`, { timeout: 5000 });
    return { success: true, data: response.data };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

module.exports = { predictDemand, predictDemandBatch, healthCheck, getModelInfo };