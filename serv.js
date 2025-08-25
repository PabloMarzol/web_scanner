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
    const { url, scanId, options = {} } = req.body;
    
    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }
    
    // Validate URL
    try {
      new URL(url);
    } catch {
      return res.status(400).json({ error: 'Invalid URL format' });
    }
    
    // Scan configuration options
    const scanOptions = {
      maxPages: options.maxPages || (process.env.NODE_ENV === 'production' ? 50 : 100),
      maxLinks: options.maxLinks || 25,
      includeButtons: options.includeButtons !== false, // Default true
      useSitemap: options.useSitemap !== false, // Default true
      timeout: options.timeout || 30000,
      comprehensive: options.comprehensive !== false // Default true for comprehensive scanning
    };
    
    const scan = {
      id: scanId,
      status: 'running',
      progress: 0,
      url,
      options: scanOptions,
      startTime: new Date(),
      results: null
    };
    
    activeScans.set(scanId, scan);
    
    // Start scanning in background with better error handling
    scanWebsite(url, scanId, scanOptions).catch(error => {
      console.error(`❌ Background scan error for ${scanId}:`, error);
      const failedScan = activeScans.get(scanId);
      if (failedScan) {
        failedScan.status = 'error';
        failedScan.error = error.message;
        failedScan.progress = 0;
      }
    });
    
    res.json({ scanId, status: 'started', options: scanOptions });
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

async function scanWebsite(baseUrl, scanId, options = {}) {
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
    
    // Better environment detection - check for Render-specific environment variables
    const isRenderProduction = process.env.RENDER || process.env.RENDER_SERVICE_ID;
    const isLocalProduction = process.env.NODE_ENV === 'production' && !isRenderProduction;
    
    if (isRenderProduction) {
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
      // Local development (including local production mode) - use full puppeteer
      addLog(`💻 Using local Puppeteer (${process.env.NODE_ENV} mode)`, 'info');
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
    
    // Update progress with better calculation for comprehensive scans
    const updateProgress = () => {
      const totalExpected = Math.max(visitedPages.size + pagesToCrawl.length, 10);
      const progressPercent = Math.min(90, (processedPages / totalExpected) * 100);
      scan.progress = progressPercent;
      scan.status = 'running';
      
      // Add progress details to logs every 10 pages
      if (processedPages % 10 === 0 && processedPages > 0) {
        addLog(`📊 Progress: ${processedPages} pages scanned, ${pagesToCrawl.length} in queue`, 'info');
      }
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
            
            // Disable images and CSS to save memory and speed up loading (only on Render)
            if (isRenderProduction) {
              await page.setRequestInterception(true);
              page.on('request', (req) => {
                if(req.resourceType() == 'stylesheet' || req.resourceType() == 'image' || req.resourceType() == 'font'){
                    req.abort();
                } else {
                    req.continue();
                }
              });
            }
            
            // Set timeouts based on environment
            const timeout = isRenderProduction ? 20000 : 30000;
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
            
            // Wait time based on environment
            const waitTime = isRenderProduction ? 1000 : 2000;
            await new Promise(resolve => setTimeout(resolve, waitTime));
            addLog(`✅ Page loaded successfully`, 'success');
            
            // Try to find sitemap.xml for comprehensive page discovery
            if (processedPages === 1) { // Only try on first page
              try {
                const sitemapUrl = new URL('/sitemap.xml', baseUrl).href;
                const sitemapResponse = await fetch(sitemapUrl, { 
                  timeout: 5000,
                  headers: { 'User-Agent': 'Mozilla/5.0 WebScanner Bot' }
                });
                
                if (sitemapResponse.ok) {
                  addLog(`📋 Found sitemap.xml, extracting URLs`, 'info');
                  const sitemapText = await sitemapResponse.text();
                  
                  // Simple regex to extract URLs from sitemap
                  const urlMatches = sitemapText.match(/<loc>(.*?)<\/loc>/g);
                  if (urlMatches) {
                    const sitemapUrls = urlMatches
                      .map(match => match.replace(/<\/?loc>/g, ''))
                      .filter(url => {
                        try {
                          const urlObj = new URL(url);
                          const baseUrlObj = new URL(baseUrl);
                          return urlObj.hostname === baseUrlObj.hostname;
                        } catch {
                          return false;
                        }
                      })
                      .map(url => new URL(url).pathname + new URL(url).search)
                      .filter(path => !visitedPages.has(path) && !pagesToCrawl.includes(path));
                    
                    // Add first 50 sitemap URLs to crawl queue
                    sitemapUrls.slice(0, 50).forEach(path => {
                      pagesToCrawl.push(path);
                    });
                    
                    addLog(`📋 Added ${Math.min(sitemapUrls.length, 50)} URLs from sitemap`, 'success');
                  }
                }
              } catch (error) {
                addLog(`⚠️ Could not fetch sitemap.xml: ${error.message}`, 'warning');
              }
            }
            
            // Enhanced link discovery with configurable limits
            let links = [];
            try {
              links = await page.evaluate((baseUrl, limit) => {
                  const allLinks = Array.from(document.querySelectorAll('a[href]'));
                  const processedLinks = [];
                  
                  for (const link of allLinks) {
                    try {
                      let href = link.getAttribute('href');
                      if (!href) continue;
                      
                      // Skip non-navigational links
                      if (href.startsWith('#') || href.startsWith('javascript:') || 
                          href.startsWith('mailto:') || href.startsWith('tel:') ||
                          href.startsWith('sms:') || href.startsWith('ftp:')) {
                        continue;
                      }
                      
                      // Convert relative URLs to absolute
                      if (href.startsWith('/')) {
                        const baseUrlObj = new URL(baseUrl);
                        href = baseUrlObj.origin + href;
                      } else if (!href.startsWith('http')) {
                        href = new URL(href, baseUrl).href;
                      }
                      
                      // Only include links from the same domain
                      const linkUrl = new URL(href);
                      const baseUrlObj = new URL(baseUrl);
                      
                      if (linkUrl.hostname === baseUrlObj.hostname) {
                        // Clean up the URL (remove fragments, normalize)
                        const cleanUrl = linkUrl.origin + linkUrl.pathname + linkUrl.search;
                        processedLinks.push(cleanUrl);
                      }
                    } catch (e) {
                      // Skip invalid URLs
                      continue;
                    }
                  }
                  
                  // Remove duplicates and return limited set
                  const uniqueLinks = [...new Set(processedLinks)];
                  return uniqueLinks.slice(0, limit);
              }, baseUrl, linkLimit);
            } catch (error) {
              addLog(`❌ Error extracting links: ${error.message}`, 'error');
              links = [];
            }
            
            addLog(`🔗 Found ${links.length} links to test`, 'info');
            
            // Test each link with environment-specific timeouts
            let brokenLinksOnPage = 0;
            for (const link of links) {
              try {
                  const controller = new AbortController();
                  const linkTimeout = isRenderProduction ? 5000 : 8000;
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
                      
                      // Add working internal links to crawl queue for comprehensive scanning
                      try {
                          const linkUrl = new URL(link);
                          const baseUrlObj = new URL(baseUrl);
                          
                          if (linkUrl.hostname === baseUrlObj.hostname) {
                              const relativePath = linkUrl.pathname + linkUrl.search;
                              const cleanPath = relativePath.endsWith('/') ? relativePath.slice(0, -1) : relativePath;
                              
                              // Add to crawl queue if not already visited or queued
                              if (!visitedPages.has(relativePath) && 
                                  !visitedPages.has(cleanPath) && 
                                  !pagesToCrawl.includes(relativePath) &&
                                  !pagesToCrawl.includes(cleanPath)) {
                                  
                                  pagesToCrawl.push(relativePath);
                                  addLog(`🔍 Added to crawl queue: ${relativePath}`, 'info');
                              }
                          }
                      } catch (e) {
                          // Ignore URL parsing errors
                      }
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
            
            // Button testing - enabled for comprehensive scans
            if (options.includeButtons !== false) {
              let buttons = [];
              try {
                buttons = await page.evaluate(() => {
                  const allButtons = [
                    ...document.querySelectorAll('button:not([disabled])'),
                    ...document.querySelectorAll('[role="button"]:not([disabled])'),
                    ...document.querySelectorAll('.btn:not([disabled])'),
                    ...document.querySelectorAll('[onclick]:not([disabled])')
                  ];
                  
                  return allButtons
                    .filter(el => {
                      const style = window.getComputedStyle(el);
                      return style.display !== 'none' && 
                             style.visibility !== 'hidden' && 
                             el.offsetParent !== null;
                    })
                    .map((el, index) => ({
                      index,
                      text: el.textContent?.trim().substring(0, 40) || `Button ${index + 1}`,
                      className: el.className,
                      id: el.id,
                      tagName: el.tagName
                    }));
                });
              } catch (error) {
                addLog(`❌ Error extracting buttons: ${error.message}`, 'error');
                buttons = [];
              }
              
              addLog(`🔘 Found ${buttons.length} buttons to test`, 'info');
              
              let brokenButtonsOnPage = 0;
              let authIssuesOnPage = 0;
              
              // Test buttons (limit based on environment)
              const buttonLimit = isRenderProduction ? 2 : 5;
              for (const buttonInfo of buttons.slice(0, buttonLimit)) {
                let buttonPage;
                try {
                  buttonPage = await browser.newPage();
                  await buttonPage.setViewport({ width: 1280, height: 720 });
                  
                  const buttonErrors = [];
                  buttonPage.on('console', (msg) => {
                    if (msg.type() === 'error') buttonErrors.push(msg.text());
                  });
                  
                  await buttonPage.goto(fullUrl, { timeout: 15000, waitUntil: 'domcontentloaded' });
                  await new Promise(resolve => setTimeout(resolve, 1000));
                  
                  // More reliable button selection
                  let button;
                  if (buttonInfo.id) {
                    button = await buttonPage.$(`#${buttonInfo.id}`);
                  } else {
                    const buttons = await buttonPage.$(`${buttonInfo.tagName.toLowerCase()}`);
                    button = buttons[buttonInfo.index];
                  }
                  
                  if (button) {
                    const isVisible = await button.isIntersectingViewport();
                    
                    if (isVisible) {
                      await button.click();
                      await new Promise(resolve => setTimeout(resolve, 1000));
                      
                      const realErrors = buttonErrors.filter(e => 
                        !e.includes('401') && !e.includes('404') && 
                        !e.includes('Unauthorized') && !e.includes('Not Found')
                      );
                      
                      if (realErrors.length > 0) {
                        brokenButtonsOnPage++;
                        allIssues.brokenButtons.push({
                          page: fullUrl,
                          button: buttonInfo.text,
                          errors: realErrors
                        });
                      } else {
                        allIssues.workingButtons.push({
                          page: fullUrl,
                          button: buttonInfo.text
                        });
                      }
                      
                      const authErrors = buttonErrors.filter(e => e.includes('401') || e.includes('Unauthorized'));
                      if (authErrors.length > 0) {
                        authIssuesOnPage++;
                        allIssues.authErrors.push({
                          page: fullUrl,
                          button: buttonInfo.text,
                          count: authErrors.length
                        });
                      }
                      
                      const resourceErrors = buttonErrors.filter(e => e.includes('404') || e.includes('Not Found'));
                      if (resourceErrors.length > 0) {
                        allIssues.missingResources.push({
                          page: fullUrl,
                          button: buttonInfo.text,
                          count: resourceErrors.length
                        });
                      }
                    }
                  }
                } catch (error) {
                  brokenButtonsOnPage++;
                  allIssues.brokenButtons.push({
                    page: fullUrl,
                    button: buttonInfo.text,
                    errors: [error.message]
                  });
                } finally {
                  if (buttonPage) {
                    try {
                      await buttonPage.close();
                    } catch (e) {
                      // Ignore close errors
                    }
                  }
                }
              }
              
              if (brokenButtonsOnPage > 0) {
                addLog(`❌ Found ${brokenButtonsOnPage} broken buttons`, 'warning');
              }
              
              if (authIssuesOnPage > 0) {
                addLog(`🔐 Found ${authIssuesOnPage} authentication issues`, 'warning');
              }
            } else {
              addLog(`⚠️ Button testing disabled`, 'info');
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
    
    // Limit pages for comprehensive scanning based on options
    const pageLimit = options.maxPages || (process.env.NODE_ENV === 'production' ? 50 : 100);
    const linkLimit = options.maxLinks || 25;
    
    addLog(`🎯 Scan configuration: maxPages=${pageLimit}, maxLinks=${linkLimit}, comprehensive=${options.comprehensive}`, 'info');
    
    // Crawl pages - COMPREHENSIVE SCANNING
    let consecutiveErrors = 0;
    const maxConsecutiveErrors = 5;
    
    while (pagesToCrawl.length > 0 && visitedPages.size < pageLimit && consecutiveErrors < maxConsecutiveErrors) {
      const currentUrl = pagesToCrawl.shift();
      
      try {
        await crawlPage(currentUrl);
        consecutiveErrors = 0; // Reset error counter on success
      } catch (error) {
        consecutiveErrors++;
        addLog(`❌ Failed to crawl ${currentUrl}: ${error.message}`, 'error');
        
        if (consecutiveErrors >= maxConsecutiveErrors) {
          addLog(`⚠️ Too many consecutive errors (${consecutiveErrors}), stopping scan`, 'warning');
          break;
        }
      }
      
      // Add memory and time checks but be more lenient
      const memUsage = process.memoryUsage().heapUsed / 1024 / 1024;
      const scanDuration = Date.now() - new Date(scan.startTime).getTime();
      
      if (memUsage > 800) { // Increased memory limit
        addLog(`⚠️ Memory usage high (${Math.round(memUsage)}MB), continuing with caution`, 'warning');
        // Continue instead of breaking - just log the warning
      }
      
      if (scanDuration > 10 * 60 * 1000) { // 10 minute time limit
        addLog(`⏱️ Scan running for ${Math.round(scanDuration/1000/60)} minutes, continuing...`, 'info');
      }
      
      // Add a small delay between pages to prevent overwhelming the server
      await delay(500);
      
      // Update progress more frequently
      updateProgress();
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