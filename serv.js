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
      maxPages: options.maxPages || (process.env.NODE_ENV === 'production' ? 100 : 200),
      maxLinks: options.maxLinks || 50, 
      includeButtons: options.includeButtons !== false, 
      includeForms: options.includeForms !== false, 
      includeResources: options.includeResources !== false, 
      includePerformance: options.includePerformance !== false, 
      useSitemap: options.useSitemap !== false, 
      timeout: options.timeout || 30000,
      comprehensive: options.comprehensive !== false,  
      testDepth: options.testDepth || 'deep' // shallow, normal, deep
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
      console.error(`Background scan error for ${scanId}:`, error);
      const failedScan = activeScans.get(scanId);
      if (failedScan) {
        failedScan.status = 'error';
        failedScan.error = error.message;
        failedScan.progress = 0;
      }
    });
    
    res.json({ scanId, status: 'started', options: scanOptions });
  } catch (error) {
    console.error('POST /api/scan error:', error);
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
    console.error('GET /api/scan/:scanId error:', error);
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
    console.error('GET /api/scan error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

async function scanWebsite(baseUrl, scanId, options = {}) {
  let browser;
  const scan = activeScans.get(scanId);
  
  if (!scan) {
    console.log(`Scan ${scanId} not found in activeScans`);
    return;
  }
  
  // FIXED: Reset logs array for each new scan to prevent accumulation
  scan.logs = [];
  console.log(`\n ============ STARTING NEW SCAN: ${scanId} ============`);
  
  // Helper function to add logs
  const addLog = (message, type = 'info') => {
    const logEntry = {
      timestamp: new Date().toISOString(),
      message,
      type
    };
    scan.logs.push(logEntry);
    console.log(`[${scanId}] ${message}`);
    
    // Keep only last 50 logs to save memory
    if (scan.logs.length > 50) {
      scan.logs = scan.logs.slice(-50);
    }
  };
  
  try {
    addLog(` Starting scan for ${baseUrl}`, 'info');
    addLog(` Memory before browser launch: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`, 'info');
    
    // Better environment detection - check for Render-specific environment variables
    const isRenderProduction = process.env.RENDER || process.env.RENDER_SERVICE_ID;
    const isLocalProduction = process.env.NODE_ENV === 'production' && !isRenderProduction;
    
    if (isRenderProduction) {
      // Production (Render) - use chromium with memory optimizations
      addLog(` Loading Render Chromium...`, 'info');
      
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
      addLog(` Using local Puppeteer (${process.env.NODE_ENV} mode)`, 'info');
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
    
    addLog(` Browser launched successfully`, 'success');
    addLog(` Memory after browser launch: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`, 'info');
    
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
      workingButtons: [],
      // New comprehensive categories
      performanceData: [],
      seoData: [],
      seoIssues: [],
      formIssues: [],
      resourceIssues: []
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
        addLog(` Progress: ${processedPages} pages scanned, ${pagesToCrawl.length} in queue`, 'info');
      }
    };
    
    async function crawlPage(pageUrl) {
        if (visitedPages.has(pageUrl)) return;
        visitedPages.add(pageUrl);
        processedPages++;
        updateProgress();
        
        const fullUrl = pageUrl.startsWith('http') ? pageUrl : baseUrl + pageUrl;
        addLog(` Scanning: ${fullUrl}`, 'info');
        
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
              addLog(`Page failed to load: ${fullUrl} (Status: ${response?.status() || 'No response'})`, 'error');
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
            addLog(` Page loaded successfully`, 'success');
                        // Try to find sitemap.xml for comprehensive page discovery
            if (processedPages === 1) { // Only try on first page
              await discoverAdditionalPages(baseUrl, pagesToCrawl, visitedPages, addLog);
            }
            
            // ENHANCED COMPREHENSIVE link discovery
            let links = [];
            try {
              links = await page.evaluate((baseUrl, limit) => {
                  const processedLinks = [];
                  const baseUrlObj = new URL(baseUrl);
                  
                  // 1. Standard navigation links
                  const navLinks = Array.from(document.querySelectorAll('a[href]'));
                  
                  // 2. Links in navigation menus (more comprehensive selectors)
                  const menuLinks = Array.from(document.querySelectorAll(`
                    nav a[href], .nav a[href], .navigation a[href], .menu a[href],
                    .navbar a[href], .header a[href], .footer a[href],
                    [role="navigation"] a[href], .breadcrumb a[href],
                    .sidebar a[href], .main-menu a[href], .primary-menu a[href]
                  `));
                  
                  // 3. Button-like elements that might be links
                  const buttonLinks = Array.from(document.querySelectorAll(`
                    button[onclick*="location"], button[onclick*="window.open"],
                    [role="button"][onclick*="location"], .btn[onclick*="location"],
                    [data-href], [data-url], [data-link]
                  `));
                  
                  // 4. JavaScript-generated links (check for data attributes)
                  const dataLinks = Array.from(document.querySelectorAll('[data-page], [data-route], [data-path]'));
                  
                  // 5. Form actions that might be pages
                  const formActions = Array.from(document.querySelectorAll('form[action]'))
                    .map(form => ({ href: form.getAttribute('action') }));
                  
                  // Combine all link sources
                  const allElements = [
                    ...navLinks, 
                    ...menuLinks, 
                    ...buttonLinks.map(btn => ({
                      href: btn.getAttribute('data-href') || 
                            btn.getAttribute('data-url') || 
                            btn.getAttribute('data-link') ||
                            (btn.getAttribute('onclick') && 
                             btn.getAttribute('onclick').match(/["']([^"']+)["']/)?.[1])
                    })),
                    ...dataLinks.map(el => ({
                      href: el.getAttribute('data-page') || 
                            el.getAttribute('data-route') || 
                            el.getAttribute('data-path')
                    })),
                    ...formActions
                  ];
                  
                  for (const element of allElements) {
                    try {
                      let href = element.href;
                      if (!href || typeof href !== 'string') continue;
                      
                      // Skip non-navigational links
                      if (href.startsWith('#') || href.startsWith('javascript:') || 
                          href.startsWith('mailto:') || href.startsWith('tel:') ||
                          href.startsWith('sms:') || href.startsWith('ftp:') ||
                          href.includes('void(0)')) {
                        continue;
                      }
                      
                      // Convert relative URLs to absolute
                      if (href.startsWith('/')) {
                        href = baseUrlObj.origin + href;
                      } else if (!href.startsWith('http')) {
                        href = new URL(href, baseUrl).href;
                      }
                      
                      // Only include links from the same domain
                      const linkUrl = new URL(href);
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
                  
                  // 6. Try to find pagination links
                  const paginationSelectors = [
                    '.pagination a', '.pager a', '.page-numbers a',
                    '[aria-label*="page"] a', '[class*="page"] a',
                    '.next a', '.prev a', '.previous a',
                    '[rel="next"]', '[rel="prev"]', '[rel="previous"]'
                  ];
                  
                  for (const selector of paginationSelectors) {
                    try {
                      const paginationLinks = Array.from(document.querySelectorAll(selector));
                      for (const link of paginationLinks) {
                        let href = link.getAttribute('href');
                        if (href && href.startsWith('/')) {
                          href = baseUrlObj.origin + href;
                          processedLinks.push(href);
                        }
                      }
                    } catch (e) {
                      // Ignore pagination discovery errors
                    }
                  }
                  
                  // 7. Look for AJAX/API endpoints in script tags that might contain page routes
                  try {
                    const scripts = Array.from(document.querySelectorAll('script:not([src])'));
                    const routePatterns = [
                      /["']\/[a-zA-Z0-9\-_\/]+["']/g,  // "/some/path"
                      /routes?\s*[:=]\s*\[([^\]]+)\]/gi, // routes: [...]
                      /paths?\s*[:=]\s*\[([^\]]+)\]/gi   // paths: [...]
                    ];
                    
                    for (const script of scripts.slice(0, 5)) { // Limit script analysis
                      const content = script.textContent || script.innerText || '';
                      
                      for (const pattern of routePatterns) {
                        const matches = content.match(pattern);
                        if (matches) {
                          for (const match of matches.slice(0, 10)) { // Limit matches per script
                            const cleanMatch = match.replace(/['"]/g, '');
                            if (cleanMatch.startsWith('/') && cleanMatch.length > 1 && cleanMatch.length < 100) {
                              try {
                                const url = baseUrlObj.origin + cleanMatch;
                                processedLinks.push(url);
                              } catch (e) {
                                // Ignore invalid route URLs
                              }
                            }
                          }
                        }
                      }
                    }
                  } catch (e) {
                    // Ignore script analysis errors
                  }
                  
                  // Remove duplicates and return limited set
                  const uniqueLinks = [...new Set(processedLinks)];
                  return uniqueLinks.slice(0, limit);
              }, baseUrl, linkLimit);
            } catch (error) {
              addLog(`Error extracting links: ${error.message}`, 'error');
              links = [];
            }
            
            addLog(` Found ${links.length} links to test`, 'info');
            
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
                                  addLog(` Added to crawl queue: ${relativePath}`, 'info');
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
              addLog(`Found ${brokenLinksOnPage} broken links`, 'warning');
            }
            
            // Button testing - enabled for comprehensive scans
            if (options.includeButtons !== false) {
              let buttons = [];
              // COMPREHENSIVE BUTTON DISCOVERY
              try {
                buttons = await page.evaluate(() => {
                  const allButtonElements = [
                    // Standard buttons
                    ...document.querySelectorAll('button:not([disabled])'),
                    // Role-based buttons
                    ...document.querySelectorAll('[role="button"]:not([disabled])'),
                    // Class-based buttons (common patterns)
                    ...document.querySelectorAll(`
                      .btn:not([disabled]), .button:not([disabled]), 
                      .cta:not([disabled]), .call-to-action:not([disabled]),
                      .submit:not([disabled]), .primary:not([disabled]),
                      .secondary:not([disabled]), .action:not([disabled])
                    `),
                    // Interactive elements with click handlers
                    ...document.querySelectorAll('[onclick]:not([disabled])'),
                    // Input buttons and submits
                    ...document.querySelectorAll('input[type="button"]:not([disabled])'),
                    ...document.querySelectorAll('input[type="submit"]:not([disabled])'),
                    // Links that look like buttons
                    ...document.querySelectorAll(`
                      a.btn, a.button, a[role="button"], 
                      a.cta, a.call-to-action, a.primary, a.secondary
                    `),
                    // Elements with button-like data attributes
                    ...document.querySelectorAll('[data-action], [data-click], [data-submit]'),
                    // Form elements that might be interactive
                    ...document.querySelectorAll('label[for]:not([disabled])'),
                    // Custom interactive elements
                    ...document.querySelectorAll(`
                      [class*="click"], [class*="press"], [class*="tap"],
                      [id*="button"], [id*="btn"], [id*="submit"]
                    `)
                  ];
                  
                  return allButtonElements
                    .filter((el, index, array) => {
                      // Remove duplicates
                      return array.indexOf(el) === index;
                    })
                    .filter(el => {
                      // Only visible elements
                      const style = window.getComputedStyle(el);
                      const rect = el.getBoundingClientRect();
                      
                      return style.display !== 'none' && 
                             style.visibility !== 'hidden' && 
                             style.opacity !== '0' &&
                             el.offsetParent !== null &&
                             rect.width > 0 && rect.height > 0;
                    })
                    .map((el, index) => {
                      // Extract meaningful information
                      const text = (el.textContent || el.value || el.title || 
                                   el.getAttribute('aria-label') || 
                                   el.getAttribute('data-label') ||
                                   el.className.split(' ').find(c => c.includes('btn') || c.includes('button')) ||
                                   `Element ${index + 1}`)
                                   .trim().substring(0, 50);
                      
                      return {
                        index,
                        text: text || `Button ${index + 1}`,
                        className: el.className,
                        id: el.id,
                        tagName: el.tagName,
                        type: el.type || el.getAttribute('role') || 'interactive',
                        hasOnClick: !!el.getAttribute('onclick'),
                        hasDataAction: !!(el.getAttribute('data-action') || 
                                         el.getAttribute('data-click') || 
                                         el.getAttribute('data-submit')),
                        isFormElement: ['INPUT', 'BUTTON', 'LABEL'].includes(el.tagName)
                      };
                    })
                    .filter(btn => btn.text.length > 0 && btn.text !== 'undefined');
                });
              } catch (error) {
                addLog(`Error extracting buttons: ${error.message}`, 'error');
                buttons = [];
              }
              
              addLog(` Found ${buttons.length} buttons to test`, 'info');
              
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
              if (options.includeSEO !== false && processedPages <= 30) { 
                try {
                  const seoData = await page.evaluate(() => {
                    return {
                      title: document.title || null,
                      titleLength: document.title?.length || 0,
                      metaDescription: document.querySelector('meta[name="description"]')?.getAttribute('content') || null,
                      metaDescriptionLength: document.querySelector('meta[name="description"]')?.getAttribute('content')?.length || 0,
                      h1Count: document.querySelectorAll('h1').length,
                      h2Count: document.querySelectorAll('h2').length,
                      imgWithoutAlt: document.querySelectorAll('img:not([alt])').length,
                      imgWithEmptyAlt: document.querySelectorAll('img[alt=""]').length,
                      linksWithoutText: document.querySelectorAll('a:not([aria-label]):empty').length,
                      hasLang: !!document.documentElement.getAttribute('lang'),
                      hasViewport: !!document.querySelector('meta[name="viewport"]'),
                      hasCanonical: !!document.querySelector('link[rel="canonical"]'),
                      hasOgTitle: !!document.querySelector('meta[property="og:title"]'),
                      hasStructuredData: document.querySelectorAll('[type="application/ld+json"]').length > 0
                    };
                  });
                  
                  // Store SEO data
                  if (!allIssues.seoData) {
                    allIssues.seoData = [];
                  }
                  
                  allIssues.seoData.push({
                    page: fullUrl,
                    ...seoData
                  });
                  
                  // Flag SEO issues
                  const seoIssues = [];
                  if (!seoData.title) seoIssues.push('Missing title tag');
                  if (seoData.titleLength > 60) seoIssues.push(`Title too long (${seoData.titleLength} chars)`);
                  if (!seoData.metaDescription) seoIssues.push('Missing meta description');
                  if (seoData.metaDescriptionLength > 160) seoIssues.push(`Meta description too long (${seoData.metaDescriptionLength} chars)`);
                  if (seoData.h1Count === 0) seoIssues.push('Missing H1 tag');
                  if (seoData.h1Count > 1) seoIssues.push(`Multiple H1 tags (${seoData.h1Count})`);
                  if (seoData.imgWithoutAlt > 0) seoIssues.push(`${seoData.imgWithoutAlt} images without alt text`);
                  if (!seoData.hasLang) seoIssues.push('Missing lang attribute');
                  if (!seoData.hasViewport) seoIssues.push('Missing viewport meta tag');
                  
                  if (seoIssues.length > 0) {
                    if (!allIssues.seoIssues) allIssues.seoIssues = [];
                    allIssues.seoIssues.push({
                      page: fullUrl,
                      issues: seoIssues
                    });
                    addLog(` SEO issues found: ${seoIssues.length}`, 'warning');
                  } else {
                    addLog(` No major SEO issues found`, 'success');
                  }
                  
                } catch (error) {
                  addLog(` Error checking SEO: ${error.message}`, 'error');
                }
              }
              
              if (options.includePerformance !== false && processedPages <= 50) { // Test performance on first 10 pages
                try {
                  const performanceMetrics = await page.evaluate(() => {
                    const navigation = performance.getEntriesByType('navigation')[0];
                    const paint = performance.getEntriesByType('paint');
                    
                    return {
                      domContentLoaded: navigation ? Math.round(navigation.domContentLoadedEventEnd - navigation.domContentLoadedEventStart) : null,
                      loadComplete: navigation ? Math.round(navigation.loadEventEnd - navigation.loadEventStart) : null,
                      firstPaint: paint.find(p => p.name === 'first-paint')?.startTime || null,
                      firstContentfulPaint: paint.find(p => p.name === 'first-contentful-paint')?.startTime || null,
                      totalElements: document.querySelectorAll('*').length,
                      totalImages: document.querySelectorAll('img').length,
                      totalLinks: document.querySelectorAll('a').length,
                      hasLazyLoading: document.querySelectorAll('[loading="lazy"]').length > 0,
                      pageSize: Math.round((performance.getEntriesByType('navigation')[0]?.transferSize || 0) / 1024) // KB
                    };
                  });
                  
                  // Store performance data
                  if (!allIssues.performanceData) {
                    allIssues.performanceData = [];
                  }
                  
                  allIssues.performanceData.push({
                    page: fullUrl,
                    ...performanceMetrics
                  });
                  
                  // Flag performance issues
                  if (performanceMetrics.firstContentfulPaint > 3000) {
                    addLog(` Slow First Contentful Paint: ${Math.round(performanceMetrics.firstContentfulPaint)}ms`, 'warning');
                  }
                  if (performanceMetrics.totalElements > 1500) {
                    addLog(` High DOM complexity: ${performanceMetrics.totalElements} elements`, 'warning');
                  }
                  if (performanceMetrics.pageSize > 2000) {
                    addLog(` Large page size: ${performanceMetrics.pageSize}KB`, 'warning');
                  }
                  
                  addLog(` Performance: FCP: ${Math.round(performanceMetrics.firstContentfulPaint || 0)}ms, Elements: ${performanceMetrics.totalElements}`, 'info');
                  
                } catch (error) {
                  addLog(` Error collecting performance data: ${error.message}`, 'error');
                }
              } else {
                addLog(` Button testing disabled`, 'info');
              }

              if (options.includeForms !== false) {
                try {
                  const forms = await page.evaluate(() => {
                    return Array.from(document.querySelectorAll('form'))
                      .map((form, index) => ({
                        index,
                        action: form.action || form.getAttribute('action'),
                        method: form.method || form.getAttribute('method') || 'GET',
                        id: form.id,
                        className: form.className,
                        fieldCount: form.querySelectorAll('input, textarea, select').length,
                        hasRequiredFields: form.querySelectorAll('[required]').length > 0
                      }))
                      .filter(form => form.action && form.fieldCount > 0);
                  });
                  
                  if (forms.length > 0) {
                    addLog(` Found ${forms.length} forms to analyze`, 'info');
                    
                    for (const form of forms.slice(0, 3)) { // Test up to 3 forms per page
                      try {
                        // Test if form action URL is accessible
                        if (form.action && !form.action.startsWith('javascript:')) {
                          const formUrl = form.action.startsWith('http') ? form.action : new URL(form.action, baseUrl).href;
                          const baseUrlObj = new URL(baseUrl);
                          const formUrlObj = new URL(formUrl);
                          
                          // Only test forms on the same domain
                          if (formUrlObj.hostname === baseUrlObj.hostname) {
                            const response = await fetch(formUrl, { 
                              method: 'HEAD', 
                              timeout: 5000 
                            });
                            
                            if (!response.ok) {
                              allIssues.brokenLinks.push({
                                page: fullUrl,
                                link: formUrl,
                                status: response.status,
                                error: `Form action endpoint: ${response.statusText}`,
                                type: 'form'
                              });
                              addLog(` Form action endpoint broken: ${formUrl}`, 'error');
                            } else {
                              allIssues.workingLinks.push({ 
                                page: fullUrl, 
                                link: formUrl, 
                                type: 'form' 
                              });
                            }
                          }
                        }
                      } catch (error) {
                        addLog(` Error testing form: ${error.message}`, 'error');
                      }
                    }
                  }
                } catch (error) {
                  addLog(` Error analyzing forms: ${error.message}`, 'error');
                }
              }
              
              if (brokenButtonsOnPage > 0) {
                addLog(`Found ${brokenButtonsOnPage} broken buttons`, 'warning');
              }
              
              if (authIssuesOnPage > 0) {
                addLog(` Found ${authIssuesOnPage} authentication issues`, 'warning');
              }
            } else {
              addLog(`Button testing disabled`, 'info');
            }
            
        } catch (error) {
            addLog(`Error crawling ${fullUrl}: ${error.message}`, 'error');
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
        
        addLog(` Completed: ${fullUrl}`, 'success');
    }    
    // Enhanced limits for deep scanning
    const pageLimit = options.maxPages || (isRenderProduction ? 100 : 200); // Increased limits
    const linkLimit = options.maxLinks || (isRenderProduction ? 30 : 60); // Increased link testing
    
    addLog(` Deep scan configuration: maxPages=${pageLimit}, maxLinks=${linkLimit}, depth=${options.testDepth}`, 'info');
    
    // COMPREHENSIVE DISCOVERY FUNCTION
    async function discoverAdditionalPages(baseUrl, pagesToCrawl, visitedPages, addLog) {
      const baseUrlObj = new URL(baseUrl);
      const discoveryMethods = [];
      
      // 1. Try sitemap.xml
      discoveryMethods.push(async () => {
        try {
          const sitemapUrl = new URL('/sitemap.xml', baseUrl).href;
          const sitemapResponse = await fetch(sitemapUrl, { 
            timeout: 8000,
            headers: { 'User-Agent': 'Mozilla/5.0 WebScanner Bot' }
          });
          
          if (sitemapResponse.ok) {
            addLog(` Found sitemap.xml, extracting URLs`, 'success');
            const sitemapText = await sitemapResponse.text();
            
            const urlMatches = sitemapText.match(/<loc>(.*?)<\/loc>/g);
            if (urlMatches) {
              const sitemapUrls = urlMatches
                .map(match => match.replace(/<\/?loc>/g, ''))
                .filter(url => {
                  try {
                    const urlObj = new URL(url);
                    return urlObj.hostname === baseUrlObj.hostname;
                  } catch { return false; }
                })
                .map(url => new URL(url).pathname + new URL(url).search)
                .filter(path => !visitedPages.has(path) && !pagesToCrawl.includes(path));
              
              sitemapUrls.slice(0, 100).forEach(path => pagesToCrawl.push(path));
              addLog(` Added ${Math.min(sitemapUrls.length, 100)} URLs from sitemap.xml`, 'success');
              return sitemapUrls.length;
            }
          }
        } catch (error) {
          addLog(`Could not fetch sitemap.xml: ${error.message}`, 'warning');
        }
        return 0;
      });
      
      // 2. Try robots.txt for sitemap references
      discoveryMethods.push(async () => {
        try {
          const robotsUrl = new URL('/robots.txt', baseUrl).href;
          const robotsResponse = await fetch(robotsUrl, { 
            timeout: 5000,
            headers: { 'User-Agent': 'Mozilla/5.0 WebScanner Bot' }
          });
          
          if (robotsResponse.ok) {
            const robotsText = await robotsResponse.text();
            const sitemapMatches = robotsText.match(/sitemap:\s*(.*)/gi);
            
            if (sitemapMatches) {
              addLog(` Found ${sitemapMatches.length} sitemap references in robots.txt`, 'info');
              
              for (const match of sitemapMatches.slice(0, 5)) {
                const sitemapUrl = match.replace(/sitemap:\s*/i, '').trim();
                try {
                  const response = await fetch(sitemapUrl, { timeout: 8000 });
                  if (response.ok) {
                    const text = await response.text();
                    const urls = text.match(/<loc>(.*?)<\/loc>/g);
                    if (urls) {
                      const newUrls = urls
                        .map(u => u.replace(/<\/?loc>/g, ''))
                        .filter(url => new URL(url).hostname === baseUrlObj.hostname)
                        .map(url => new URL(url).pathname + new URL(url).search)
                        .filter(path => !visitedPages.has(path) && !pagesToCrawl.includes(path));
                      
                      newUrls.slice(0, 50).forEach(path => pagesToCrawl.push(path));
                      addLog(` Added ${newUrls.length} URLs from ${sitemapUrl}`, 'success');
                    }
                  }
                } catch (e) {
                  addLog(`Could not fetch sitemap from robots.txt: ${e.message}`, 'warning');
                }
              }
            }
          }
        } catch (error) {
          addLog(`Could not fetch robots.txt: ${error.message}`, 'warning');
        }
        return 0;
      });
      
      // 3. Try common page patterns
      discoveryMethods.push(async () => {
        const commonPaths = [
          '/about', '/about-us', '/about/', '/contact', '/contact-us', '/contact/',
          '/services', '/services/', '/products', '/products/', '/portfolio', '/portfolio/',
          '/blog', '/blog/', '/news', '/news/', '/events', '/events/',
          '/pricing', '/pricing/', '/plans', '/plans/', '/testimonials', '/testimonials/',
          '/gallery', '/gallery/', '/team', '/team/', '/careers', '/careers/',
          '/privacy', '/privacy/', '/terms', '/terms/', '/legal', '/legal/',
          '/support', '/support/', '/help', '/help/', '/faq', '/faq/',
          '/login', '/register', '/signup', '/dashboard', '/profile',
          '/search', '/categories', '/archive', '/sitemap'
        ];
        
        let found = 0;
        for (const path of commonPaths) {
          if (!visitedPages.has(path) && !pagesToCrawl.includes(path)) {
            try {
              const testUrl = new URL(path, baseUrl).href;
              const response = await fetch(testUrl, { 
                method: 'HEAD', 
                timeout: 3000,
                headers: { 'User-Agent': 'Mozilla/5.0 WebScanner Bot' }
              });
              
              if (response.ok && response.status < 400) {
                pagesToCrawl.push(path);
                found++;
              }
            } catch (e) {
              // Ignore errors for common paths
            }
          }
        }
        
        if (found > 0) {
          addLog(` Added ${found} common pages to crawl queue`, 'success');
        }
        return found;
      });
      
      // 4. Try to find API endpoints for SPA discovery
      discoveryMethods.push(async () => {
        const apiPaths = ['/api/sitemap', '/api/pages', '/api/routes', '/.well-known/sitemap'];
        let found = 0;
        
        for (const path of apiPaths) {
          try {
            const apiUrl = new URL(path, baseUrl).href;
            const response = await fetch(apiUrl, { 
              timeout: 5000,
              headers: { 
                'User-Agent': 'Mozilla/5.0 WebScanner Bot',
                'Accept': 'application/json, text/plain, */*'
              }
            });
            
            if (response.ok) {
              const contentType = response.headers.get('content-type');
              if (contentType && contentType.includes('application/json')) {
                const data = await response.json();
                
                // Try to extract URLs from JSON response
                const extractUrls = (obj, urls = []) => {
                  if (typeof obj === 'string' && obj.startsWith('/')) {
                    urls.push(obj);
                  } else if (Array.isArray(obj)) {
                    obj.forEach(item => extractUrls(item, urls));
                  } else if (typeof obj === 'object' && obj !== null) {
                    Object.values(obj).forEach(value => extractUrls(value, urls));
                  }
                  return urls;
                };
                
                const extractedUrls = extractUrls(data)
                  .filter(url => !visitedPages.has(url) && !pagesToCrawl.includes(url))
                  .slice(0, 30);
                
                extractedUrls.forEach(url => pagesToCrawl.push(url));
                if (extractedUrls.length > 0) {
                  addLog(` Added ${extractedUrls.length} URLs from ${path}`, 'success');
                  found += extractedUrls.length;
                }
              }
            }
          } catch (e) {
            // Ignore API discovery errors
          }
        }
        return found;
      });
      
      // Execute all discovery methods
      addLog(` Starting comprehensive page discovery...`, 'info');
      let totalFound = 0;
      
      for (const method of discoveryMethods) {
        try {
          const found = await method();
          totalFound += found;
        } catch (error) {
          addLog(`Discovery method failed: ${error.message}`, 'warning');
        }
      }
      
      addLog(` Page discovery complete! Found ${totalFound} additional pages to scan`, totalFound > 0 ? 'success' : 'info');
    }
    
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
        addLog(`Failed to crawl ${currentUrl}: ${error.message}`, 'error');
        
        if (consecutiveErrors >= maxConsecutiveErrors) {
          addLog(`Too many consecutive errors (${consecutiveErrors}), stopping scan`, 'warning');
          break;
        }
      }
      
      // Add memory and time checks but be more lenient
      const memUsage = process.memoryUsage().heapUsed / 1024 / 1024;
      const scanDuration = Date.now() - new Date(scan.startTime).getTime();
      
      if (memUsage > 800) { // Increased memory limit
        addLog(` Memory usage high (${Math.round(memUsage)}MB), continuing with caution`, 'warning');
        // Continue instead of breaking - just log the warning
      }
      
      if (scanDuration > 10 * 60 * 1000) { // 10 minute time limit
        addLog(` Scan running for ${Math.round(scanDuration/1000/60)} minutes, continuing...`, 'info');
      }
      
      // Add a small delay between pages to prevent overwhelming the server
      await delay(500);
      
      // Update progress more frequently
      updateProgress();
    }
    
    // Generate comprehensive summary
    const summary = {
      totalPages: visitedPages.size,
      totalLinks: allIssues.brokenLinks.length + allIssues.workingLinks.length,
      totalButtons: allIssues.brokenButtons.length + allIssues.workingButtons.length,
      brokenLinksCount: allIssues.brokenLinks.length,
      brokenButtonsCount: allIssues.brokenButtons.length,
      authIssuesCount: allIssues.authErrors.length,
      missingResourcesCount: allIssues.missingResources.length,
      pagesWithErrors: allIssues.pageErrors.length,
      // New comprehensive metrics
      seoIssuesCount: allIssues.seoIssues?.length || 0,
      performanceIssuesCount: allIssues.performanceData?.filter(p => 
        p.firstContentfulPaint > 3000 || p.totalElements > 1500 || p.pageSize > 2000
      ).length || 0,
      formsTestedCount: allIssues.workingLinks?.filter(l => l.type === 'form').length || 0,
      resourcesTestedCount: allIssues.missingResources?.length + 
                           (allIssues.workingLinks?.filter(l => l.type === 'resource').length || 0),
      averagePageSize: allIssues.performanceData?.length > 0 ? 
        Math.round(allIssues.performanceData.reduce((acc, p) => acc + (p.pageSize || 0), 0) / allIssues.performanceData.length) : 0,
      averageFCP: allIssues.performanceData?.length > 0 ? 
        Math.round(allIssues.performanceData.reduce((acc, p) => acc + (p.firstContentfulPaint || 0), 0) / allIssues.performanceData.length) : 0
    };
    
    scan.status = 'completed';
    scan.progress = 100;
    scan.endTime = new Date();
    scan.results = {
      summary,
      issues: allIssues,
      pages: Array.from(visitedPages)
    };
    
    addLog(` Scan completed! Scanned ${summary.totalPages} pages, found ${summary.brokenLinksCount} broken links`, 'success');
    
    const finalMemory = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    addLog(` Final memory usage: ${finalMemory}MB`, 'info');
    
  } catch (error) {
    console.error(` Scan ${scanId} failed:`, error);
    addLog(` Scan failed: ${error.message}`, 'error');
    scan.status = 'error';
    scan.error = error.message;
    scan.progress = 0;
  } finally {
    if (browser) {
      try {
        await browser.close();
        addLog(` Browser closed`, 'info');
      } catch (error) {
        console.error('Error closing browser:', error);
      }
    }
    
    // Force garbage collection if available
    if (global.gc) {
      global.gc();
      addLog(` Garbage collection triggered`, 'info');
    }
  }
}

const port = process.env.PORT || 3001;
const host = process.env.NODE_ENV === 'production' ? '0.0.0.0' : 'localhost';

const server = app.listen(port, host, () => {
  const displayHost = host === '0.0.0.0' ? 'localhost' : host;
  console.log(` WebScan Pro server running on http://${displayHost}:${port}`);
  console.log(` Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(` Initial memory usage: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`);
  
  if (process.env.NODE_ENV !== 'production') {
    console.log(` Locl access: http://localhost:${port}`);
  }
});

// Configure timeouts for cloud deployment
server.keepAliveTimeout = 120000; // 2 minutes
server.headersTimeout = 120000; // 2 minutes

// Better error handling for production
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  // Don't exit in production, just log the error
  if (process.env.NODE_ENV !== 'production') {
    process.exit(1);
  }
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // Don't exit in production, just log the error
  if (process.env.NODE_ENV !== 'production') {
    process.exit(1);
  }
});

// Graceful shutdown handlers
process.on('SIGTERM', () => {
  console.log('📤 SIGTERM received, shutting down gracefully...');
  server.close(() => {
    console.log(' Server closed');
    process.exit();
  });
});

process.on('SIGINT', () => {
  console.log('📤 SIGINT received, shutting down gracefully...');
  server.close(() => {
    console.log(' Server closed');
    process.exit();
  });
});

// Clean up old scans every 10 minutes to prevent memory leaks
setInterval(() => {
  const now = new Date();
  for (const [scanId, scan] of activeScans.entries()) {
    const age = now - new Date(scan.startTime);
    if (age > 30 * 60 * 1000) { // 30 minutes old
      activeScans.delete(scanId);
      console.log(` Cleaned up old scan: ${scanId}`);
    }
  }
}, 10 * 60 * 1000);