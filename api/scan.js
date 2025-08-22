// api/scan.js
export default async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Simple in-memory storage
  const activeScans = new Map();

  try {
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
      
      // For now, just return a simple success response
      const scan = {
        id: scanId,
        status: 'completed', // Immediate completion for testing
        progress: 100,
        url,
        startTime: new Date(),
        logs: [
          { timestamp: new Date().toISOString(), message: `✅ Test scan completed for ${url}`, type: 'success' }
        ],
        results: {
          summary: {
            totalPages: 1,
            totalLinks: 0,
            totalButtons: 0,
            brokenLinksCount: 0,
            brokenButtonsCount: 0,
            authIssuesCount: 0,
            missingResourcesCount: 0,
            pagesWithErrors: 0
          },
          issues: {
            brokenLinks: [],
            brokenButtons: [],
            authErrors: [],
            missingResources: [],
            reactWarnings: [],
            jsErrors: [],
            pageErrors: [],
            workingLinks: [],
            workingButtons: []
          },
          pages: [url]
        }
      };
      
      return res.status(200).json({ scanId, status: 'started', scan });
    }

    if (req.method === 'GET') {
      const { scanId } = req.query;
      
      if (!scanId) {
        return res.status(400).json({ error: 'scanId is required' });
      }
      
      // For testing, return a completed scan
      const scan = {
        id: scanId,
        status: 'completed',
        progress: 100,
        logs: [
          { timestamp: new Date().toISOString(), message: '✅ Test scan completed', type: 'success' }
        ],
        results: {
          summary: {
            totalPages: 1,
            totalLinks: 0,
            totalButtons: 0,
            brokenLinksCount: 0,
            brokenButtonsCount: 0,
            authIssuesCount: 0
          },
          issues: {
            brokenLinks: [],
            brokenButtons: [],
            authErrors: [],
            missingResources: [],
            workingLinks: [],
            workingButtons: []
          }
        }
      };
      
      return res.status(200).json(scan);
    }

    return res.status(405).json({ error: 'Method not allowed' });
    
  } catch (error) {
    console.error('API Error:', error);
    return res.status(500).json({ error: 'Internal server error: ' + error.message });
  }
}