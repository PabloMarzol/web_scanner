// api/scan.js
import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';

// Simple in-memory storage (for demo purposes)
const activeScans = new Map();

export default async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    if (req.method === 'POST') {
      const { url, scanId } = req.body;
      
      console.log('Received scan request:', { url, scanId });
      
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
      
      // Start scanning immediately (not in background due to Vercel limitations)
      scanWebsiteSync(url, scanId, scan).catch(error => {
        console.error('Scan error:', error);
        scan.status = 'error';
        scan.error = error.message;
      });
      
      return res.status(200).json({ scanId, status: 'started' });
    }

    if (req.method === 'GET') {
      const { scanId } = req.query;
      
      if (!scanId) {
        return res.status(400).json({ error: 'scanId is required' });
      }
      
      const scan = activeScans.get(scanId);
      
      if (!scan) {
        return res.status(404).json({ error: 'Scan not found' });
      }
      
      return res.status(200).json(scan);
    }

    return res.status(405).json({ error: 'Method not allowed' });
    
  } catch (error) {
    console.error('API Error:', error);
    return res.status(500).json({ error: 'Internal server error: ' + error.message });
  }
}

async function scanWebsiteSync(baseUrl, scanId, scan) {
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
    scan.progress = 10;
    
    // Configure chromium for Vercel
    browser = await puppeteer.launch({
      args: [
        ...chromium.args,
        '--no-sandbox',
        '--disable-setuid-sandbox'
      ],
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
      ignoreHTTPSErrors: true,
    });
    
    addLog(`✅ Browser launched successfully`, 'info');
    scan.progress = 30;
    
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
    
    addLog(`📄 Navigating to ${baseUrl}`, 'info');
    
    const response = await page.goto(baseUrl, { 
      waitUntil: 'domcontentloaded',
      timeout: 20000
    });
    
    if (!response || response.status() >= 400) {
      throw new Error(`Page failed to load: ${response?.status() || 'No response'}`);
    }
    
    addLog(`✅ Page loaded (Status: ${response.status()})`, 'success');
    scan.progress = 50;
    
    await page.waitForTimeout(1000);
    
    // Extract links
    const links = await page.evaluate((baseUrl) => {
      try {
        const allLinks = Array.from(document.querySelectorAll('a[href]'));
        return allLinks
          .map(link => {
            const href = link.getAttribute('href');
            if (!href) return null;
            
            try {
              if (href.startsWith('/')) {
                return new URL(href, baseUrl).href;
              } else if (href.startsWith('http')) {
                return href;
              } else {
                return new URL(href, baseUrl).href;
              }
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
          .slice(0, 5); // Limit to 5 links for speed
      } catch (e) {
        console.error('Error extracting links:', e);
        return [];
      }
    }, baseUrl);
    
    addLog(`🔗 Found ${links.length} links to test`, 'info');
    scan.progress = 70;
    
    const brokenLinks = [];
    const workingLinks = [];
    
    // Test links quickly
    for (let i = 0; i < links.length; i++) {
      const link = links[i];
      
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 2000);
        
        const linkResponse = await fetch(link, { 
          method: 'HEAD',
          signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        
        if (!linkResponse.ok) {
          brokenLinks.push({
            page: baseUrl,
            link,
            status: linkResponse.status,
            error: linkResponse.statusText
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
    
    scan.progress = 90;
    
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
    
    addLog(`✅ Scan completed! Found ${brokenLinks.length} broken links`, 'success');
    
  } catch (error) {
    addLog(`💥 Scan failed: ${error.message}`, 'error');
    scan.status = 'error';
    scan.error = error.message;
    console.error('Scan error:', error);
  } finally {
    if (browser) {
      try {
        await browser.close();
        addLog(`🔒 Browser closed`, 'info');
      } catch (e) {
        console.error('Error closing browser:', e);
      }
    }
  }
}