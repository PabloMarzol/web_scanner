// api/scan.js
import { scanWebsite } from '../lib/scanner.js';

// Store active scans (in production, use a database)
const activeScans = new Map();

export default async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method === 'POST') {
    const { url, scanId } = req.body;
    
    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }
    
    try {
      new URL(url);
    } catch {
      return res.status(400).json({ error: 'Invalid URL format' });
    }
    
    const scan = {
      id: scanId,
      status: 'running',
      progress: 0,
      url,
      startTime: new Date(),
      results: null,
      logs: []
    };
    
    activeScans.set(scanId, scan);
    
    // Start scanning in background
    scanWebsite(url, scanId, activeScans);
    
    return res.json({ scanId, status: 'started' });
  }

  if (req.method === 'GET') {
    const { scanId } = req.query;
    const scan = activeScans.get(scanId);
    
    if (!scan) {
      return res.status(404).json({ error: 'Scan not found' });
    }
    
    return res.json(scan);
  }

  res.status(405).json({ error: 'Method not allowed' });
}