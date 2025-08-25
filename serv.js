// server.js
import express from 'express';
import puppeteer from 'puppeteer';
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

app.post('/api/scan', async (req, res) => {
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

async function scanWebsite(baseUrl, scanId) {
  const scan = activeScans.get(scanId);
  
  // Add logs array to store real-time updates
  scan.logs = [];
  
  // Helper function to add logs
  const addLog = (message, type = 'info') => {
    const logEntry = {
      timestamp: new Date().toISOString(),
      message,
      type // 'info', 'success', 'warning', 'error'
    };
    scan.logs.push(logEntry);
    console.log(message); // Still log to console
    
    // Keep only last 50 logs to prevent memory issues
    if (scan.logs.length > 50) {
      scan.logs = scan.logs.slice(-50);
    }
  };
  
  try {
    addLog(`🚀 Starting scan for ${baseUrl}`, 'info');
    
    const browser = await puppeteer.launch({
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-web-security'
        ],
        executablePath: process.env.NODE_ENV === 'production' 
            ? await chromium.executablePath()
            : undefined,
        headless: "new",
        timeout: 60000
    });
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
            
            // Set viewport and user agent
            await page.setViewport({ width: 1920, height: 1080 });
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
            
            const pageIssues = {
            url: fullUrl,
            errors: [],
            warnings: []
            };
            
            page.on('console', (msg) => {
            const text = msg.text();
            if (msg.type() === 'error') {
                pageIssues.errors.push(text);
            } else if (msg.type() === 'warning' && text.includes('Warning:')) {
                pageIssues.warnings.push(text);
            }
            });
            
            // Set longer timeouts and better error handling
            page.setDefaultTimeout(30000);
            page.setDefaultNavigationTimeout(30000);
            
            const response = await page.goto(fullUrl, { 
            timeout: 30000,
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
            
            // Wait for page to stabilize with better error handling
            try {
            await page.waitForTimeout(2000); // Give page time to load
            addLog(`  ✅ Page loaded successfully`, 'info');
            } catch (error) {
            addLog(`⏰ Page stabilization timeout for ${fullUrl}, continuing...`, 'warning');
            }
            
            // Test links with better error handling
            let links = [];
            try {
            links = await page.evaluate((baseUrl) => {
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
                .filter((href, index, array) => array.indexOf(href) === index);
            }, baseUrl);
            } catch (error) {
            addLog(`❌ Error extracting links: ${error.message}`, 'error');
            links = [];
            }
            
            addLog(`  🔗 Found ${links.length} links to test`, 'info');
            
            let brokenLinksOnPage = 0;
            // Test each link with better error handling
            for (const link of links.slice(0, 15)) { // Reduced to 15 for stability
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 10000);
                
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
                
                try {
                    const linkUrl = new URL(link);
                    const baseUrlObj = new URL(baseUrl);
                    if (linkUrl.hostname === baseUrlObj.hostname) {
                    const relativePath = linkUrl.pathname + linkUrl.search;
                    if (!visitedPages.has(relativePath) && !pagesToCrawl.includes(relativePath)) {
                        pagesToCrawl.push(relativePath);
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
            addLog(`  ❌ Found ${brokenLinksOnPage} broken links on this page`, 'warning');
            }
            
            // Test buttons with better error handling
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
            
            addLog(`  🔘 Found ${buttons.length} buttons to test`, 'info');
            
            let brokenButtonsOnPage = 0;
            let authIssuesOnPage = 0;
            
            // Test buttons (limit to 3 per page for stability)
            for (const buttonInfo of buttons.slice(0, 3)) {
            let buttonPage;
            try {
                buttonPage = await browser.newPage();
                await buttonPage.setViewport({ width: 1920, height: 1080 });
                
                const buttonErrors = [];
                buttonPage.on('console', (msg) => {
                if (msg.type() === 'error') buttonErrors.push(msg.text());
                });
                
                await buttonPage.goto(fullUrl, { timeout: 15000, waitUntil: 'domcontentloaded' });
                await buttonPage.waitForTimeout(1000);
                
                // More reliable button selection
                let button;
                if (buttonInfo.id) {
                button = await buttonPage.$(`#${buttonInfo.id}`);
                } else {
                const buttons = await buttonPage.$$(`${buttonInfo.tagName.toLowerCase()}`);
                button = buttons[buttonInfo.index];
                }
                
                if (button) {
                const isVisible = await button.isIntersectingViewport();
                
                if (isVisible) {
                    await button.click();
                    await buttonPage.waitForTimeout(1000);
                    
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
            addLog(`  ❌ Found ${brokenButtonsOnPage} broken buttons on this page`, 'warning');
            }
            
            if (authIssuesOnPage > 0) {
            addLog(`  🔐 Found ${authIssuesOnPage} authentication issues on this page`, 'warning');
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
                // Ignore close errors
            }
            }
        }
        
        addLog(`  ✅ Completed: ${fullUrl}`, 'success');
        }
    
    // Crawl pages (limit to 10 pages for demo)
    while (pagesToCrawl.length > 0 && visitedPages.size < 10) {
      const currentUrl = pagesToCrawl.shift();
      await crawlPage(currentUrl);
    }
    
    await browser.close();
    
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
    
    addLog(`🎉 Scan completed! Scanned ${summary.totalPages} pages, found ${summary.brokenLinksCount} broken links and ${summary.brokenButtonsCount} broken buttons`, 'success');
    
  } catch (error) {
    addLog(`💥 Scan failed: ${error.message}`, 'error');
    scan.status = 'error';
    scan.error = error.message;
  }
}

const port = process.env.PORT || 3001; // Use 3001 locally, Render's port in production
const host = process.env.NODE_ENV === 'production' ? '0.0.0.0' : 'localhost';

const server = app.listen(port, host, () => {
  const displayHost = host === '0.0.0.0' ? 'localhost' : host;
  console.log(`🚀 WebScan Pro server running on http://${displayHost}:${port}`);
  console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
  
  if (process.env.NODE_ENV !== 'production') {
    console.log(`📱 Local access: http://localhost:${port}`);
  }
});

// Configure timeouts for cloud deployment
server.keepAliveTimeout = 120000; // 2 minutes
server.headersTimeout = 120000; // 2 minutes

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

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
  console.error('💥 Uncaught Exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});