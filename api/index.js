import express from 'express';
import puppeteer from 'puppeteer';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(cors());
app.use(express.json());

// Serve static files from public directory
app.use(express.static(path.join(__dirname, '../public')));

// Store active scans
const activeScans = new Map();

app.post('/api/scan', async (req, res) => {
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
  scanWebsite(url, scanId);
  
  res.json({ scanId, status: 'started' });
});

app.get('/api/scan/:scanId', (req, res) => {
  const { scanId } = req.params;
  const scan = activeScans.get(scanId);
  
  if (!scan) {
    return res.status(404).json({ error: 'Scan not found' });
  }
  
  res.json(scan);
});

// Root route to serve the frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Add your scanning function here (copy from your server.js)
async function scanWebsite(baseUrl, scanId) {
  const scan = activeScans.get(scanId);
  
  const addLog = (message, type = 'info') => {
    const logEntry = {
      timestamp: new Date().toISOString(),
      message,
      type
    };
    scan.logs.push(logEntry);
    
    if (scan.logs.length > 50) {
      scan.logs = scan.logs.slice(-50);
    }
  };
  
  try {
    addLog(`🚀 Starting scan for ${baseUrl}`, 'info');
    
    const browser = await puppeteer.launch({
      headless: "new",
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--disable-web-security'
      ]
    });
    
    // Simplified scanning for Vercel (due to time limits)
    const page = await browser.newPage();
    await page.goto(baseUrl);
    
    const links = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('a[href]'))
        .map(a => a.href)
        .filter(href => href && !href.startsWith('#'))
        .slice(0, 10); // Limit for Vercel
    });
    
    addLog(`Found ${links.length} links to test`, 'info');
    
    const brokenLinks = [];
    for (const link of links) {
      try {
        const response = await fetch(link, { method: 'HEAD' });
        if (response.status >= 400) {
          brokenLinks.push({ link, status: response.status });
        }
      } catch (error) {
        brokenLinks.push({ link, status: 'ERROR', error: error.message });
      }
    }
    
    await browser.close();
    
    scan.status = 'completed';
    scan.progress = 100;
    scan.results = {
      summary: {
        totalPages: 1,
        totalLinks: links.length,
        brokenLinksCount: brokenLinks.length,
        brokenButtonsCount: 0,
        authIssuesCount: 0
      },
      issues: {
        brokenLinks,
        brokenButtons: [],
        authErrors: [],
        workingLinks: links.filter(link => 
          !brokenLinks.some(broken => broken.link === link)
        ).map(link => ({ link }))
      }
    };
    
    addLog(`✅ Scan completed! Found ${brokenLinks.length} broken links`, 'success');
    
  } catch (error) {
    addLog(`💥 Scan failed: ${error.message}`, 'error');
    scan.status = 'error';
    scan.error = error.message;
  }
}

export default app;