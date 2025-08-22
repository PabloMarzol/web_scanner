// lib/scanner.js
import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';

export async function scanWebsite(baseUrl, scanId, activeScans) {
  const scan = activeScans.get(scanId);
  
  const addLog = (message, type = 'info') => {
    const logEntry = {
      timestamp: new Date().toISOString(),
      message,
      type
    };
    if (scan && scan.logs) {
      scan.logs.push(logEntry);
      
      if (scan.logs.length > 50) {
        scan.logs = scan.logs.slice(-50);
      }
    }
  };
  
  let browser = null;
  
  try {
    addLog(`🚀 Starting scan for ${baseUrl}`, 'info');
    
    // Configure chromium for Vercel
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
      ignoreHTTPSErrors: true,
    });
    
    addLog(`✅ Browser launched successfully`, 'info');
    
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
    
    addLog(`📄 Navigating to ${baseUrl}`, 'info');
    
    // Set progress to 20%
    scan.progress = 20;
    
    const response = await page.goto(baseUrl, { 
      waitUntil: 'domcontentloaded',
      timeout: 25000
    });
    
    if (!response || response.status() >= 400) {
      throw new Error(`Page failed to load: ${response?.status() || 'No response'}`);
    }
    
    addLog(`✅ Page loaded successfully (Status: ${response.status()})`, 'info');
    scan.progress = 40;
    
    await page.waitForTimeout(1000);
    
    // Extract links
    addLog(`🔍 Extracting links from page...`, 'info');
    const links = await page.evaluate((baseUrl) => {
      try {
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
          .slice(0, 8); // Limit to 8 links for Vercel timeout
      } catch (e) {
        console.error('Error extracting links:', e);
        return [];
      }
    }, baseUrl);
    
    addLog(`🔗 Found ${links.length} links to test`, 'info');
    scan.progress = 60;
    
    const brokenLinks = [];
    const workingLinks = [];
    
    // Test links
    for (let i = 0; i < links.length; i++) {
      const link = links[i];
      addLog(`Testing link ${i + 1}/${links.length}: ${link.substring(0, 50)}...`, 'info');
      
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3000);
        
        const linkResponse = await fetch(link, { 
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
        
        if (!linkResponse.ok) {
          brokenLinks.push({
            page: baseUrl,
            link,
            status: linkResponse.status,
            error: linkResponse.statusText
          });
          addLog(`❌ Broken link: ${link} (${linkResponse.status})`, 'warning');
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
          addLog(`❌ Error testing link: ${link}`, 'error');
        }
      }
      
      // Update progress
      scan.progress = 60 + ((i + 1) / links.length) * 30;
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
    if (scan) {
      scan.status = 'error';
      scan.error = error.message;
    }
  } finally {
    if (browser) {
      try {
        await browser.close();
        addLog(`🔒 Browser closed`, 'info');
      } catch (e) {
        // Ignore close errors
      }
    }
  }
}