// server.js
import express from 'express';
import { chromium } from 'playwright';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = process.env.PORT || 3001;

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
    
    const browser = await chromium.launch({
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox', 
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process',
            '--disable-gpu',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
            '--disable-features=TranslateUI',
            '--disable-ipc-flooding-protection'
        ]
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
      
      // Construct full URL properly
      const fullUrl = pageUrl.startsWith('http') ? pageUrl : baseUrl + pageUrl;
      
      addLog(`📄 Scanning: ${fullUrl}`, 'info');
      
      const context = await browser.newContext();
      const page = await context.newPage();
      
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
      
      try {
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
          await context.close();
          return;
        }
        
        // Wait for page to stabilize
        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {
          addLog(`⏰ NetworkIdle timeout for ${fullUrl}, continuing...`, 'warning');
        });
        
        // Test links
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
            .filter((href, index, array) => array.indexOf(href) === index);
        }, baseUrl);
        
        addLog(`  🔗 Found ${links.length} links to test`, 'info');
        
        let brokenLinksOnPage = 0;
        // Test each link
        for (const link of links.slice(0, 20)) {
          try {
            const linkResponse = await page.request.get(link, { timeout: 10000 });
            if (linkResponse.status() >= 400) {
              brokenLinksOnPage++;
              allIssues.brokenLinks.push({
                page: fullUrl,
                link,
                status: linkResponse.status(),
                error: linkResponse.statusText()
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
            brokenLinksOnPage++;
            allIssues.brokenLinks.push({
              page: fullUrl,
              link,
              status: 'ERROR',
              error: error.message
            });
          }
        }
        
        if (brokenLinksOnPage > 0) {
          addLog(`  ❌ Found ${brokenLinksOnPage} broken links on this page`, 'warning');
        }
        
        // Test buttons
        const buttons = await page.evaluate(() => {
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
        
        addLog(`  🔘 Found ${buttons.length} buttons to test`, 'info');
        
        let brokenButtonsOnPage = 0;
        let authIssuesOnPage = 0;
        
        // Test buttons (limit to 5 per page for performance)
        for (const buttonInfo of buttons.slice(0, 5)) {
          const buttonContext = await browser.newContext();
          const buttonPage = await buttonContext.newPage();
          
          const buttonErrors = [];
          buttonPage.on('console', (msg) => {
            if (msg.type() === 'error') buttonErrors.push(msg.text());
          });
          
          try {
            await buttonPage.goto(fullUrl, { timeout: 15000 });
            await buttonPage.waitForLoadState('domcontentloaded');
            
            const button = buttonPage.locator(`${buttonInfo.tagName}`).nth(buttonInfo.index);
            const isVisible = await button.isVisible({ timeout: 2000 }).catch(() => false);
            const isEnabled = await button.isEnabled().catch(() => false);
            
            if (isVisible && isEnabled) {
              await button.click({ timeout: 3000 });
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
          } catch (error) {
            brokenButtonsOnPage++;
            allIssues.brokenButtons.push({
              page: fullUrl,
              button: buttonInfo.text,
              errors: [error.message]
            });
          }
          
          await buttonContext.close();
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
      }
      
      await context.close();
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

app.listen(port, () => {
  console.log(`Testing server running at http://localhost:${port}`);
});