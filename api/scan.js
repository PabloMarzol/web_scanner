import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';

// Use /tmp directory for storing scan state (Vercel allows writes to /tmp)
const SCAN_STATE_FILE = '/tmp/scan-state.json';

// Helper functions to manage scan state
function loadScans() {
  try {
    if (existsSync(SCAN_STATE_FILE)) {
      const data = readFileSync(SCAN_STATE_FILE, 'utf8');
      return new Map(JSON.parse(data));
    }
  } catch (error) {
    console.error('Error loading scan state:', error);
  }
  return new Map();
}

function saveScans(scans) {
  try {
    const data = JSON.stringify(Array.from(scans.entries()));
    writeFileSync(SCAN_STATE_FILE, data, 'utf8');
  } catch (error) {
    console.error('Error saving scan state:', error);
  }
}

export default async function handler(req, res) {
  // Add debug logging
  console.log(`🔍 API Request: ${req.method} ${req.url}`);
  console.log(`📊 Query params:`, req.query);
  console.log(`📦 Body:`, req.body);
  
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // POST /api/scan - Start scan
  if (req.method === 'POST') {
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
      startTime: new Date().toISOString(),
      results: null,
      pagesToCrawl: ['/'], // Track pages to crawl for resume functionality
      visitedPages: new Set(), // Track visited pages
      allIssues: { // Track all issues collected so far
        brokenLinks: [],
        brokenButtons: [],
        authErrors: [],
        missingResources: [],
        reactWarnings: [],
        jsErrors: [],
        pageErrors: [],
        workingLinks: [],
        workingButtons: []
      }
    };
    
    // Load existing scans and add new one
    const activeScans = loadScans();
    activeScans.set(scanId, scan);
    saveScans(activeScans);
    
    // Start scanning in background
    scanWebsite(url, scanId).catch(error => {
      console.error('Scan error:', error);
      const scans = loadScans();
      const failedScan = scans.get(scanId);
      if (failedScan) {
        failedScan.status = 'error';
        failedScan.error = error.message;
        scans.set(scanId, failedScan);
        saveScans(scans);
      }
    });
    
    return res.json({ scanId, status: 'started' });
  }

  // POST /api/scan/stop - Stop a scan
  if (req.method === 'POST' && req.url?.includes('/stop')) {
    const { scanId } = req.body;
    
    if (!scanId) {
      return res.status(400).json({ error: 'scanId is required' });
    }
    
    const activeScans = loadScans();
    const scan = activeScans.get(scanId);
    
    if (!scan) {
      return res.status(404).json({ error: 'Scan not found' });
    }
    
    // Update scan status to stopped
    scan.status = 'stopped';
    scan.endTime = new Date().toISOString();
    
    // Generate partial report if we have any data
    if (scan.visitedPages && scan.allIssues) {
      const summary = {
        totalPages: scan.visitedPages.size,
        totalLinks: scan.allIssues.brokenLinks.length + scan.allIssues.workingLinks.length,
        totalButtons: scan.allIssues.brokenButtons.length + scan.allIssues.workingButtons.length,
        brokenLinksCount: scan.allIssues.brokenLinks.length,
        brokenButtonsCount: scan.allIssues.brokenButtons.length,
        authIssuesCount: scan.allIssues.authErrors.length,
        missingResourcesCount: scan.allIssues.missingResources.length,
        pagesWithErrors: scan.allIssues.pageErrors.length
      };
      
      scan.results = {
        summary,
        issues: scan.allIssues,
        pages: Array.from(scan.visitedPages)
      };
    }
    
    activeScans.set(scanId, scan);
    saveScans(activeScans);
    
    return res.json({ scanId, status: 'stopped', message: 'Scan stopped successfully' });
  }

  // POST /api/scan/resume - Resume a stopped scan
  if (req.method === 'POST' && req.url?.includes('/resume')) {
    const { scanId } = req.body;
    
    if (!scanId) {
      return res.status(400).json({ error: 'scanId is required' });
    }
    
    const activeScans = loadScans();
    const scan = activeScans.get(scanId);
    
    if (!scan) {
      return res.status(404).json({ error: 'Scan not found' });
    }
    
    if (scan.status !== 'stopped') {
      return res.status(400).json({ error: 'Scan must be in stopped state to resume' });
    }
    
    // Reset status and continue scanning
    scan.status = 'running';
    scan.progress = Math.min(90, (scan.visitedPages.size / Math.max(scan.visitedPages.size + scan.pagesToCrawl.length, 1)) * 10);
    scan.endTime = null;
    
    activeScans.set(scanId, scan);
    saveScans(activeScans);
    
    // Resume scanning in background
    scanWebsite(scan.url, scanId, scan).catch(error => {
      console.error('Scan resume error:', error);
      const scans = loadScans();
      const failedScan = scans.get(scanId);
      if (failedScan) {
        failedScan.status = 'error';
        failedScan.error = error.message;
        scans.set(scanId, failedScan);
        saveScans(scans);
      }
    });
    
    return res.json({ scanId, status: 'resumed' });
  }

  // GET /api/scan?scanId=xxx - Get scan status 
  if (req.method === 'GET') {
    const { scanId } = req.query;
    
    console.log(`🔍 GET request - scanId from query:`, scanId);
    
    if (!scanId) {
      console.log(`❌ No scanId found in request`);
      return res.status(400).json({ error: 'scanId is required' });
    }
    
    const activeScans = loadScans();
    console.log(`📋 Available scans:`, Array.from(activeScans.keys()));
    
    const scan = activeScans.get(scanId);
    
    if (!scan) {
      console.log(`❌ Scan not found for ID: ${scanId}`);
      return res.status(404).json({ error: 'Scan not found' });
    }
    
    console.log(`✅ Returning scan status: ${scan.status}, Progress: ${scan.progress}%`);
    return res.json(scan);
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

// Your EXACT scanWebsite function from server.js - modified to use file storage
async function scanWebsite(baseUrl, scanId, existingScan = null) {
  console.log(`🚀 scanWebsite called with baseUrl: ${baseUrl}, scanId: ${scanId}`);
  
  // Load scan from file
  let activeScans = loadScans();
  let scan = existingScan || activeScans.get(scanId);
  
  if (!scan) {
    console.log(`❌ Scan not found in activeScans for ID: ${scanId}`);
    return;
 }
  
  // Add logs array to store real-time updates
 scan.logs = scan.logs || [];
  
  // Helper function to add logs and save state
  const addLog = (message, type = 'info') => {
    const logEntry = {
      timestamp: new Date().toISOString(),
      message,
      type
    };
    scan.logs.push(logEntry);
    console.log(message);
    
    // Keep only last 50 logs to prevent memory issues
    if (scan.logs.length > 50) {
      scan.logs = scan.logs.slice(-50);
    }
    
    // Save updated scan state
    activeScans.set(scanId, scan);
    saveScans(activeScans);
  };
  
  let browser;
  
  try {
    addLog(`🚀 Starting scan for ${baseUrl}`, 'info');
    
    let executablePath;
    let args;
    let headless;
    
    // Detect environment - Vercel vs Local
    if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) {
      // Production Vercel environment
      addLog(`📦 Using Vercel/Lambda Chromium`, 'info');
      executablePath = await chromium.executablePath();
      args = [
        ...chromium.args,
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--disable-web-security',
        '--disable-features=VizDisplayCompositor'
      ];
      headless = chromium.headless;
    } else {
      // Local development environment
      addLog(`💻 Using local Chromium (dev mode)`, 'info');
      
      // Try to find local Chrome installation
      const { default: puppeteerFull } = await import('puppeteer');
      browser = await puppeteerFull.launch({
        headless: "new",
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-web-security'
        ],
        timeout: 60000
      });
      
      // Skip the rest of the browser launch since we already launched
      addLog(`✅ Local browser launched successfully`, 'success');
    }
    
    // Only launch if we haven't already (for local dev)
    if (!browser) {
      browser = await puppeteer.launch({
        args,
        defaultViewport: chromium.defaultViewport,
        executablePath,
        headless,
        ignoreHTTPSErrors: true,
        timeout: 60000
      });
      addLog(`✅ Browser launched successfully`, 'success');
    }

    // Use existing scan data or initialize new
    let visitedPages = scan.visitedPages ? new Set(scan.visitedPages) : new Set();
    let allIssues = scan.allIssues || {
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
    let pagesToCrawl = scan.pagesToCrawl || ['/'];
    let processedPages = visitedPages.size;

    // Update progress
    const updateProgress = () => {
      scan.progress = Math.min(90, (processedPages / Math.max(visitedPages.size + pagesToCrawl.length, 1)) * 100);
      scan.status = 'running';
      // Save state after progress update
      activeScans.set(scanId, scan);
      saveScans(activeScans);
    };
    
    // Check if scan should be stopped
    const shouldStop = () => {
      const currentScan = activeScans.get(scanId);
      return currentScan?.status === 'stopped';
    };
    
    // Simplified crawlPage function for brevity - you can expand this with your full logic
    async function crawlPage(pageUrl) {
      // Check if scan should be stopped before processing
      if (shouldStop()) {
        addLog(`🛑 Scan stopped by user`, 'info');
        return;
      }

      if (visitedPages.has(pageUrl)) return;
      visitedPages.add(pageUrl);
      processedPages++;
      updateProgress();
      
      const fullUrl = pageUrl.startsWith('http') ? pageUrl : baseUrl + pageUrl;
      addLog(`📄 Scanning: ${fullUrl}`, 'info');
      
      let page;
      try {
          page = await browser.newPage();
          await page.setViewport({ width: 1920, height: 1080 });
          await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
          
          const response = await page.goto(fullUrl, { 
              timeout: 30000,
              waitUntil: 'domcontentloaded'
          });
          
          if (!response || response.status() >= 40) {
              addLog(`❌ Page failed to load: ${fullUrl}`, 'error');
              allIssues.pageErrors.push({
                  url: fullUrl,
                  status: response?.status() || 'No response',
                  error: 'Page failed to load'
              });
              return;
          }
          
          addLog(`✅ Page loaded successfully`, 'success');
          
          // Test links (simplified version)
          const links = await page.evaluate((baseUrl) => {
              const allLinks = Array.from(document.querySelectorAll('a[href]'));
              return allLinks
                  .map(link => link.getAttribute('href'))
                  .filter(href => href && !href.startsWith('#') && !href.startsWith('mailto:'))
                  .slice(0, 5); // Limit for demo
          }, baseUrl);
          
          addLog(`🔗 Found ${links.length} links to test`, 'info');
          
          // Test each link
          for (const link of links) {
              try {
                  const response = await fetch(link, { 
                      method: 'HEAD',
                      timeout: 5000
                  });
                  
                  if (!response.ok) {
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
                  allIssues.brokenLinks.push({
                      page: fullUrl,
                      link,
                      status: 'ERROR',
                      error: error.message
                  });
              }
          }
          
      } catch (error) {
          addLog(`❌ Error crawling ${fullUrl}: ${error.message}`, 'error');
      } finally {
          if (page) {
              try {
                  await page.close();
              } catch (e) {
                  // Ignore close errors
              }
          }
      }
      
      addLog(`✅ Completed: ${fullUrl}`, 'success');
    }
    
    // Crawl pages (limit to 2 for demo)
    while (pagesToCrawl.length > 0 && visitedPages.size < 2) {
      // Check if scan should be stopped before processing next page
      if (shouldStop()) {
        addLog(`🛑 Scan stopped by user during processing`, 'info');
        scan.status = 'stopped';
        scan.endTime = new Date().toISOString();
        // Generate partial report
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
        scan.results = {
          summary,
          issues: allIssues,
          pages: Array.from(visitedPages)
        };
        scan.visitedPages = Array.from(visitedPages);
        scan.allIssues = allIssues;
        scan.pagesToCrawl = pagesToCrawl;
        activeScans.set(scanId, scan);
        saveScans(activeScans);
        return;
      }

      const currentUrl = pagesToCrawl.shift();
      await crawlPage(currentUrl);
    }
    
    // Check if scan was stopped before completing
    if (scan.status === 'stopped') {
      return;
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
    scan.endTime = new Date().toISOString();
    scan.results = {
      summary,
      issues: allIssues,
      pages: Array.from(visitedPages)
    };
    scan.visitedPages = Array.from(visitedPages);
    scan.allIssues = allIssues;
    scan.pagesToCrawl = pagesToCrawl;
    
    // Final save
    activeScans.set(scanId, scan);
    saveScans(activeScans);
    
    addLog(`🎉 Scan completed! Scanned ${summary.totalPages} pages`, 'success');
    
  } catch (error) {
    addLog(`💥 Scan failed: ${error.message}`, 'error');
    scan.status = 'error';
    scan.error = error.message;
    activeScans.set(scanId, scan);
    saveScans(activeScans);
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (error) {
        console.error('Error closing browser:', error);
      }
    }
  }
}
