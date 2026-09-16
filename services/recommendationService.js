/**
 * NagaGuno - Recommendation Service (Node.js)
 * Calls the Python Flask Recommendation API from your Express backend.
 *
 * Usage:
 *   const recService = require('./services/recommendationService');
 *   const result = await recService.recommendAll({ buyer_id: 'B001' });
 */

const axios = require("axios");

// 127.0.0.1, not "localhost" -- same IPv6/IPv4 mismatch as
// demandForecastService.js. Normalizing here (not just in the default)
// means this is fixed even if .env has an explicit REC_API_URL from the
// template. Kept for the /health and /model-info diagnostics even though
// /all no longer routes through Flask.
const REC_API_URL = (process.env.REC_API_URL || "http://127.0.0.1:5002").replace('://localhost', '://127.0.0.1');

const post = async (endpoint, body) => {
  try {
    const response = await axios.post(`${REC_API_URL}${endpoint}`, body, {
      headers: { "Content-Type": "application/json" },
      timeout: 12000,
    });
    return { success: true, data: response.data };
  } catch (error) {
    return {
      success: false,
      error: error.response?.data?.error || error.message || "Recommendation API unavailable",
    };
  }
};

/**
 * Get product recommendations for a buyer.
 * @param {Object} params
 * @param {string} params.buyer_id
 * @param {number} [params.top_n=10]
 * @param {number} [params.cb_weight=0.4]
 * @param {number} [params.cf_weight=0.6]
 * @param {string} [params.filter_category]   - e.g. "Vegetables"
 * @param {boolean} [params.filter_organic]
 */
async function recommendProducts(params) {
  return post("/recommend/products", params);
}

/**
 * Get farmer recommendations for a buyer.
 * @param {Object} params
 * @param {string} params.buyer_id
 * @param {number} [params.top_n=8]
 * @param {string} [params.filter_barangay]
 * @param {boolean} [params.filter_organic]
 * @param {string} [params.filter_category]
 */
async function recommendFarmers(params) {
  return post("/recommend/farmers", params);
}

/**
 * Get both product and farmer recommendations in one call.
 * @param {Object} params
 * @param {string} params.buyer_id
 * @param {number} [params.top_n_products=10]
 * @param {number} [params.top_n_farmers=5]
 * @param {string} [params.filter_category]
 */
async function recommendAll(params) {
  return post("/recommend/all", params);
}

/**
 * Get similar products to a given product (for 'You may also like').
 * @param {string} productId
 * @param {number} [topN=8]
 */
async function similarProducts(productId, topN = 8) {
  return post("/recommend/similar-products", { product_id: productId, top_n: topN });
}

/**
 * Real content-based scoring for real, live products -- distinct
 * from recommendProducts/recommendAll above, which only know about
 * the synthetic training snapshot. See rec_app.py's
 * /score/live-products for the full reasoning.
 * @param {string[]} queryCategories
 * @param {Array<{product_id: string, name: string, category: string, unit: string}>} products
 */
async function scoreLiveProducts(queryCategories, products) {
  return post("/score/live-products", { query_categories: queryCategories, products });
}

/**
 * Health check for the recommendation API.
 */
async function healthCheck() {
  try {
    const response = await axios.get(`${REC_API_URL}/health`, { timeout: 5000 });
    return response.data;
  } catch {
    return { status: "offline", models_loaded: false };
  }
}

/**
 * Get model info: categories, total products/farmers, etc.
 */
async function getModelInfo() {
  try {
    const response = await axios.get(`${REC_API_URL}/model-info`, { timeout: 5000 });
    return { success: true, data: response.data };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

module.exports = {
  recommendProducts,
  recommendFarmers,
  recommendAll,
  similarProducts,
  scoreLiveProducts,
  healthCheck,
  getModelInfo,
};