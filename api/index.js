// api/index.js (if using @sparticuz/chromium)
import express from 'express';
import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

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

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

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
  
  let browser = null;
  
  try {
    addLog(`🚀 Starting scan for ${baseUrl}`, 'info');
    
    // Configure chromium for Vercel
    const executablePath = await chromium.executablePath();
    
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath,
      headless: chromium.headless,
      ignoreHTTPSErrors: true,
    });
    
    addLog(`✅ Browser launched successfully`, 'info');
    
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
    
    addLog(`📄 Navigating to ${baseUrl}`, 'info');
    
    const response = await page.goto(baseUrl, { 
      waitUntil: 'domcontentloaded',
      timeout: 25000 // Reduced timeout for Vercel
    });
    
    if (!response || response.status() >= 400) {
      throw new Error(`Page failed to load: ${response?.status() || 'No response'}`);
    }
    
    addLog(`✅ Page loaded successfully (Status: ${response.status()})`, 'info');
    
    await page.waitForTimeout(1000);
    
    // Extract links
    const links = await page.evaluate((baseUrl) => {
      const allLinks = Array.from(document.querySelectorAll('a[href]'));
      return allLinks
        .map(link => {
          try {
            let href = link.getAttribute('href');
            if (!href) return null;
            
            if (href.startsWith('/')) {
              const baseUrlObj = new URL(baseUrl);
              href = baseUrlObj.origin + href;
            } else if (!href.startsWith('http')) {
              href = new URL(href, baseUrl).href;
            }
            
            return href;
          } catch {
            return null;
          }
        })
        .filter(href => {
          if (!href || href.startsWith('#') || href.startsWith('javascript:') || 
              href.startsWith('mailto:') || href.startsWith('tel:')) return false;
          
          try {
            const linkUrl = new URL(href);
            const baseUrlObj = new URL(baseUrl);
            return linkUrl.hostname === baseUrlObj.hostname;
          } catch {
            return false;
          }
        })
        .filter((href, index, array) => array.indexOf(href) === index)
        .slice(0, 10); // Limit to 10 links for Vercel
    }, baseUrl);
    
    addLog(`🔗 Found ${links.length} links to test`, 'info');
    
    const brokenLinks = [];
    const workingLinks = [];
    
    for (let i = 0; i < links.length; i++) {
      const link = links[i];
      
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3000);
        
        const response = await fetch(link, { 
          method: 'HEAD',
          signal: controller.signal,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
        }).catch(() => 
          fetch(link, { 
            signal: controller.signal,
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
          })
        );
        
        clearTimeout(timeoutId);
        
        if (!response.ok) {
          brokenLinks.push({
            page: baseUrl,
            link,
            status: response.status,
            error: response.statusText
          });
        } else {
          workingLinks.push({ page: baseUrl, link });
        }
      } catch (error) {
        if (error.name !== 'AbortError') {
          brokenLinks.push({
            page: baseUrl,
            link,
            status: 'ERROR',
            error: error.message
          });
        }
      }
    }
    
    scan.status = 'completed';
    scan.progress = 100;
    scan.results = {
      summary: {
        totalPages: 1,
        totalLinks: links.length,
        totalButtons: 0,
        brokenLinksCount: brokenLinks.length,
        brokenButtonsCount: 0,
        authIssuesCount: 0,
        missingResourcesCount: 0,
        pagesWithErrors: 0
      },
      issues: {
        brokenLinks,
        brokenButtons: [],
        authErrors: [],
        missingResources: [],
        reactWarnings: [],
        jsErrors: [],
        pageErrors: [],
        workingLinks,
        workingButtons: []
      },
      pages: [baseUrl]
    };
    
    addLog(`✅ Scan completed! Found ${brokenLinks.length} broken links out of ${links.length} total`, 'success');
    
  } catch (error) {
    addLog(`💥 Scan failed: ${error.message}`, 'error');
    scan.status = 'error';
    scan.error = error.message;
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (e) {
        // Ignore close errors
      }
    }
  }
}

export default app;