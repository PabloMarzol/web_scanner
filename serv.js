// server.js - Render optimized
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
app.use(express.static('public'));

// Store active scans
const activeScans = new Map();

// Utility function for delays (replaces deprecated waitForTimeout)
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Add health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    activeScans: activeScans.size,
    memory: process.memoryUsage(),
    uptime: process.uptime()
  });
});

app.post('/api/scan', async (req, res) => {
  try {
    const { url, scanId } = req.body;
    
    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }
    
    // Validate URL
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
      results: null
    };
    
    activeScans.set(scanId, scan);
    
    // Start scanning in background with better error handling
    scanWebsite(url, scanId).catch(error => {
      console.error(`❌ Background scan error for ${scanId}:`, error);
      const failedScan = activeScans.get(scanId);
      if (failedScan) {
        failedScan.status = 'error';
        failedScan.error = error.message;
        failedScan.progress = 0;
      }
    });
    
    res.json({ scanId, status: 'started' });
  } catch (error) {
    console.error('❌ POST /api/scan error:', error);
    res.status(500).json({ error: 'Internal server error', message: error.message });
  }
});

app.get('/api/scan/:scanId', (req, res) => {
  try {
    const { scanId } = req.params;
    const scan = activeScans.get(scanId);
    
    if (!scan) {
      return res.status(404).json({ error: 'Scan not found' });
    }
    
    res.json(scan);
  } catch (error) {
    console.error('❌ GET /api/scan/:scanId error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ADDED: Also handle query parameter route for frontend compatibility
app.get('/api/scan', (req, res) => {
  try {
    const { scanId } = req.query;
    
    if (!scanId) {
      return res.status(400).json({ error: 'scanId query parameter is required' });
    }
    
    const scan = activeScans.get(scanId);
    
    if (!scan) {
      return res.status(404).json({ error: 'Scan not found' });
    }
    
    res.json(scan);
  } catch (error) {
    console.error('❌ GET /api/scan error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

async function scanWebsite(baseUrl, scanId) {
  let browser;
  const scan = activeScans.get(scanId);
  
  if (!scan) {
    console.log(`❌ Scan ${scanId} not found in activeScans`);
    return;
  }
  
  // Add logs array to store real-time updates
  scan.logs = [];
  
  // Helper function to add logs
  const addLog = (message, type = 'info') => {
    const logEntry = {
      timestamp: new Date().toISOString(),
      message,
      type
    };
    scan.logs.push(logEntry);
    console.log(`[${scanId}] ${message}`);
    
    // Keep only last 30 logs to save memory
    if (scan.logs.length > 30) {
      scan.logs = scan.logs.slice(-30);
    }
  };
  
  try {
    addLog(`🚀 Starting scan for ${baseUrl}`, 'info');
    addLog(`💾 Memory before browser launch: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`, 'info');
    
    if (process.env.NODE_ENV === 'production') {
      // Production (Render) - use chromium with memory optimizations
      addLog(`📦 Using Render Chromium with memory optimizations`, 'info');
      
      // Configure chromium for lower memory usage
      const args = [
        ...chromium.args,
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--disable-web-security',
        '--disable-features=VizDisplayCompositor',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-features=TranslateUI',
        '--disable-ipc-flooding-protection',
        '--disable-hang-monitor',
        '--disable-client-side-phishing-detection',
        '--disable-component-update',
        '--disable-default-apps',
        // Memory optimizations for Render
        '--memory-pressure-off',
        '--max_old_space_size=1024',
        '--disable-background-networking',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
        '--disable-features=TranslateUI,BlinkGenPropertyTrees',
        '--disable-extensions',
        '--disable-plugins',
        '--disable-default-apps',
        '--disable-sync'
      ];
      
      browser = await puppeteer.launch({
        args,
        defaultViewport: { width: 1280, height: 720 }, // Smaller viewport to save memory
        executablePath: await chromium.executablePath(),
        headless: chromium.headless,
        ignoreHTTPSErrors: true,
        timeout: 45000 // Reduced timeout for Render
      });
    } else {
      // Local development - use full puppeteer
      addLog(`💻 Using local Puppeteer (dev mode)`, 'info');
      const { default: puppeteerFull } = await import('puppeteer');
      browser = await puppeteerFull.launch({
        headless: "new",
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-web-security'
        ],
        timeout: 60000
      });
    }
    
    addLog(`✅ Browser launched successfully`, 'success');
    addLog(`💾 Memory after browser launch: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`, 'info');
    
    const visitedPages = new Set();
    const allIssues = {
      brokenLinks: [],
      brokenButtons: [],
      authErrors: [],
      missingResources: [],
      reactWarnings: [],
      jsErrors: [],
      pageErrors: [],
      workingLinks: [],
      workingButtons: []
    };
    
    const pagesToCrawl = ['/'];
    let processedPages = 0;
    
    // Update progress
    const updateProgress = () => {
      scan.progress = Math.min(90, (processedPages / Math.max(visitedPages.size + pagesToCrawl.length, 1)) * 100);
      scan.status = 'running';
    };
    
    async function crawlPage(pageUrl) {
        if (visitedPages.has(pageUrl)) return;
        visitedPages.add(pageUrl);
        processedPages++;
        updateProgress();
        
        const fullUrl = pageUrl.startsWith('http') ? pageUrl : baseUrl + pageUrl;
        addLog(`📄 Scanning: ${fullUrl}`, 'info');
        
        let page;
        try {
            page = await browser.newPage();
            
            // Optimize page for memory usage
            await page.setViewport({ width: 1280, height: 720 });
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
            
            // Disable images and CSS to save memory and speed up loading
            if (process.env.NODE_ENV === 'production') {
              await page.setRequestInterception(true);
              page.on('request', (req) => {
                if(req.resourceType() == 'stylesheet' || req.resourceType() == 'image' || req.resourceType() == 'font'){
                    req.abort();
                } else {
                    req.continue();
                }
              });
            }
            
            // Set shorter timeouts for production
            const timeout = process.env.NODE_ENV === 'production' ? 20000 : 30000;
            page.setDefaultTimeout(timeout);
            page.setDefaultNavigationTimeout(timeout);
            
            const response = await page.goto(fullUrl, { 
              timeout,
              waitUntil: 'domcontentloaded'
            });
            
            if (!response || response.status() >= 400) {
              addLog(`❌ Page failed to load: ${fullUrl} (Status: ${response?.status() || 'No response'})`, 'error');
              allIssues.pageErrors.push({
                  url: fullUrl,
                  status: response?.status() || 'No response',
                  error: 'Page failed to load'
              });
              return;
            }
            
            // Shorter wait time for production
            const waitTime = process.env.NODE_ENV === 'production' ? 1000 : 2000;
            await new Promise(resolve => setTimeout(resolve, waitTime));
            addLog(`✅ Page loaded successfully`, 'success');
            
            // Test fewer links in production to save time and memory
            const linkLimit = process.env.NODE_ENV === 'production' ? 5 : 10;
            
            // Test links with better error handling
            let links = [];
            try {
              links = await page.evaluate((baseUrl, limit) => {
                  const allLinks = Array.from(document.querySelectorAll('a[href]'));
                  return allLinks
                  .map(link => link.getAttribute('href'))
                  .filter(href => {
                      if (!href || href.startsWith('#') || href.startsWith('javascript:') || 
                          href.startsWith('mailto:') || href.startsWith('tel:')) return false;
                      
                      try {
                        if (href.startsWith('/')) {
                            const baseUrlObj = new URL(baseUrl);
                            href = baseUrlObj.origin + href;
                        } else if (!href.startsWith('http')) {
                            href = new URL(href, baseUrl).href;
                        }
                        
                        const linkUrl = new URL(href);
                        const baseUrlObj = new URL(baseUrl);
                        return linkUrl.hostname === baseUrlObj.hostname;
                      } catch {
                          return false;
                      }
                  })
                  .filter((href, index, array) => array.indexOf(href) === index)
                  .slice(0, limit); // Limit in the browser
              }, baseUrl, linkLimit);
            } catch (error) {
              addLog(`❌ Error extracting links: ${error.message}`, 'error');
              links = [];
            }
            
            addLog(`🔗 Found ${links.length} links to test`, 'info');
            
            // Test each link with shorter timeouts
            let brokenLinksOnPage = 0;
            for (const link of links) {
              try {
                  const controller = new AbortController();
                  const linkTimeout = process.env.NODE_ENV === 'production' ? 5000 : 8000;
                  const timeoutId = setTimeout(() => controller.abort(), linkTimeout);
                  
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
                      brokenLinksOnPage++;
                      allIssues.brokenLinks.push({
                          page: fullUrl,
                          link,
                          status: response.status,
                          error: response.statusText
                      });
                  } else {
                      allIssues.workingLinks.push({ page: fullUrl, link });
                  }
              } catch (error) {
                  if (error.name !== 'AbortError') {
                      brokenLinksOnPage++;
                      allIssues.brokenLinks.push({
                          page: fullUrl,
                          link,
                          status: 'ERROR',
                          error: error.message
                      });
                  }
              }
            }
            
            if (brokenLinksOnPage > 0) {
              addLog(`❌ Found ${brokenLinksOnPage} broken links`, 'warning');
            }
            
            // Skip button testing in production to save time and memory
            if (process.env.NODE_ENV !== 'production') {
              // Button testing logic here (only for local development)
              addLog(`⚠️ Skipping button tests in production to save resources`, 'info');
            }
            
        } catch (error) {
            addLog(`❌ Error crawling ${fullUrl}: ${error.message}`, 'error');
            allIssues.pageErrors.push({
                url: fullUrl,
                error: error.message
            });
        } finally {
            if (page) {
                try {
                    await page.close();
                } catch (e) {
                    console.error('Error closing page:', e);
                }
            }
        }
        
        addLog(`✅ Completed: ${fullUrl}`, 'success');
    }
    
    // Limit pages for production
    const pageLimit = process.env.NODE_ENV === 'production' ? 3 : 5;
    
    // Crawl pages
    while (pagesToCrawl.length > 0 && visitedPages.size < pageLimit) {
      const currentUrl = pagesToCrawl.shift();
      await crawlPage(currentUrl);
      
      // Add memory check
      const memUsage = process.memoryUsage().heapUsed / 1024 / 1024;
      if (memUsage > 400) { // Stop if using more than 400MB
        addLog(`⚠️ Memory usage high (${Math.round(memUsage)}MB), stopping scan`, 'warning');
        break;
      }
    }
    
    // Generate summary
    const summary = {
      totalPages: visitedPages.size,
      totalLinks: allIssues.brokenLinks.length + allIssues.workingLinks.length,
      totalButtons: allIssues.brokenButtons.length + allIssues.workingButtons.length,
      brokenLinksCount: allIssues.brokenLinks.length,
      brokenButtonsCount: allIssues.brokenButtons.length,
      authIssuesCount: allIssues.authErrors.length,
      missingResourcesCount: allIssues.missingResources.length,
      pagesWithErrors: allIssues.pageErrors.length
    };
    
    scan.status = 'completed';
    scan.progress = 100;
    scan.endTime = new Date();
    scan.results = {
      summary,
      issues: allIssues,
      pages: Array.from(visitedPages)
    };
    
    addLog(`🎉 Scan completed! Scanned ${summary.totalPages} pages, found ${summary.brokenLinksCount} broken links`, 'success');
    
    const finalMemory = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    addLog(`💾 Final memory usage: ${finalMemory}MB`, 'info');
    
  } catch (error) {
    console.error(`💥 Scan ${scanId} failed:`, error);
    addLog(`💥 Scan failed: ${error.message}`, 'error');
    scan.status = 'error';
    scan.error = error.message;
    scan.progress = 0;
  } finally {
    if (browser) {
      try {
        await browser.close();
        addLog(`🔒 Browser closed`, 'info');
      } catch (error) {
        console.error('Error closing browser:', error);
      }
    }
    
    // Force garbage collection if available
    if (global.gc) {
      global.gc();
      addLog(`🗑️ Garbage collection triggered`, 'info');
    }
  }
}

const port = process.env.PORT || 3001;
const host = process.env.NODE_ENV === 'production' ? '0.0.0.0' : 'localhost';

const server = app.listen(port, host, () => {
  const displayHost = host === '0.0.0.0' ? 'localhost' : host;
  console.log(`🚀 WebScan Pro server running on http://${displayHost}:${port}`);
  console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`💾 Initial memory usage: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`);
  
  if (process.env.NODE_ENV !== 'production') {
    console.log(`📱 Local access: http://localhost:${port}`);
  }
});

// Configure timeouts for cloud deployment
server.keepAliveTimeout = 120000; // 2 minutes
server.headersTimeout = 120000; // 2 minutes

// Better error handling for production
process.on('uncaughtException', (err) => {
  console.error('💥 Uncaught Exception:', err);
  // Don't exit in production, just log the error
  if (process.env.NODE_ENV !== 'production') {
    process.exit(1);
  }
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
  // Don't exit in production, just log the error
  if (process.env.NODE_ENV !== 'production') {
    process.exit(1);
  }
});

// Graceful shutdown handlers
process.on('SIGTERM', () => {
  console.log('📤 SIGTERM received, shutting down gracefully...');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('📤 SIGINT received, shutting down gracefully...');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});

// Clean up old scans every 10 minutes to prevent memory leaks
setInterval(() => {
  const now = new Date();
  for (const [scanId, scan] of activeScans.entries()) {
    const age = now - new Date(scan.startTime);
    if (age > 30 * 60 * 1000) { // 30 minutes old
      activeScans.delete(scanId);
      console.log(`🧹 Cleaned up old scan: ${scanId}`);
    }
  }
}, 10 * 60 * 1000);