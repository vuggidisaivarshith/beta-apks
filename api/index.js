import { handleApi } from '../server.js';

export default async function handler(req, res) {
  const urlObj = new URL(req.url || '/api/health', `http://${req.headers.host || 'localhost'}`);
  return handleApi(req, res, urlObj.pathname);
}
