// utils/storageService.js
// Single place for uploading files to Supabase Storage. Existing routes
// (products.js, orders.js, agreement.js, cropPlans.js, profile.js) each
// instantiate their own Supabase client inline per-request — this is the
// same idea, but the client is created once, lazily, on first use — not at
// module load (module-load instantiation is what caused the crash-on-boot
// bug fixed in middleware/auth.js: it throws immediately if
// SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY are missing, even before this
// helper is ever called).
const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');

let _client = null;
function getClient() {
  if (!_client) {
    _client = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { realtime: { transport: WebSocket } } // Node <22 has no native WebSocket, which
                                              // the Realtime client requires internally
                                              // even when unused -- this polyfills it.
    );
  }
  return _client;
}

/**
 * Uploads a buffer to a Supabase Storage bucket and returns the storage
 * path (not a public URL — use getSignedUrl for private buckets like
 * kyc-documents, or getPublicUrl for public ones like nagaguno-uploads).
 */
async function uploadFile(bucket, filePath, buffer, mimetype) {
  const { error } = await getClient()
    .storage.from(bucket)
    .upload(filePath, buffer, { contentType: mimetype, upsert: true });
  if (error) throw new Error(`Upload to ${bucket} failed: ${error.message}`);
  return filePath;
}

function getPublicUrl(bucket, filePath) {
  const { data } = getClient().storage.from(bucket).getPublicUrl(filePath);
  return data.publicUrl;
}

async function getSignedUrl(bucket, filePath, expiresInSeconds = 300) {
  if (!filePath) return null;
  const { data, error } = await getClient()
    .storage.from(bucket)
    .createSignedUrl(filePath, expiresInSeconds);
  if (error) throw new Error(`Signed URL for ${bucket}/${filePath} failed: ${error.message}`);
  return data.signedUrl;
}

module.exports = { uploadFile, getPublicUrl, getSignedUrl };
