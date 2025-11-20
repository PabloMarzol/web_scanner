import express from 'express';
import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import pkg from 'pg';
import { parse as parseUrl } from 'url';
import { ethers } from 'ethers';
import axios from 'axios';
const { Pool } = pkg;
import dotenv from "dotenv";
dotenv.config()

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static('public', { index: false })); // Serve static files but disable default index.html

// Serve landing page on /
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'landing.html'));
});

// Serve the main app on /app
app.get('/app', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// JWT secret for authentication
const JWT_SECRET = process.env.JWT_SECRET || 'webscan-pro-secret-key-change-in-production';

// PostgreSQL connection - Parse DATABASE_URL explicitly to handle special characters in password
let poolConfig = {
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 20, // Maximum number of clients in the pool
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
};

if (process.env.DATABASE_URL) {
  try {
    // Parse the DATABASE_URL to extract components explicitly
    const url = new URL(process.env.DATABASE_URL);

    poolConfig = {
      ...poolConfig,
      host: url.hostname,
      port: parseInt(url.port) || 5432,
      database: url.pathname.slice(1), // Remove leading slash
      user: url.username,
      password: decodeURIComponent(url.password), // Explicitly decode the password
    };

    // Disable SSL for local development databases
    const isLocalDatabase = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname.includes('local');
    if (isLocalDatabase) {
      poolConfig.ssl = false;
    }
  } catch (error) {
    console.error('Error parsing DATABASE_URL:', error);
    // Fallback to connectionString if parsing fails
    poolConfig.connectionString = process.env.DATABASE_URL;
  }
}

const pool = new Pool(poolConfig);

// Test database connection
pool.on('connect', () => {
  console.log('Connected to PostgreSQL database');
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
  process.exit(-1);
});

// Initialize database tables
async function initializeDatabase() {
  try {
    // Create tables if they don't exist
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        wallet_address VARCHAR(42) UNIQUE NOT NULL,
        subscription_tier VARCHAR(20) NOT NULL DEFAULT 'free' CHECK (subscription_tier IN ('free', 'pro')),
        subscription_status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (subscription_status IN ('active', 'inactive', 'cancelled', 'expired')),
        subscription_start_date TIMESTAMP WITH TIME ZONE,
        subscription_end_date TIMESTAMP WITH TIME ZONE,
        scans_used_this_month INTEGER NOT NULL DEFAULT 0,
        monthly_scan_limit INTEGER NOT NULL DEFAULT 5,
        last_scan_date DATE,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS scans (
        id SERIAL PRIMARY KEY,
        scan_id VARCHAR(100) UNIQUE NOT NULL,
        user_wallet_address VARCHAR(42) NOT NULL REFERENCES users(wallet_address) ON DELETE CASCADE,
        target_url TEXT NOT NULL,
        scan_depth VARCHAR(20) NOT NULL DEFAULT 'balanced',
        pages_scanned INTEGER NOT NULL DEFAULT 0,
        issues_found INTEGER NOT NULL DEFAULT 0,
        scan_status VARCHAR(20) NOT NULL DEFAULT 'completed',
        scan_duration_seconds INTEGER,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
        completed_at TIMESTAMP WITH TIME ZONE
      );

      CREATE TABLE IF NOT EXISTS scan_sessions (
        id SERIAL PRIMARY KEY,
        scan_id VARCHAR(100) UNIQUE NOT NULL,
        user_wallet_address VARCHAR(42) NOT NULL REFERENCES users(wallet_address) ON DELETE CASCADE,
        scan_data JSONB NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'paused', 'completed', 'error')),
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS payments (
        id SERIAL PRIMARY KEY,
        payment_id VARCHAR(100) UNIQUE NOT NULL,
        user_wallet_address VARCHAR(42) NOT NULL REFERENCES users(wallet_address) ON DELETE CASCADE,
        plan VARCHAR(20) NOT NULL,
        amount DECIMAL(10,2) NOT NULL,
        currency VARCHAR(10) NOT NULL DEFAULT 'USD',
        payment_status VARCHAR(20) NOT NULL DEFAULT 'pending',
        nowpayments_order_id VARCHAR(100),
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_users_wallet_address ON users(wallet_address);
      CREATE INDEX IF NOT EXISTS idx_scans_user_wallet ON scans(user_wallet_address);
      CREATE INDEX IF NOT EXISTS idx_scan_sessions_scan_id ON scan_sessions(scan_id);
      CREATE INDEX IF NOT EXISTS idx_scan_sessions_user ON scan_sessions(user_wallet_address);
      CREATE INDEX IF NOT EXISTS idx_payments_user_wallet ON payments(user_wallet_address);
    `);

    console.log('Database tables initialized successfully');
  } catch (error) {
    console.error('Error initializing database:', error);
  }
}

// Initialize database on startup
initializeDatabase();

// Middleware to verify JWT tokens
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
    req.user = user;
    next();
  });
};

// Store active scans with enhanced state management
const activeScans = new Map();
const nonces = new Map(); // Store nonces for wallet authentication

// Enhanced scan state management with database persistence
class ScanStateManager {
  constructor() {
    this.scanSessions = new Map();
  }

  async saveScanSession(scanId, scanData) {
    try {
      // Store scan session in database for persistence
      await pool.query(`
        INSERT INTO scan_sessions (scan_id, user_wallet_address, scan_data, status, created_at, updated_at)
        VALUES ($1, $2, $3, $4, NOW(), NOW())
        ON CONFLICT (scan_id) DO UPDATE SET
          scan_data = $3,
          status = $4,
          updated_at = NOW()
      `, [scanId, scanData.user, JSON.stringify(scanData), scanData.status]);

      this.scanSessions.set(scanId, scanData);
    } catch (error) {
      console.error('Error saving scan session:', error);
    }
  }

  async loadScanSession(scanId) {
    try {
      const result = await pool.query(
        'SELECT * FROM scan_sessions WHERE scan_id = $1',
        [scanId]
      );

      if (result.rows.length > 0) {
        const session = JSON.parse(result.rows[0].scan_data);
        this.scanSessions.set(scanId, session);
        return session;
      }
      return null;
    } catch (error) {
      console.error('Error loading scan session:', error);
      return null;
    }
  }

  async updateScanStatus(scanId, status) {
    try {
      await pool.query(
        'UPDATE scan_sessions SET status = $1, updated_at = NOW() WHERE scan_id = $2',
        [status, scanId]
      );
    } catch (error) {
      console.error('Error updating scan status:', error);
    }
  }

  async deleteScanSession(scanId) {
    try {
      await pool.query('DELETE FROM scan_sessions WHERE scan_id = $1', [scanId]);
      this.scanSessions.delete(scanId);
    } catch (error) {
      console.error('Error deleting scan session:', error);
    }
  }

  getScanSession(scanId) {
    return this.scanSessions.get(scanId);
  }

  setScanSession(scanId, scanData) {
    this.scanSessions.set(scanId, scanData);
  }

  hasScanSession(scanId) {
    return this.scanSessions.has(scanId);
  }
}

const scanStateManager = new ScanStateManager();

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

// --- Authentication Endpoints ---

app.post('/api/auth/nonce', async (req, res) => {
  const { address } = req.body;
  if (!address) return res.status(400).json({ error: 'Address required' });

  const nonce = crypto.randomBytes(16).toString('hex');
  nonces.set(address.toLowerCase(), nonce);
  res.json({ nonce });
});

app.post('/api/auth/verify', async (req, res) => {
  const { address, signature } = req.body;
  if (!address || !signature) return res.status(400).json({ error: 'Missing params' });

  const nonce = nonces.get(address.toLowerCase());
  if (!nonce) return res.status(400).json({ error: 'Nonce not found' });

  try {
    const message = `Sign this message to verify your ownership of the wallet address: ${address}\nNonce: ${nonce}`;
    const recoveredAddress = ethers.verifyMessage(message, signature);

    if (recoveredAddress.toLowerCase() !== address.toLowerCase()) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    nonces.delete(address.toLowerCase());

    // Create/Update user
    const result = await pool.query(`
      INSERT INTO users (wallet_address) 
      VALUES ($1) 
      ON CONFLICT (wallet_address) DO UPDATE SET updated_at = NOW()
      RETURNING *
    `, [address.toLowerCase()]);

    const user = result.rows[0];
    const token = jwt.sign({
      id: user.id,
      wallet_address: user.wallet_address,
      subscription_tier: user.subscription_tier
    }, JWT_SECRET, { expiresIn: '24h' });

    res.json({
      token, user: {
        walletAddress: user.wallet_address,
        subscriptionTier: user.subscription_tier
      }
    });
  } catch (error) {
    console.error('Auth error:', error);
    res.status(500).json({ error: 'Authentication failed' });
  }
});

// Verify Token Endpoint (Required for App)
app.post('/api/auth/verify-token', authenticateToken, (req, res) => {
  // If the middleware passes, the token is valid and req.user is populated
  res.json({
    valid: true,
    user: {
      walletAddress: req.user.wallet_address,
      subscriptionTier: req.user.subscription_tier
    }
  });
});

app.get('/api/user/subscription', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT subscription_tier, scans_used_this_month, monthly_scan_limit FROM users WHERE id = $1', [req.user.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });

    const user = result.rows[0];
    res.json({
      tier: user.subscription_tier,
      scansUsed: user.scans_used_this_month,
      limit: user.monthly_scan_limit
    });
  } catch (error) {
    res.status(500).json({ error: 'Database error' });
  }
});

// --- Payment Endpoints (NowPayments) ---

app.post('/api/create-payment', authenticateToken, async (req, res) => {
  const { plan, price_amount, price_currency, pay_currency } = req.body;
  const apiKey = process.env.NOWPAYMENTS_API_KEY;

  if (!apiKey) return res.status(500).json({ error: 'Payment configuration missing' });

  try {
    const response = await axios.post('https://api.nowpayments.io/v1/invoice', {
      price_amount,
      price_currency,
      pay_currency,
      ipn_callback_url: `${process.env.API_URL || 'http://localhost:3000'}/api/payment-webhook`,
      order_id: `ORDER-${Date.now()}-${req.user.id}`,
      order_description: `Subscription to ${plan} plan`
    }, {
      headers: { 'x-api-key': apiKey }
    });

    // Store payment intent
    await pool.query(`
            INSERT INTO payments (payment_id, user_wallet_address, plan, amount, currency, nowpayments_order_id)
            VALUES ($1, $2, $3, $4, $5, $6)
        `, [response.data.id, req.user.wallet_address, plan, price_amount, price_currency, response.data.order_id]);

    res.json({ invoice_url: response.data.invoice_url });
  } catch (error) {
    console.error('Payment creation error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to create payment' });
  }
});

app.post('/api/payment-webhook', async (req, res) => {
  const ipnSecret = process.env.NOWPAYMENTS_IPN_SECRET;
  const signature = req.headers['x-nowpayments-sig'];

  if (!ipnSecret || !signature) return res.status(400).send('Missing signature or secret');

  // Verify signature
  const sortedData = Object.keys(req.body).sort().reduce((obj, key) => {
    obj[key] = req.body[key];
    return obj;
  }, {});
  const jsonString = JSON.stringify(sortedData);
  const hmac = crypto.createHmac('sha512', ipnSecret);
  const calculatedSig = hmac.update(jsonString).digest('hex');

  if (calculatedSig !== signature) {
    return res.status(400).send('Invalid signature');
  }

  const { payment_status, order_id } = req.body;

  if (payment_status === 'finished') {
    // Extract user ID or wallet from order_id (assuming format ORDER-TIMESTAMP-USERID)
    // But wait, I stored wallet_address in payments table, I should look it up by order_id
    try {
      // Update payment status
      await pool.query('UPDATE payments SET payment_status = $1 WHERE nowpayments_order_id = $2', [payment_status, order_id]);

      // Get user wallet from payment
      const paymentResult = await pool.query('SELECT user_wallet_address, plan FROM payments WHERE nowpayments_order_id = $1', [order_id]);

      if (paymentResult.rows.length > 0) {
        const { user_wallet_address, plan } = paymentResult.rows[0];

        // Update user subscription
        let tier = 'free';
        if (plan === 'pro') tier = 'pro';
        // Add other plans as needed

        await pool.query(`
                    UPDATE users 
                    SET subscription_tier = $1, 
                        monthly_scan_limit = 999999, 
                        subscription_status = 'active',
                        updated_at = NOW()
                    WHERE wallet_address = $2
                 `, [tier, user_wallet_address]);
      }
    } catch (error) {
      console.error('Webhook processing error:', error);
    }
  }

  res.send('OK');
});

app.post('/api/scan', authenticateToken, async (req, res) => {
  try {
    const { url, scanId, options = {} } = req.body;
    const user = req.user;

    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    // Check Usage Limits
    const userResult = await pool.query('SELECT * FROM users WHERE id = $1', [user.id]);
    const userData = userResult.rows[0];

    // Reset monthly count if new month
    const now = new Date();
    const lastScan = userData.last_scan_date ? new Date(userData.last_scan_date) : new Date(0);
    if (now.getMonth() !== lastScan.getMonth() || now.getFullYear() !== lastScan.getFullYear()) {
      await pool.query('UPDATE users SET scans_used_this_month = 0 WHERE id = $1', [user.id]);
      userData.scans_used_this_month = 0;
    }

    if (userData.subscription_tier === 'free' && userData.scans_used_this_month >= userData.monthly_scan_limit) {
      return res.status(403).json({ error: 'Monthly scan limit reached. Please upgrade to Pro.' });
    }

    // Increment scan count
    await pool.query(`
        UPDATE users 
        SET scans_used_this_month = scans_used_this_month + 1, 
            last_scan_date = NOW() 
        WHERE id = $1
    `, [user.id]);

    // Validate URL
    try {
      new URL(url);
    } catch {
      return res.status(400).json({ error: 'Invalid URL format' });
    }

    // Enhanced scan configuration with depth-specific defaults
    const isProduction = process.env.NODE_ENV === 'production';
    const scanDepth = options.scanDepth || options.testDepth || 'balanced';

    // Apply scan depth configurations
    let depthConfig = {};
    switch (scanDepth) {
      case 'fast':
        depthConfig = {
          maxPages: options.maxPages || (isProduction ? 25 : 25),
          maxLinks: options.maxLinks || 10,
          maxButtons: options.maxButtons || 2,
          includeButtons: options.includeButtons !== false,
          includeForms: options.includeForms !== undefined ? options.includeForms : false,
          includeResources: options.includeResources !== undefined ? options.includeResources : false,
          includePerformance: options.includePerformance !== undefined ? options.includePerformance : false,
          includeSEO: options.includeSEO !== false,
          timeoutPerPage: options.timeoutPerPage || 5000,
          buttonTimeout: options.buttonTimeout || 1000
        };
        break;
      case 'deep':
        depthConfig = {
          maxPages: options.maxPages || (isProduction ? 100 : 150),
          maxLinks: options.maxLinks || 50,
          maxButtons: options.maxButtons || 10,
          includeButtons: options.includeButtons !== false,
          includeForms: options.includeForms !== false,
          includeResources: options.includeResources !== false,
          includePerformance: options.includePerformance !== false,
          includeSEO: options.includeSEO !== false,
          timeoutPerPage: options.timeoutPerPage || 12000,
          buttonTimeout: options.buttonTimeout || 3000
        };
        break;
      default: // 'balanced'
        depthConfig = {
          maxPages: options.maxPages || (isProduction ? 50 : 75),
          maxLinks: options.maxLinks || 25,
          maxButtons: options.maxButtons || 5,
          includeButtons: options.includeButtons !== false,
          includeForms: options.includeForms !== false,
          includeResources: options.includeResources !== false,
          includePerformance: options.includePerformance !== false,
          includeSEO: options.includeSEO !== false,
          timeoutPerPage: options.timeoutPerPage || 8000,
          buttonTimeout: options.buttonTimeout || 2000
        };
    }

    const scanOptions = {
      ...depthConfig,
      useSitemap: options.useSitemap !== false,
      timeout: options.timeout || 30000,
      comprehensive: options.comprehensive !== false,
      testDepth: scanDepth,
      scanDepth: scanDepth,
      scanName: options.scanName || `${scanDepth.charAt(0).toUpperCase() + scanDepth.slice(1)} Scan`
    };

    const scan = {
      id: scanId,
      status: 'running',
      progress: 0,
      url,
      options: scanOptions,
      startTime: new Date(),
      results: null,
      // Enhanced section-specific tracking
      sectionProgress: {
        links: { status: 'pending', progress: 0, completed: false, total: 0, tested: 0 },
        buttons: { status: 'pending', progress: 0, completed: false, total: 0, tested: 0 },
        seo: { status: 'pending', progress: 0, completed: false, total: 0, tested: 0 },
        performance: { status: 'pending', progress: 0, completed: false, total: 0, tested: 0 },
        forms: { status: 'pending', progress: 0, completed: false, total: 0, tested: 0 },
        resources: { status: 'pending', progress: 0, completed: false, total: 0, tested: 0 }
      },
      logs: []
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

// SECTION-SPECIFIC REPORT ENDPOINTS
app.get('/api/scan/:scanId/section/:section', (req, res) => {
  try {
    const { scanId, section } = req.params;
    const scan = activeScans.get(scanId);

    if (!scan) {
      return res.status(404).json({ error: 'Scan not found' });
    }

    if (!scan.results) {
      return res.status(400).json({ error: 'Scan not completed yet' });
    }

    // Generate section-specific report
    const sectionReport = generateSectionReport(scan, section);

    if (!sectionReport) {
      return res.status(400).json({ error: `Invalid section: ${section}` });
    }

    res.json(sectionReport);
  } catch (error) {
    console.error('GET /api/scan/:scanId/section/:section error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Helper function to generate section-specific reports
function generateSectionReport(scan, section) {
  const { results, sectionProgress, startTime, endTime, options } = scan;
  const { summary, issues } = results;

  const baseMetadata = {
    generatedAt: new Date().toISOString(),
    scanId: scan.id,
    url: scan.url,
    scanType: options.scanDepth || 'balanced',
    scanDuration: endTime ? Math.round((new Date(endTime) - new Date(startTime)) / 1000) : null,
    sectionStatus: sectionProgress[section] || { status: 'unknown' }
  };

  switch (section) {
    case 'links':
      return {
        metadata: { ...baseMetadata, section: 'Links Analysis' },
        summary: {
          totalLinks: summary.totalLinks,
          brokenLinks: summary.brokenLinksCount,
          workingLinks: summary.totalLinks - summary.brokenLinksCount,
          pages: summary.totalPages
        },
        brokenLinks: issues.brokenLinks || [],
        workingLinks: issues.workingLinks || []
      };

    case 'buttons':
      return {
        metadata: { ...baseMetadata, section: 'Interactive Elements Analysis' },
        summary: {
          totalButtons: summary.totalButtons,
          brokenButtons: summary.brokenButtonsCount,
          workingButtons: summary.totalButtons - summary.brokenButtonsCount,
          authIssues: summary.authIssuesCount
        },
        brokenButtons: issues.brokenButtons || [],
        workingButtons: issues.workingButtons || [],
        authErrors: issues.authErrors || [],
        enhancedResults: issues.enhancedButtonResults || []
      };

    case 'seo':
      return {
        metadata: { ...baseMetadata, section: 'SEO Analysis' },
        summary: {
          pagesAnalyzed: issues.seoData ? issues.seoData.length : 0,
          issuesFound: summary.seoIssuesCount || 0,
          averageIssuesPerPage: issues.seoData ?
            Math.round((summary.seoIssuesCount || 0) / issues.seoData.length * 100) / 100 : 0
        },
        seoData: issues.seoData || [],
        seoIssues: issues.seoIssues || []
      };

    case 'performance':
      return {
        metadata: { ...baseMetadata, section: 'Performance Analysis' },
        summary: {
          pagesAnalyzed: issues.performanceData ? issues.performanceData.length : 0,
          slowPages: summary.performanceIssuesCount || 0,
          averagePageSize: summary.averagePageSize || 0,
          averageFCP: summary.averageFCP || 0
        },
        performanceData: issues.performanceData || []
      };

    case 'forms':
      return {
        metadata: { ...baseMetadata, section: 'Forms Analysis' },
        summary: {
          formsFound: summary.formsTestedCount || 0,
          workingForms: issues.workingLinks ? issues.workingLinks.filter(l => l.type === 'form').length : 0,
          brokenForms: issues.brokenLinks ? issues.brokenLinks.filter(l => l.type === 'form').length : 0
        },
        workingForms: issues.workingLinks ? issues.workingLinks.filter(l => l.type === 'form') : [],
        brokenForms: issues.brokenLinks ? issues.brokenLinks.filter(l => l.type === 'form') : []
      };

    case 'resources':
      return {
        metadata: { ...baseMetadata, section: 'Resources Analysis' },
        summary: {
          resourcesChecked: summary.resourcesTestedCount || 0,
          missingResources: summary.missingResourcesCount || 0,
          workingResources: (summary.resourcesTestedCount || 0) - (summary.missingResourcesCount || 0)
        },
        missingResources: issues.missingResources || [],
        workingResources: issues.workingLinks ? issues.workingLinks.filter(l => l.type === 'resource') : []
      };

    default:
      return null;
  }
}

async function scanWebsite(baseUrl, scanId, options = {}) {
  let browser;
  const scan = activeScans.get(scanId);

  if (!scan) {
    console.log(`Scan ${scanId} not found in activeScans`);
    return;
  }

  // Enhanced scan state management with better error handling
  const scanState = {
    isCancelled: false,
    isPaused: false,
    lastProgressUpdate: Date.now(),
    memoryCheckInterval: null
  };

  // Add cancellation/pause methods to scan object
  scan.cancel = () => { scanState.isCancelled = true; };
  scan.pause = () => { scanState.isPaused = true; };
  scan.resume = () => { scanState.isPaused = false; };

  // Memory monitoring
  scanState.memoryCheckInterval = setInterval(() => {
    const memoryUsage = process.memoryUsage();
    const heapUsedMB = Math.round(memoryUsage.heapUsed / 1024 / 1024);

    if (heapUsedMB > 800) { // High memory usage
      addLog(`⚠️ High memory usage: ${heapUsedMB}MB - Consider reducing scan depth`, 'warning');
    }

    // Force garbage collection if available
    if (global.gc && heapUsedMB > 1000) {
      global.gc();
      addLog(`🔄 Garbage collection triggered due to high memory (${heapUsedMB}MB)`, 'info');
    }
  }, 30000); // Check every 30 seconds
  async function scanWebsite(baseUrl, scanId, options = {}) {
    let browser;
    const scan = activeScans.get(scanId);

    if (!scan) {
      console.log(`Scan ${scanId} not found in activeScans`);
      return;
    }

    // Enhanced scan state management with better error handling
    const scanState = {
      isCancelled: false,
      isPaused: false,
      lastProgressUpdate: Date.now(),
      memoryCheckInterval: null
    };

    // Add cancellation/pause methods to scan object
    scan.cancel = () => { scanState.isCancelled = true; };
    scan.pause = () => { scanState.isPaused = true; };
    scan.resume = () => { scanState.isPaused = false; };

    // Memory monitoring
    scanState.memoryCheckInterval = setInterval(() => {
      const memoryUsage = process.memoryUsage();
      const heapUsedMB = Math.round(memoryUsage.heapUsed / 1024 / 1024);

      if (heapUsedMB > 800) { // High memory usage
        addLog(`⚠️ High memory usage: ${heapUsedMB}MB - Consider reducing scan depth`, 'warning');
      }

      // Force garbage collection if available
      if (global.gc && heapUsedMB > 1000) {
        global.gc();
        addLog(`🔄 Garbage collection triggered due to high memory (${heapUsedMB}MB)`, 'info');
      }
    }, 30000); // Check every 30 seconds

    // ENHANCED SECTION TRACKING HELPERS
    const updateSectionProgress = (section, tested, total, status = 'running') => {
      if (scan && scan.sectionProgress && scan.sectionProgress[section]) {
        scan.sectionProgress[section].tested = tested;
        scan.sectionProgress[section].total = total;
        scan.sectionProgress[section].progress = total > 0 ? Math.round((tested / total) * 100) : 0;
        scan.sectionProgress[section].status = status;
        scan.sectionProgress[section].completed = status === 'completed';
      }
    };

    const completeSectionWithLog = (section, tested, issues, type = 'success') => {
      const timestamp = new Date().toLocaleTimeString('en-GB', { hour12: false });
      let message = '';

      switch (section) {
        case 'links':
          message = `Links scan completed - ${tested} links tested, ${issues} broken`;
          break;
        case 'buttons':
          message = `Buttons scan completed - ${tested} buttons tested, ${issues} issues found`;
          break;
        case 'seo':
          message = `SEO scan completed - ${tested} pages analyzed, ${issues} issues found`;
          break;
        case 'performance':
          message = `Performance scan completed - ${tested} pages analyzed, ${issues} slow pages`;
          break;
        case 'forms':
          message = `Forms scan completed - ${tested} forms found, ${issues} issues`;
          break;
        case 'resources':
          message = `Resources scan completed - ${tested} resources checked, ${issues} missing`;
          break;
      }

      updateSectionProgress(section, tested, tested, 'completed');
      addLog(`✅ [${timestamp}] ${message}`, type);

      // Log to console with timestamp
      console.log(`[${scanId}] ✅ [${timestamp}] ${message}`);
    };

    const startSectionWithLog = (section, estimated) => {
      const timestamp = new Date().toLocaleTimeString('en-GB', { hour12: false });
      const sectionName = section.charAt(0).toUpperCase() + section.slice(1);

      updateSectionProgress(section, 0, estimated, 'running');
      addLog(`🔄 [${timestamp}] Starting ${sectionName} analysis...`, 'info');

      console.log(`[${scanId}] 🔄 [${timestamp}] Starting ${sectionName} analysis...`);
    };

    // FIXED: Reset logs array for each new scan to prevent accumulation
    scan.logs = [];
    console.log(`\n ============ STARTING NEW SCAN: ${scanId} ============`);

    // Helper function to add logs
    const addLog = (message, type = 'info') => {
      if (scanState.isCancelled) return;

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
          timeout: 6000
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
        // New categories
        performanceData: [],
        seoData: [],
        seoIssues: [],
        formIssues: [],
        resourceIssues: []
      };

      const pagesToCrawl = ['/'];
      let processedPages = 0;

      // Update progress with better calculation for scans
      const updateProgress = () => {
        if (scanState.isCancelled) return;

        const totalExpected = Math.max(visitedPages.size + pagesToCrawl.length, 10);
        const progressPercent = Math.min(90, (processedPages / totalExpected) * 100);
        scan.progress = progressPercent;
        scan.status = 'running';

        // Add progress details to logs every 10 pages
        if (processedPages % 10 === 0 && processedPages > 0) {
          addLog(` Progress: ${processedPages} pages scanned, ${pagesToCrawl.length} in queue`, 'info');
        }

        // Update scan status in database periodically
        if (Date.now() - scanState.lastProgressUpdate > 30000) { // Every 30 seconds
          scanStateManager.updateScanStatus(scanId, 'running');
          scanState.lastProgressUpdate = Date.now();
        }
      };

      async function crawlPage(pageUrl) {
        if (scanState.isCancelled) return;
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
              if (req.resourceType() == 'stylesheet' || req.resourceType() == 'image' || req.resourceType() == 'font') {
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
          const waitTime = isRenderProduction ? 100 : 2000;
          await new Promise(resolve => setTimeout(resolve, waitTime));
          addLog(` Page loaded successfully`, 'success');

          // Initialize section tracking for this page
          if (processedPages === 1) {
            // Start sections on first page - estimate totals
            startSectionWithLog('links', linkLimit * Math.min(pageLimit, 10));
            if (options.includeButtons) startSectionWithLog('buttons', maxButtonsPerPage * Math.min(pageLimit, 10));
            if (options.includeSEO) startSectionWithLog('seo', Math.min(pageLimit, 20));
            if (options.includePerformance) startSectionWithLog('performance', Math.min(pageLimit, 20));
            if (options.includeForms) startSectionWithLog('forms', 10); // Estimated
            if (options.includeResources) startSectionWithLog('resources', 50); // Estimated
          }
          // Try to find sitemap.xml for page discovery
          if (processedPages === 1) { // Only try on first page
            await discoverAdditionalPages(baseUrl, pagesToCrawl, visitedPages, addLog);
          }

          // ENHANCED link discovery
          let links = [];
          try {
            links = await page.evaluate((baseUrl, limit) => {
              const processedLinks = [];
              const baseUrlObj = new URL(baseUrl);

              // 1. Standard navigation links
              const navLinks = Array.from(document.querySelectorAll('a[href]'));

              // 2. Links in navigation menus (more selectors)
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
          let linksTestedTotal = 0;

          // Update section progress for links
          updateSectionProgress('links',
            (allIssues.brokenLinks.length + allIssues.workingLinks.length),
            linkLimit * Math.min(pageLimit, 10),
            'running'
          );

          for (const link of links) {
            if (scanState.isCancelled) break;

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

                // Add working internal links to crawl queue for scanning
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

          // Complete links section when all pages are done
          if (processedPages >= pageLimit || pagesToCrawl.length === 0) {
            const totalLinksChecked = allIssues.brokenLinks.length + allIssues.workingLinks.length;
            completeSectionWithLog('links', totalLinksChecked, allIssues.brokenLinks.length);
          }

          // ENHANCED BUTTON TESTING - Deep Analysis System
          if (options.includeButtons !== false) {
            // PERFORMANCE OPTIMIZATION: Skip button testing on certain page types
            const shouldSkipButtonTesting = (
              fullUrl.includes('/api/') ||
              fullUrl.includes('.json') ||
              fullUrl.includes('/sitemap') ||
              fullUrl.includes('/robots.txt') ||
              fullUrl.includes('/_next/') ||
              fullUrl.includes('/assets/') ||
              fullUrl.endsWith('.xml') ||
              fullUrl.endsWith('.txt') ||
              processedPages > 20 // Skip button testing after 20 pages
            );

            if (shouldSkipButtonTesting) {
              addLog(` Skipping button testing for performance (API/resource page or limit reached)`, 'info');
            } else {
              let buttons = [];

              // INJECT UTILITY FUNCTIONS for better element selection
              try {
                await page.evaluateOnNewDocument(() => {
                  // Generate XPath for element
                  window.getElementXPath = function (element) {
                    if (!element || !element.tagName) return null;
                    if (element.id !== '') {
                      return `id("${element.id}")`;
                    }
                    if (element === document.body) {
                      return element.tagName;
                    }
                    let ix = 0;
                    const siblings = element.parentNode ? element.parentNode.childNodes : [];
                    for (let i = 0; i < siblings.length; i++) {
                      const sibling = siblings[i];
                      if (sibling === element) {
                        const parentXPath = window.getElementXPath(element.parentNode);
                        return parentXPath + '/' + element.tagName + '[' + (ix + 1) + ']';
                      }
                      if (sibling.nodeType === 1 && sibling.tagName === element.tagName) {
                        ix++;
                      }
                    }
                    return null;
                  };

                  // Generate CSS selector path with proper escaping
                  window.getElementCSSPath = function (el) {
                    if (!(el instanceof Element)) return null;
                    const path = [];
                    while (el.nodeType === Node.ELEMENT_NODE) {
                      let selector = el.nodeName.toLowerCase();
                      if (el.id) {
                        // Properly escape special characters in CSS selectors
                        const escapedId = el.id.replace(/([\\:!"#$%&'()*+,.\/:;<=>?@\[\]^`{|}~])/g, '\\\\$1');
                        selector += '#' + escapedId;
                        path.unshift(selector);
                        break;
                      } else {
                        let sib = el, nth = 1;
                        while (sib = sib.previousElementSibling) {
                          if (sib.nodeName.toLowerCase() === selector) nth++;
                        }
                        if (nth !== 1) selector += ':nth-of-type(' + nth + ')';
                      }
                      path.unshift(selector);
                      el = el.parentNode;
                    }
                    return path.join(' > ');
                  };

                  // Enhanced element visibility checker
                  window.isElementTrulyVisible = function (el) {
                    if (!el || !el.offsetParent) return false;
                    const style = window.getComputedStyle(el);
                    const rect = el.getBoundingClientRect();
                    return (
                      style.display !== 'none' &&
                      style.visibility !== 'hidden' &&
                      parseFloat(style.opacity) > 0.1 &&
                      rect.width > 0 && rect.height > 0 &&
                      rect.top < window.innerHeight && rect.bottom > 0
                    );
                  };
                });
              } catch (utilError) {
                addLog(`Warning: Could not inject utility functions: ${utilError.message}`, 'warning');
              }

              // COMPREHENSIVE BUTTON DISCOVERY
              try {
                buttons = await page.evaluate(() => {
                  // ENHANCED BUTTON DISCOVERY - Comprehensive patterns
                  const allButtonElements = [
                    // Standard buttons
                    ...document.querySelectorAll('button:not([disabled])'),
                    // Role-based buttons
                    ...document.querySelectorAll('[role="button"]:not([disabled])'),
                    // Class-based buttons (expanded patterns)
                    ...document.querySelectorAll(`
                      .btn:not([disabled]), .button:not([disabled]), 
                      .cta:not([disabled]), .call-to-action:not([disabled]),
                      .submit:not([disabled]), .primary:not([disabled]),
                      .secondary:not([disabled]), .action:not([disabled]),
                      .link-button:not([disabled]), .btn-primary:not([disabled]),
                      .btn-secondary:not([disabled]), .btn-outline:not([disabled]),
                      .btn-ghost:not([disabled]), .btn-danger:not([disabled])
                    `),
                    // Interactive elements with click handlers
                    ...document.querySelectorAll('[onclick]:not([disabled])'),
                    // Input buttons and submits
                    ...document.querySelectorAll('input[type="button"]:not([disabled])'),
                    ...document.querySelectorAll('input[type="submit"]:not([disabled])'),
                    ...document.querySelectorAll('input[type="reset"]:not([disabled])'),
                    // Links that look like buttons
                    ...document.querySelectorAll(`
                      a.btn, a.button, a[role="button"], 
                      a.cta, a.call-to-action, a.primary, a.secondary
                    `),
                    // Elements with button-like data attributes
                    ...document.querySelectorAll('[data-action], [data-click], [data-submit], [data-toggle]'),
                    // Form elements that might be interactive
                    ...document.querySelectorAll('label[for]:not([disabled])'),
                    // Custom interactive elements (expanded)
                    ...document.querySelectorAll(`
                      [class*="click"], [class*="press"], [class*="tap"],
                      [id*="button"], [id*="btn"], [id*="submit"],
                      [class*="toggle"], [class*="trigger"], [class*="menu"]
                    `),
                    // Modern UI framework elements
                    ...document.querySelectorAll(`
                      [data-testid*="button"], [data-testid*="btn"],
                      [aria-expanded], [aria-haspopup], 
                      .chakra-button, .ant-btn, .mui-button, .v-btn,
                      .react-button, .vue-button
                    `),
                    // Interactive elements with tabindex (keyboard accessible)
                    ...document.querySelectorAll('[tabindex="0"]:not(input):not(textarea):not(select)'),
                    // Elements with ARIA roles that might be interactive
                    ...document.querySelectorAll(`
                      [role="menuitem"], [role="tab"], [role="option"],
                      [role="switch"], [role="checkbox"]:not(input)
                    `)
                  ];

                  return allButtonElements
                    .filter((el, index, array) => {
                      // Remove duplicates
                      return array.indexOf(el) === index;
                    })
                    .filter(el => {
                      // Enhanced visibility check using our utility function
                      return window.isElementTrulyVisible ? window.isElementTrulyVisible(el) : (
                        el.offsetParent !== null &&
                        window.getComputedStyle(el).display !== 'none' &&
                        window.getComputedStyle(el).visibility !== 'hidden'
                      );
                    })
                    .map((el, index) => {
                      // Extract comprehensive metadata
                      const rect = el.getBoundingClientRect();
                      const computedStyle = window.getComputedStyle(el);

                      // Multiple ways to get button text/description
                      const text = (
                        el.textContent?.trim() ||
                        el.value ||
                        el.title ||
                        el.getAttribute('aria-label') ||
                        el.getAttribute('data-label') ||
                        el.getAttribute('placeholder') ||
                        el.getAttribute('alt') ||
                        (el.className && typeof el.className === 'string' ?
                          el.className.split(' ').find(c => c.includes('btn') || c.includes('button')) : null) ||
                        `${el.tagName.toLowerCase()}-${index + 1}`
                      ).substring(0, 100); // Increased length for better identification

                      return {
                        // Basic identification
                        index,
                        text: text || `Element-${index + 1}`,
                        className: el.className || '',
                        id: el.id || '',
                        tagName: el.tagName,
                        type: el.type || el.getAttribute('role') || 'interactive',

                        // Interaction capabilities
                        hasOnClick: !!el.getAttribute('onclick'),
                        hasDataAction: !!(el.getAttribute('data-action') ||
                          el.getAttribute('data-click') ||
                          el.getAttribute('data-submit') ||
                          el.getAttribute('data-toggle')),
                        isFormElement: ['INPUT', 'BUTTON', 'LABEL', 'SELECT'].includes(el.tagName),

                        // Enhanced metadata for better selection
                        hasAriaExpanded: el.hasAttribute('aria-expanded'),
                        hasAriaHaspopup: el.hasAttribute('aria-haspopup'),
                        hasTabindex: el.hasAttribute('tabindex'),
                        tabindexValue: el.getAttribute('tabindex'),
                        ariaRole: el.getAttribute('role'),

                        // Position and visibility info
                        position: rect ? {
                          x: Math.round(rect.left || 0),
                          y: Math.round(rect.top || 0),
                          width: Math.round(rect.width || 0),
                          height: Math.round(rect.height || 0)
                        } : { x: 0, y: 0, width: 0, height: 0 },
                        isInViewport: rect ? (
                          rect.top >= 0 && rect.left >= 0 &&
                          rect.bottom <= window.innerHeight &&
                          rect.right <= window.innerWidth
                        ) : false,

                        // Selection strategies (multiple fallbacks)
                        xpath: window.getElementXPath ? window.getElementXPath(el) : null,
                        cssPath: window.getElementCSSPath ? window.getElementCSSPath(el) : null,

                        // Complexity and priority scoring
                        complexity: (el.children ? el.children.length : 0) + (el.className && typeof el.className === 'string' ?
                          el.className.split(' ').length : 0),
                        priority: (
                          (el.tagName === 'BUTTON' ? 10 : 0) +
                          (el.getAttribute('role') === 'button' ? 8 : 0) +
                          ((el.className && typeof el.className === 'string' && el.className.includes('btn')) ? 7 : 0) +
                          (el.hasAttribute('onclick') ? 6 : 0) +
                          (el.type === 'submit' ? 9 : 0) +
                          (el.hasAttribute('data-testid') ? 5 : 0)
                        ),

                        // Additional attributes for debugging
                        allAttributes: el.attributes ? Array.from(el.attributes).reduce((attrs, attr) => {
                          if (attr && attr.name && attr.value !== undefined) {
                            attrs[attr.name] = attr.value;
                          }
                          return attrs;
                        }, {}) : {}
                      };
                    })
                    .filter(btn => {
                      // Enhanced filtering with safety checks
                      return btn &&
                        btn.text &&
                        typeof btn.text === 'string' &&
                        btn.text.length > 0 &&
                        btn.text !== 'undefined' &&
                        btn.text.trim().length > 0;
                    })
                    .sort((a, b) => (b.priority || 0) - (a.priority || 0)); // Sort by priority with fallback
                });
              } catch (error) {
                addLog(`Error extracting buttons: ${error.message}`, 'error');
                buttons = [];
              }

              // ADAPTIVE TESTING STRATEGY based on page complexity
              let pageComplexityCount = 0;
              try {
                pageComplexityCount = await page.$eval('*', els => els.length);
              } catch (complexityError) {
                // Fallback if element counting fails
                pageComplexityCount = 500;
                addLog(`Warning: Could not count page elements, using fallback: ${complexityError.message}`, 'warning');
              }

              const pageComplexity = buttons.length + pageComplexityCount;
              const complexityLevel = pageComplexity > 2000 ? 'high' : pageComplexity > 100 ? 'medium' : 'low';

              // SCAN DEPTH AWARE TESTING LIMITS
              const scanDepthLimits = {
                fast: {
                  buttons: Math.min(maxButtonsPerPage, isRenderProduction ? 1 : 2),
                  timePerButton: Math.min(buttonTimeoutLimit, isRenderProduction ? 1000 : 1500),
                  maxWaitTime: 500
                },
                balanced: {
                  buttons: Math.min(maxButtonsPerPage, isRenderProduction ? 3 : 5),
                  timePerButton: Math.min(buttonTimeoutLimit, isRenderProduction ? 1500 : 2000),
                  maxWaitTime: 800
                },
                deep: {
                  buttons: Math.min(maxButtonsPerPage, isRenderProduction ? 5 : 10),
                  timePerButton: Math.min(buttonTimeoutLimit, isRenderProduction ? 2000 : 3000),
                  maxWaitTime: 1000
                }
              };

              const currentScanDepth = options.scanDepth || 'balanced';
              const baseLimits = scanDepthLimits[currentScanDepth] || scanDepthLimits.balanced;

              // Adjust based on page complexity
              const testLimits = {
                low: {
                  buttons: baseLimits.buttons,
                  timePerButton: baseLimits.timePerButton,
                  maxWaitTime: baseLimits.maxWaitTime
                },
                medium: {
                  buttons: Math.max(1, Math.floor(baseLimits.buttons * 0.7)),
                  timePerButton: Math.floor(baseLimits.timePerButton * 0.8),
                  maxWaitTime: Math.floor(baseLimits.maxWaitTime * 0.8)
                },
                high: {
                  buttons: Math.max(1, Math.floor(baseLimits.buttons * 0.5)),
                  timePerButton: Math.floor(baseLimits.timePerButton * 0.6),
                  maxWaitTime: Math.floor(baseLimits.maxWaitTime * 0.6)
                }
              };

              const limits = testLimits[complexityLevel];

              addLog(` Found ${buttons.length} buttons (complexity: ${complexityLevel}), will test top ${limits.buttons}`, 'info');

              let brokenButtonsOnPage = 0;
              let authIssuesOnPage = 0;

              // SOPHISTICATED BUTTON TESTING with Multi-Strategy Selection
              const buttonResults = {
                genuine_broken: [],
                scanner_limitation: [],
                auth_required: [],
                network_timeout: [],
                javascript_error: [],
                working: [],
                state_changes: []
              };

              // Test buttons with adaptive limits
              for (const buttonInfo of buttons.slice(0, limits.buttons)) {
                if (scanState.isCancelled) break;

                let buttonPage;
                let testResult = {
                  button: buttonInfo.text,
                  page: fullUrl,
                  classification: 'unknown',
                  errors: [],
                  selectionMethod: null,
                  responseTime: 0,
                  stateChanges: []
                };

                try {
                  buttonPage = await browser.newPage();
                  await buttonPage.setViewport({ width: 1280, height: 720 });

                  // Enhanced error tracking
                  const allErrors = [];
                  const consoleMessages = [];
                  const networkErrors = [];

                  buttonPage.on('console', (msg) => {
                    const text = msg.text();
                    consoleMessages.push({ type: msg.type(), text, timestamp: Date.now() });
                    if (msg.type() === 'error') allErrors.push(text);
                  });

                  buttonPage.on('pageerror', (error) => {
                    allErrors.push(`Page Error: ${error.message}`);
                  });

                  buttonPage.on('requestfailed', (request) => {
                    networkErrors.push(`Network: ${request.url()} - ${request.failure()?.errorText}`);
                  });

                  const startTime = Date.now();
                  await buttonPage.goto(fullUrl, {
                    timeout: limits.timePerButton,
                    waitUntil: 'domcontentloaded'
                  });

                  // Wait for dynamic content to load (REDUCED)
                  await new Promise(resolve => setTimeout(resolve, 800)); // Reduced from 1500

                  // MULTI-STRATEGY BUTTON SELECTION (Priority order)
                  let selectedButton = null;
                  let selectionMethod = null;

                  // Strategy 1: ID-based selection with proper escaping
                  if (!selectedButton && buttonInfo.id) {
                    try {
                      // Escape special characters in CSS selectors
                      const escapedId = buttonInfo.id.replace(/([\\:!"#$%&'()*+,.\/:;<=>?@\[\]^`{|}~])/g, '\\\\$1');
                      selectedButton = await buttonPage.$(`#${escapedId}`);
                      if (selectedButton) {
                        selectionMethod = 'escaped-id';
                        testResult.selectionMethod = `ID (escaped): #${escapedId}`;
                      }
                    } catch (idError) {
                      // ID selection failed, try next strategy
                    }
                  }

                  // Strategy 2: XPath selection
                  if (!selectedButton && buttonInfo.xpath) {
                    try {
                      const [xpathElement] = await buttonPage.$x(buttonInfo.xpath);
                      if (xpathElement) {
                        selectedButton = xpathElement;
                        selectionMethod = 'xpath';
                        testResult.selectionMethod = `XPath: ${buttonInfo.xpath.substring(0, 100)}`;
                      }
                    } catch (xpathError) {
                      // XPath selection failed, try next strategy
                    }
                  }

                  // Strategy 3: CSS Path selection
                  if (!selectedButton && buttonInfo.cssPath) {
                    try {
                      selectedButton = await buttonPage.$(buttonInfo.cssPath);
                      if (selectedButton) {
                        selectionMethod = 'css-path';
                        testResult.selectionMethod = `CSS Path: ${buttonInfo.cssPath.substring(0, 100)}`;
                      }
                    } catch (cssError) {
                      // CSS path selection failed, try next strategy
                    }
                  }

                  // Strategy 4: Text-based selection
                  if (!selectedButton && buttonInfo.text) {
                    try {
                      const textSelectors = [
                        `button:contains("${buttonInfo.text}")`,
                        `[role="button"]:contains("${buttonInfo.text}")`,
                        `input[value="${buttonInfo.text}"]`,
                        `*[aria-label="${buttonInfo.text}"]`
                      ];

                      for (const selector of textSelectors) {
                        try {
                          const elements = await buttonPage.evaluateHandle((sel, text) => {
                            const xpath = `//button[contains(text(), '${text}')] | //*[@role='button' and contains(text(), '${text}')] | //input[@value='${text}'] | //*[@aria-label='${text}']`;
                            const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                            return result.singleNodeValue;
                          }, selector, buttonInfo.text);

                          if (elements) {
                            selectedButton = elements;
                            selectionMethod = 'text-content';
                            testResult.selectionMethod = `Text-based: "${buttonInfo.text.substring(0, 50)}"`;
                            break;
                          }
                        } catch (e) {
                          // Continue to next selector
                        }
                      }
                    } catch (textError) {
                      // Text selection failed, try next strategy
                    }
                  }

                  // Strategy 5: Position-based selection (last resort)
                  if (!selectedButton && buttonInfo.position) {
                    try {
                      const positionSelector = `${buttonInfo.tagName.toLowerCase()}[style*="position"]`;
                      const candidates = await buttonPage.$(positionSelector);

                      for (const candidate of candidates) {
                        const rect = await candidate.boundingBox();
                        if (rect &&
                          Math.abs(rect.x - buttonInfo.position.x) < 10 &&
                          Math.abs(rect.y - buttonInfo.position.y) < 10) {
                          selectedButton = candidate;
                          selectionMethod = 'position';
                          testResult.selectionMethod = `Position: (${buttonInfo.position.x}, ${buttonInfo.position.y})`;
                          break;
                        }
                      }
                    } catch (positionError) {
                      // Position selection failed
                    }
                  }

                  if (!selectedButton) {
                    testResult.classification = 'scanner_limitation';
                    testResult.errors = ['Could not locate button element with any selection strategy'];
                    buttonResults.scanner_limitation.push(testResult);
                    continue;
                  }

                  // PRE-CLICK STATE CAPTURE
                  const preClickState = await buttonPage.evaluate(() => ({
                    url: window.location.href,
                    title: document.title,
                    activeElement: document.activeElement?.tagName,
                    modalCount: document.querySelectorAll('.modal, [role="dialog"]').length,
                    overlayCount: document.querySelectorAll('.overlay, .backdrop').length,
                    loadingCount: document.querySelectorAll('.loading, .spinner').length
                  }));

                  // ENHANCED BUTTON INTERACTION
                  const isVisible = await selectedButton.isIntersectingViewport();
                  if (!isVisible) {
                    await selectedButton.scrollIntoViewIfNeeded();
                    await new Promise(resolve => setTimeout(resolve, 500));
                  }

                  // Clear previous errors before clicking
                  allErrors.length = 0;
                  consoleMessages.length = 0;
                  networkErrors.length = 0;

                  // PERFORM CLICK with timeout
                  try {
                    await Promise.race([
                      selectedButton.click(),
                      new Promise((_, reject) =>
                        setTimeout(() => reject(new Error('Click timeout')), limits.timePerButton)
                      )
                    ]);
                  } catch (clickError) {
                    if (clickError.message === 'Click timeout') {
                      testResult.classification = 'network_timeout';
                      testResult.errors = ['Button click timed out'];
                      buttonResults.network_timeout.push(testResult);
                      continue;
                    }
                    throw clickError;
                  }

                  // OPTIMIZED STATE CHANGE DETECTION (Reduced from progressive waits)
                  const maxWaitTime = limits.maxWaitTime || 500;
                  let finalState = null;
                  let stateChangeDetected = false;

                  // Single quick check instead of progressive waits
                  await new Promise(resolve => setTimeout(resolve, 300)); // Quick initial wait

                  try {
                    const currentState = await buttonPage.evaluate(() => ({
                      url: window.location.href,
                      title: document.title,
                      modalCount: document.querySelectorAll('.modal, [role="dialog"]').length,
                      overlayCount: document.querySelectorAll('.overlay, .backdrop').length,
                      hasNewContent: document.querySelector('.toast, .notification, .alert, .success, .error') !== null
                    }));

                    // Quick state change detection
                    const stateChanges = [];
                    if (currentState.url !== preClickState.url) {
                      stateChanges.push(`URL changed: ${preClickState.url} -> ${currentState.url}`);
                      stateChangeDetected = true;
                    }
                    if (currentState.title !== preClickState.title) {
                      stateChanges.push(`Title changed: "${preClickState.title}" -> "${currentState.title}"`);
                      stateChangeDetected = true;
                    }
                    if (currentState.modalCount > preClickState.modalCount) {
                      stateChanges.push(`Modal opened (${currentState.modalCount - preClickState.modalCount})`);
                      stateChangeDetected = true;
                    }
                    if (currentState.overlayCount > preClickState.overlayCount) {
                      stateChanges.push(`Overlay appeared (${currentState.overlayCount - preClickState.overlayCount})`);
                      stateChangeDetected = true;
                    }
                    if (currentState.hasNewContent) {
                      stateChanges.push('New notification/alert content appeared');
                      stateChangeDetected = true;
                    }

                    testResult.stateChanges = stateChanges;
                    finalState = currentState;

                    // If no immediate changes and time allows, wait a bit more
                    if (!stateChangeDetected && maxWaitTime > 400) {
                      await new Promise(resolve => setTimeout(resolve, Math.min(maxWaitTime - 300, 400)));

                      // One final check
                      const finalCheck = await buttonPage.evaluate(() => ({
                        url: window.location.href,
                        title: document.title,
                        hasNewContent: document.querySelector('.toast, .notification, .alert, .success, .error') !== null
                      }));

                      if (finalCheck.url !== currentState.url || finalCheck.title !== currentState.title || finalCheck.hasNewContent) {
                        testResult.stateChanges.push('Delayed state change detected');
                        stateChangeDetected = true;
                      }
                    }

                  } catch (stateError) {
                    // State checking failed, continue with what we have
                    testResult.stateChanges = [];
                  }

                  testResult.responseTime = Date.now() - startTime;

                  // ERROR CLASSIFICATION
                  const authKeywords = ['401', '403', 'unauthorized', 'forbidden', 'login required', 'access denied'];
                  const networkKeywords = ['network', 'timeout', 'connection', 'fetch', 'cors', 'net::', 'dns'];
                  const jsKeywords = ['javascript', 'script error', 'undefined', 'null', 'reference error', 'type error'];

                  const allErrorText = [...allErrors, ...networkErrors].join(' ').toLowerCase();

                  if (allErrors.length === 0 && networkErrors.length === 0) {
                    if (testResult.stateChanges.length > 0) {
                      testResult.classification = 'working';
                      buttonResults.working.push(testResult);
                      buttonResults.state_changes.push({
                        ...testResult,
                        changes: testResult.stateChanges
                      });
                    } else {
                      // No errors, but no visible state changes either
                      testResult.classification = 'working';
                      testResult.notes = 'Button click succeeded but no visible state changes detected';
                      buttonResults.working.push(testResult);
                    }
                  } else if (authKeywords.some(keyword => allErrorText.includes(keyword))) {
                    testResult.classification = 'auth_required';
                    testResult.errors = allErrors.filter(error =>
                      authKeywords.some(keyword => error.toLowerCase().includes(keyword))
                    );
                    buttonResults.auth_required.push(testResult);
                  } else if (networkKeywords.some(keyword => allErrorText.includes(keyword))) {
                    testResult.classification = 'network_timeout';
                    testResult.errors = [...allErrors, ...networkErrors].filter(error =>
                      networkKeywords.some(keyword => error.toLowerCase().includes(keyword))
                    );
                    buttonResults.network_timeout.push(testResult);
                  } else if (jsKeywords.some(keyword => allErrorText.includes(keyword))) {
                    testResult.classification = 'javascript_error';
                    testResult.errors = allErrors.filter(error =>
                      jsKeywords.some(keyword => error.toLowerCase().includes(keyword))
                    );
                    buttonResults.javascript_error.push(testResult);
                  } else {
                    // Unclassified errors - likely genuine issues
                    testResult.classification = 'genuine_broken';
                    testResult.errors = [...allErrors, ...networkErrors];
                    buttonResults.genuine_broken.push(testResult);
                  }

                } catch (error) {
                  testResult.classification = 'scanner_limitation';
                  testResult.errors = [error.message];
                  buttonResults.scanner_limitation.push(testResult);
                } finally {
                  if (buttonPage) {
                    try {
                      await buttonPage.close();
                    } catch (e) {
                      // Ignore close errors
                    }
                  }
                }
                // AGGREGATE RESULTS with Enhanced Classification
                const buttonSummary = {
                  total: buttons.length,
                  tested: Math.min(buttons.length, limits.buttons),
                  working: buttonResults.working.length,
                  genuine_broken: buttonResults.genuine_broken.length,
                  scanner_limitation: buttonResults.scanner_limitation.length,
                  auth_required: buttonResults.auth_required.length,
                  network_timeout: buttonResults.network_timeout.length,
                  javascript_error: buttonResults.javascript_error.length,
                  with_state_changes: buttonResults.state_changes.length
                };

                // Update legacy format for backward compatibility
                buttonResults.working.forEach(result => {
                  allIssues.workingButtons.push({
                    page: result.page,
                    button: result.button,
                    classification: result.classification,
                    selectionMethod: result.selectionMethod,
                    responseTime: result.responseTime,
                    stateChanges: result.stateChanges
                  });
                });

                // Add genuinely broken buttons to legacy format
                buttonResults.genuine_broken.forEach(result => {
                  allIssues.brokenButtons.push({
                    page: result.page,
                    button: result.button,
                    errors: result.errors,
                    classification: result.classification,
                    selectionMethod: result.selectionMethod
                  });
                });

                // Add auth issues to legacy format
                buttonResults.auth_required.forEach(result => {
                  allIssues.authErrors.push({
                    page: result.page,
                    button: result.button,
                    errors: result.errors,
                    classification: result.classification
                  });
                });

                // Store enhanced results
                if (!allIssues.enhancedButtonResults) {
                  allIssues.enhancedButtonResults = [];
                }
                allIssues.enhancedButtonResults.push({
                  page: fullUrl,
                  complexity: complexityLevel,
                  summary: buttonSummary,
                  results: buttonResults
                });

                // ENHANCED LOGGING
                if (buttonSummary.tested > 0) {
                  const accuracyRate = Math.round((buttonSummary.working / buttonSummary.tested) * 100);
                  addLog(` Button Analysis Complete: ${buttonSummary.tested} tested, ${buttonSummary.working} working (${accuracyRate}% success)`, 'info');

                  if (buttonSummary.genuine_broken > 0) {
                    addLog(` 🔴 ${buttonSummary.genuine_broken} genuinely broken buttons found`, 'error');
                  }
                  if (buttonSummary.auth_required > 0) {
                    addLog(` 🟡 ${buttonSummary.auth_required} buttons require authentication`, 'warning');
                  }
                  if (buttonSummary.scanner_limitation > 0) {
                    addLog(` 🟠 ${buttonSummary.scanner_limitation} buttons had selector issues (not site problems)`, 'warning');
                  }
                  if (buttonSummary.javascript_error > 0) {
                    addLog(` 🟣 ${buttonSummary.javascript_error} buttons triggered JavaScript errors`, 'warning');
                  }
                  if (buttonSummary.network_timeout > 0) {
                    addLog(` ⏱️ ${buttonSummary.network_timeout} buttons experienced network timeouts`, 'warning');
                  }
                  if (buttonSummary.with_state_changes > 0) {
                    addLog(` ✨ ${buttonSummary.with_state_changes} buttons caused visible state changes`, 'success');
                  }

                  // Update buttons section progress
                  updateSectionProgress('buttons',
                    allIssues.brokenButtons.length + allIssues.workingButtons.length,
                    maxButtonsPerPage * Math.min(pageLimit, 10),
                    'running'
                  );

                  // Complete buttons section when all pages are done
                  if (processedPages >= pageLimit || pagesToCrawl.length === 0) {
                    const totalButtonsChecked = allIssues.brokenButtons.length + allIssues.workingButtons.length;
                    completeSectionWithLog('buttons', totalButtonsChecked, allIssues.brokenButtons.length);
                  }
                } else {
                  addLog(` No buttons were tested due to complexity or limits`, 'info');
                }

              }

              if (options.includeSEO !== false && processedPages <= 100) {
                if (scanState.isCancelled) return;

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

                  // Update SEO section progress
                  updateSectionProgress('seo',
                    allIssues.seoData ? allIssues.seoData.length : 0,
                    Math.min(pageLimit, 20),
                    'running'
                  );

                  // Complete SEO section when all pages are done
                  if (processedPages >= pageLimit || pagesToCrawl.length === 0) {
                    const totalSEOPages = allIssues.seoData ? allIssues.seoData.length : 0;
                    const totalSEOIssues = allIssues.seoIssues ? allIssues.seoIssues.length : 0;
                    completeSectionWithLog('seo', totalSEOPages, totalSEOIssues);
                  }

                } catch (error) {
                  addLog(` Error checking SEO: ${error.message}`, 'error');
                }
              }

              if (options.includePerformance !== false && processedPages <= 100) { // Test performance on first 10 pages
                if (scanState.isCancelled) return;

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

                  // Update performance section progress
                  updateSectionProgress('performance',
                    allIssues.performanceData ? allIssues.performanceData.length : 0,
                    Math.min(pageLimit, 20),
                    'running'
                  );

                  // Complete performance section when all pages are done
                  if (processedPages >= pageLimit || pagesToCrawl.length === 0) {
                    const totalPerfPages = allIssues.performanceData ? allIssues.performanceData.length : 0;
                    const slowPages = allIssues.performanceData ? allIssues.performanceData.filter(p =>
                      p.firstContentfulPaint > 300 || p.totalElements > 1500 || p.pageSize > 200
                    ).length : 0;
                    completeSectionWithLog('performance', totalPerfPages, slowPages);
                  }

                } catch (error) {
                  addLog(` Error collecting performance data: ${error.message}`, 'error');
                }
              } else {
                addLog(` Button testing disabled`, 'info');
              }

              if (options.includeForms !== false) {
                if (scanState.isCancelled) return;

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

                    // Update forms section progress
                    const totalFormsFound = allIssues.workingLinks ? allIssues.workingLinks.filter(l => l.type === 'form').length : 0;
                    updateSectionProgress('forms', totalFormsFound, 10, 'running');

                    for (const form of forms.slice(0, 3)) { // Test up to 3 forms per page
                      if (scanState.isCancelled) break;

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

                    // Complete forms section when all pages are done
                    if (processedPages >= pageLimit || pagesToCrawl.length === 0) {
                      const totalFormsChecked = allIssues.workingLinks ? allIssues.workingLinks.filter(l => l.type === 'form').length : 0;
                      const brokenFormActions = allIssues.brokenLinks ? allIssues.brokenLinks.filter(l => l.type === 'form').length : 0;
                      completeSectionWithLog('forms', totalFormsChecked, brokenFormActions);
                    }
                  } else {
                    // Complete forms section immediately if no forms found
                    if (processedPages >= pageLimit || pagesToCrawl.length === 0) {
                      completeSectionWithLog('forms', 0, 0);
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
            } // End shouldSkipButtonTesting
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

        // Complete resources section when all pages are done (placeholder for future implementation)
        if (processedPages >= pageLimit || pagesToCrawl.length === 0) {
          const totalResourcesChecked = allIssues.missingResources ? allIssues.missingResources.length : 0;
          const missingResourcesCount = allIssues.missingResources ? allIssues.missingResources.length : 0;
          completeSectionWithLog('resources', totalResourcesChecked, missingResourcesCount);
        }
      }
      // SCAN DEPTH SPECIFIC LIMITS
      const pageLimit = options.maxPages;
      const linkLimit = options.maxLinks;
      const maxButtonsPerPage = options.maxButtons || 5;
      const buttonTimeoutLimit = options.buttonTimeout || 2000;
      const pageTimeoutLimit = options.timeoutPerPage || 800;

      addLog(` ${options.scanName || 'Scan'} configuration: maxPages=${pageLimit}, maxLinks=${linkLimit}, maxButtons=${maxButtonsPerPage}, depth=${options.scanDepth}`, 'info');

      // DISCOVERY FUNCTION
      async function discoverAdditionalPages(baseUrl, pagesToCrawl, visitedPages, addLog) {
        if (scanState.isCancelled) return;

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
            if (scanState.isCancelled) break;
            if (!visitedPages.has(path) && !pagesToCrawl.includes(path)) {
              try {
                const testUrl = new URL(path, baseUrl).href;
                const response = await fetch(testUrl, {
                  method: 'HEAD',
                  timeout: 300,
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
            if (scanState.isCancelled) break;
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
        addLog(` Starting page discovery...`, 'info');
        let totalFound = 0;

        for (const method of discoveryMethods) {
          if (scanState.isCancelled) break;
          try {
            const found = await method();
            totalFound += found;
          } catch (error) {
            addLog(`Discovery method failed: ${error.message}`, 'warning');
          }
        }

        addLog(` Page discovery complete! Found ${totalFound} additional pages to scan`, totalFound > 0 ? 'success' : 'info');
      }

      // Crawl pages - SCANNING
      let consecutiveErrors = 0;
      const maxConsecutiveErrors = 5;

      while (pagesToCrawl.length > 0 && visitedPages.size < pageLimit && consecutiveErrors < maxConsecutiveErrors) {
        if (scanState.isCancelled) break;

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

        // Add memory and time checks with AGGRESSIVE limits for speed
        const memUsage = process.memoryUsage().heapUsed / 1024 / 1024;
        const scanDuration = Date.now() - new Date(scan.startTime).getTime();

        if (memUsage > 800) {
          addLog(` Memory usage high (${Math.round(memUsage)}MB), continuing with caution`, 'warning');
        }

        // AGGRESSIVE TIME LIMIT - Stop after 10 minutes max
        if (scanDuration > 10 * 60 * 1000) {
          addLog(` 🚨 Scan time limit reached (10 minutes), stopping for performance`, 'warning');
          break;
        }

        // Add a smaller delay between pages
        await delay(200); // Reduced from 500

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
        pagesWithErrors: allIssues.pageErrors.length,
        // New metrics
        seoIssuesCount: allIssues.seoIssues?.length || 0,
        performanceIssuesCount: allIssues.performanceData?.filter(p =>
          p.firstContentfulPaint > 300 || p.totalElements > 1500 || p.pageSize > 2000
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

      // Increment user's scan count in database
      try {
        await pool.query(
          `UPDATE users SET scans_used_this_month = scans_used_this_month + 1, last_scan_date = CURRENT_DATE WHERE wallet_address = $1`,
          [scan.user]
        );
        addLog(` Scan count incremented for user ${scan.user}`, 'info');
      } catch (dbError) {
        console.error('Error incrementing scan count:', dbError);
        addLog(` Warning: Could not increment scan count`, 'warning');
      }

      addLog(` Scan completed! Scanned ${summary.totalPages} pages, found ${summary.brokenLinksCount} broken links`, 'success');

      const finalMemory = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
      addLog(` Final memory usage: ${finalMemory}MB`, 'info');

    } catch (error) {
      if (!scanState.isCancelled) {
        console.error(` Scan ${scanId} failed:`, error);
        addLog(` Scan failed: ${error.message}`, 'error');
        scan.status = 'error';
        scan.error = error.message;
        scan.progress = 0;
      }
    } finally {
      // Clear memory monitoring interval
      if (scanState.memoryCheckInterval) {
        clearInterval(scanState.memoryCheckInterval);
      }

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

  // ENHANCED SECTION TRACKING HELPERS
  const updateSectionProgress = (section, tested, total, status = 'running') => {
    if (scan && scan.sectionProgress && scan.sectionProgress[section]) {
      scan.sectionProgress[section].tested = tested;
      scan.sectionProgress[section].total = total;
      scan.sectionProgress[section].progress = total > 0 ? Math.round((tested / total) * 100) : 0;
      scan.sectionProgress[section].status = status;
      scan.sectionProgress[section].completed = status === 'completed';
    }
  };

  const completeSectionWithLog = (section, tested, issues, type = 'success') => {
    const timestamp = new Date().toLocaleTimeString('en-GB', { hour12: false });
    let message = '';

    switch (section) {
      case 'links':
        message = `Links scan completed - ${tested} links tested, ${issues} broken`;
        break;
      case 'buttons':
        message = `Buttons scan completed - ${tested} buttons tested, ${issues} issues found`;
        break;
      case 'seo':
        message = `SEO scan completed - ${tested} pages analyzed, ${issues} issues found`;
        break;
      case 'performance':
        message = `Performance scan completed - ${tested} pages analyzed, ${issues} slow pages`;
        break;
      case 'forms':
        message = `Forms scan completed - ${tested} forms found, ${issues} issues`;
        break;
      case 'resources':
        message = `Resources scan completed - ${tested} resources checked, ${issues} missing`;
        break;
    }

    updateSectionProgress(section, tested, tested, 'completed');
    addLog(`✅ [${timestamp}] ${message}`, type);

    // Log to console with timestamp
    console.log(`[${scanId}] ✅ [${timestamp}] ${message}`);
  };

  const startSectionWithLog = (section, estimated) => {
    const timestamp = new Date().toLocaleTimeString('en-GB', { hour12: false });
    const sectionName = section.charAt(0).toUpperCase() + section.slice(1);

    updateSectionProgress(section, 0, estimated, 'running');
    addLog(`🔄 [${timestamp}] Starting ${sectionName} analysis...`, 'info');

    console.log(`[${scanId}] 🔄 [${timestamp}] Starting ${sectionName} analysis...`);
  };

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
      // New categories
      performanceData: [],
      seoData: [],
      seoIssues: [],
      formIssues: [],
      resourceIssues: []
    };

    const pagesToCrawl = ['/'];
    let processedPages = 0;

    // Update progress with better calculation for scans
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
            if (req.resourceType() == 'stylesheet' || req.resourceType() == 'image' || req.resourceType() == 'font') {
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

        // Initialize section tracking for this page
        if (processedPages === 1) {
          // Start sections on first page - estimate totals
          startSectionWithLog('links', linkLimit * Math.min(pageLimit, 10));
          if (options.includeButtons) startSectionWithLog('buttons', maxButtonsPerPage * Math.min(pageLimit, 10));
          if (options.includeSEO) startSectionWithLog('seo', Math.min(pageLimit, 20));
          if (options.includePerformance) startSectionWithLog('performance', Math.min(pageLimit, 20));
          if (options.includeForms) startSectionWithLog('forms', 10); // Estimated
          if (options.includeResources) startSectionWithLog('resources', 50); // Estimated
        }
        // Try to find sitemap.xml for page discovery
        if (processedPages === 1) { // Only try on first page
          await discoverAdditionalPages(baseUrl, pagesToCrawl, visitedPages, addLog);
        }

        // ENHANCED link discovery
        let links = [];
        try {
          links = await page.evaluate((baseUrl, limit) => {
            const processedLinks = [];
            const baseUrlObj = new URL(baseUrl);

            // 1. Standard navigation links
            const navLinks = Array.from(document.querySelectorAll('a[href]'));

            // 2. Links in navigation menus (more selectors)
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
        let linksTestedTotal = 0;

        // Update section progress for links
        updateSectionProgress('links',
          (allIssues.brokenLinks.length + allIssues.workingLinks.length),
          linkLimit * Math.min(pageLimit, 10),
          'running'
        );

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

              // Add working internal links to crawl queue for scanning
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

        // Complete links section when all pages are done
        if (processedPages >= pageLimit || pagesToCrawl.length === 0) {
          const totalLinksChecked = allIssues.brokenLinks.length + allIssues.workingLinks.length;
          completeSectionWithLog('links', totalLinksChecked, allIssues.brokenLinks.length);
        }

        // ENHANCED BUTTON TESTING - Deep Analysis System
        if (options.includeButtons !== false) {
          // PERFORMANCE OPTIMIZATION: Skip button testing on certain page types
          const shouldSkipButtonTesting = (
            fullUrl.includes('/api/') ||
            fullUrl.includes('.json') ||
            fullUrl.includes('/sitemap') ||
            fullUrl.includes('/robots.txt') ||
            fullUrl.includes('/_next/') ||
            fullUrl.includes('/assets/') ||
            fullUrl.endsWith('.xml') ||
            fullUrl.endsWith('.txt') ||
            processedPages > 20 // Skip button testing after 20 pages
          );

          if (shouldSkipButtonTesting) {
            addLog(` Skipping button testing for performance (API/resource page or limit reached)`, 'info');
          } else {
            let buttons = [];

            // INJECT UTILITY FUNCTIONS for better element selection
            try {
              await page.evaluateOnNewDocument(() => {
                // Generate XPath for element
                window.getElementXPath = function (element) {
                  if (!element || !element.tagName) return null;
                  if (element.id !== '') {
                    return `id("${element.id}")`;
                  }
                  if (element === document.body) {
                    return element.tagName;
                  }
                  let ix = 0;
                  const siblings = element.parentNode ? element.parentNode.childNodes : [];
                  for (let i = 0; i < siblings.length; i++) {
                    const sibling = siblings[i];
                    if (sibling === element) {
                      const parentXPath = window.getElementXPath(element.parentNode);
                      return parentXPath + '/' + element.tagName + '[' + (ix + 1) + ']';
                    }
                    if (sibling.nodeType === 1 && sibling.tagName === element.tagName) {
                      ix++;
                    }
                  }
                  return null;
                };

                // Generate CSS selector path with proper escaping
                window.getElementCSSPath = function (el) {
                  if (!(el instanceof Element)) return null;
                  const path = [];
                  while (el.nodeType === Node.ELEMENT_NODE) {
                    let selector = el.nodeName.toLowerCase();
                    if (el.id) {
                      // Properly escape special characters in CSS selectors
                      const escapedId = el.id.replace(/([\\:!"#$%&'()*+,.\/:;<=>?@\[\]^`{|}~])/g, '\\\\$1');
                      selector += '#' + escapedId;
                      path.unshift(selector);
                      break;
                    } else {
                      let sib = el, nth = 1;
                      while (sib = sib.previousElementSibling) {
                        if (sib.nodeName.toLowerCase() === selector) nth++;
                      }
                      if (nth !== 1) selector += ':nth-of-type(' + nth + ')';
                    }
                    path.unshift(selector);
                    el = el.parentNode;
                  }
                  return path.join(' > ');
                };

                // Enhanced element visibility checker
                window.isElementTrulyVisible = function (el) {
                  if (!el || !el.offsetParent) return false;
                  const style = window.getComputedStyle(el);
                  const rect = el.getBoundingClientRect();
                  return (
                    style.display !== 'none' &&
                    style.visibility !== 'hidden' &&
                    parseFloat(style.opacity) > 0.1 &&
                    rect.width > 0 && rect.height > 0 &&
                    rect.top < window.innerHeight && rect.bottom > 0
                  );
                };
              });
            } catch (utilError) {
              addLog(`Warning: Could not inject utility functions: ${utilError.message}`, 'warning');
            }

            // COMPREHENSIVE BUTTON DISCOVERY
            try {
              buttons = await page.evaluate(() => {
                // ENHANCED BUTTON DISCOVERY - Comprehensive patterns
                const allButtonElements = [
                  // Standard buttons
                  ...document.querySelectorAll('button:not([disabled])'),
                  // Role-based buttons
                  ...document.querySelectorAll('[role="button"]:not([disabled])'),
                  // Class-based buttons (expanded patterns)
                  ...document.querySelectorAll(`
                      .btn:not([disabled]), .button:not([disabled]), 
                      .cta:not([disabled]), .call-to-action:not([disabled]),
                      .submit:not([disabled]), .primary:not([disabled]),
                      .secondary:not([disabled]), .action:not([disabled]),
                      .link-button:not([disabled]), .btn-primary:not([disabled]),
                      .btn-secondary:not([disabled]), .btn-outline:not([disabled]),
                      .btn-ghost:not([disabled]), .btn-danger:not([disabled])
                    `),
                  // Interactive elements with click handlers
                  ...document.querySelectorAll('[onclick]:not([disabled])'),
                  // Input buttons and submits
                  ...document.querySelectorAll('input[type="button"]:not([disabled])'),
                  ...document.querySelectorAll('input[type="submit"]:not([disabled])'),
                  ...document.querySelectorAll('input[type="reset"]:not([disabled])'),
                  // Links that look like buttons
                  ...document.querySelectorAll(`
                      a.btn, a.button, a[role="button"], 
                      a.cta, a.call-to-action, a.primary, a.secondary
                    `),
                  // Elements with button-like data attributes
                  ...document.querySelectorAll('[data-action], [data-click], [data-submit], [data-toggle]'),
                  // Form elements that might be interactive
                  ...document.querySelectorAll('label[for]:not([disabled])'),
                  // Custom interactive elements (expanded)
                  ...document.querySelectorAll(`
                      [class*="click"], [class*="press"], [class*="tap"],
                      [id*="button"], [id*="btn"], [id*="submit"],
                      [class*="toggle"], [class*="trigger"], [class*="menu"]
                    `),
                  // Modern UI framework elements
                  ...document.querySelectorAll(`
                      [data-testid*="button"], [data-testid*="btn"],
                      [aria-expanded], [aria-haspopup], 
                      .chakra-button, .ant-btn, .mui-button, .v-btn,
                      .react-button, .vue-button
                    `),
                  // Interactive elements with tabindex (keyboard accessible)
                  ...document.querySelectorAll('[tabindex="0"]:not(input):not(textarea):not(select)'),
                  // Elements with ARIA roles that might be interactive
                  ...document.querySelectorAll(`
                      [role="menuitem"], [role="tab"], [role="option"],
                      [role="switch"], [role="checkbox"]:not(input)
                    `)
                ];

                return allButtonElements
                  .filter((el, index, array) => {
                    // Remove duplicates
                    return array.indexOf(el) === index;
                  })
                  .filter(el => {
                    // Enhanced visibility check using our utility function
                    return window.isElementTrulyVisible ? window.isElementTrulyVisible(el) : (
                      el.offsetParent !== null &&
                      window.getComputedStyle(el).display !== 'none' &&
                      window.getComputedStyle(el).visibility !== 'hidden'
                    );
                  })
                  .map((el, index) => {
                    // Extract comprehensive metadata
                    const rect = el.getBoundingClientRect();
                    const computedStyle = window.getComputedStyle(el);

                    // Multiple ways to get button text/description
                    const text = (
                      el.textContent?.trim() ||
                      el.value ||
                      el.title ||
                      el.getAttribute('aria-label') ||
                      el.getAttribute('data-label') ||
                      el.getAttribute('placeholder') ||
                      el.getAttribute('alt') ||
                      (el.className && typeof el.className === 'string' ?
                        el.className.split(' ').find(c => c.includes('btn') || c.includes('button')) : null) ||
                      `${el.tagName.toLowerCase()}-${index + 1}`
                    ).substring(0, 100); // Increased length for better identification

                    return {
                      // Basic identification
                      index,
                      text: text || `Element-${index + 1}`,
                      className: el.className || '',
                      id: el.id || '',
                      tagName: el.tagName,
                      type: el.type || el.getAttribute('role') || 'interactive',

                      // Interaction capabilities
                      hasOnClick: !!el.getAttribute('onclick'),
                      hasDataAction: !!(el.getAttribute('data-action') ||
                        el.getAttribute('data-click') ||
                        el.getAttribute('data-submit') ||
                        el.getAttribute('data-toggle')),
                      isFormElement: ['INPUT', 'BUTTON', 'LABEL', 'SELECT'].includes(el.tagName),

                      // Enhanced metadata for better selection
                      hasAriaExpanded: el.hasAttribute('aria-expanded'),
                      hasAriaHaspopup: el.hasAttribute('aria-haspopup'),
                      hasTabindex: el.hasAttribute('tabindex'),
                      tabindexValue: el.getAttribute('tabindex'),
                      ariaRole: el.getAttribute('role'),

                      // Position and visibility info
                      position: rect ? {
                        x: Math.round(rect.left || 0),
                        y: Math.round(rect.top || 0),
                        width: Math.round(rect.width || 0),
                        height: Math.round(rect.height || 0)
                      } : { x: 0, y: 0, width: 0, height: 0 },
                      isInViewport: rect ? (
                        rect.top >= 0 && rect.left >= 0 &&
                        rect.bottom <= window.innerHeight &&
                        rect.right <= window.innerWidth
                      ) : false,

                      // Selection strategies (multiple fallbacks)
                      xpath: window.getElementXPath ? window.getElementXPath(el) : null,
                      cssPath: window.getElementCSSPath ? window.getElementCSSPath(el) : null,

                      // Complexity and priority scoring
                      complexity: (el.children ? el.children.length : 0) + (el.className && typeof el.className === 'string' ?
                        el.className.split(' ').length : 0),
                      priority: (
                        (el.tagName === 'BUTTON' ? 10 : 0) +
                        (el.getAttribute('role') === 'button' ? 8 : 0) +
                        ((el.className && typeof el.className === 'string' && el.className.includes('btn')) ? 7 : 0) +
                        (el.hasAttribute('onclick') ? 6 : 0) +
                        (el.type === 'submit' ? 9 : 0) +
                        (el.hasAttribute('data-testid') ? 5 : 0)
                      ),

                      // Additional attributes for debugging
                      allAttributes: el.attributes ? Array.from(el.attributes).reduce((attrs, attr) => {
                        if (attr && attr.name && attr.value !== undefined) {
                          attrs[attr.name] = attr.value;
                        }
                        return attrs;
                      }, {}) : {}
                    };
                  })
                  .filter(btn => {
                    // Enhanced filtering with safety checks
                    return btn &&
                      btn.text &&
                      typeof btn.text === 'string' &&
                      btn.text.length > 0 &&
                      btn.text !== 'undefined' &&
                      btn.text.trim().length > 0;
                  })
                  .sort((a, b) => (b.priority || 0) - (a.priority || 0)); // Sort by priority with fallback
              });
            } catch (error) {
              addLog(`Error extracting buttons: ${error.message}`, 'error');
              buttons = [];
            }

            // ADAPTIVE TESTING STRATEGY based on page complexity
            let pageComplexityCount = 0;
            try {
              pageComplexityCount = await page.$eval('*', els => els.length);
            } catch (complexityError) {
              // Fallback if element counting fails
              pageComplexityCount = 500;
              addLog(`Warning: Could not count page elements, using fallback: ${complexityError.message}`, 'warning');
            }

            const pageComplexity = buttons.length + pageComplexityCount;
            const complexityLevel = pageComplexity > 2000 ? 'high' : pageComplexity > 1000 ? 'medium' : 'low';

            // SCAN DEPTH AWARE TESTING LIMITS
            const scanDepthLimits = {
              fast: {
                buttons: Math.min(maxButtonsPerPage, isRenderProduction ? 1 : 2),
                timePerButton: Math.min(buttonTimeoutLimit, isRenderProduction ? 1000 : 1500),
                maxWaitTime: 500
              },
              balanced: {
                buttons: Math.min(maxButtonsPerPage, isRenderProduction ? 3 : 5),
                timePerButton: Math.min(buttonTimeoutLimit, isRenderProduction ? 1500 : 2000),
                maxWaitTime: 800
              },
              deep: {
                buttons: Math.min(maxButtonsPerPage, isRenderProduction ? 5 : 10),
                timePerButton: Math.min(buttonTimeoutLimit, isRenderProduction ? 2000 : 3000),
                maxWaitTime: 1000
              }
            };

            const currentScanDepth = options.scanDepth || 'balanced';
            const baseLimits = scanDepthLimits[currentScanDepth] || scanDepthLimits.balanced;

            // Adjust based on page complexity
            const testLimits = {
              low: {
                buttons: baseLimits.buttons,
                timePerButton: baseLimits.timePerButton,
                maxWaitTime: baseLimits.maxWaitTime
              },
              medium: {
                buttons: Math.max(1, Math.floor(baseLimits.buttons * 0.7)),
                timePerButton: Math.floor(baseLimits.timePerButton * 0.8),
                maxWaitTime: Math.floor(baseLimits.maxWaitTime * 0.8)
              },
              high: {
                buttons: Math.max(1, Math.floor(baseLimits.buttons * 0.5)),
                timePerButton: Math.floor(baseLimits.timePerButton * 0.6),
                maxWaitTime: Math.floor(baseLimits.maxWaitTime * 0.6)
              }
            };

            const limits = testLimits[complexityLevel];

            addLog(` Found ${buttons.length} buttons (complexity: ${complexityLevel}), will test top ${limits.buttons}`, 'info');

            let brokenButtonsOnPage = 0;
            let authIssuesOnPage = 0;

            // SOPHISTICATED BUTTON TESTING with Multi-Strategy Selection
            const buttonResults = {
              genuine_broken: [],
              scanner_limitation: [],
              auth_required: [],
              network_timeout: [],
              javascript_error: [],
              working: [],
              state_changes: []
            };

            // Test buttons with adaptive limits
            for (const buttonInfo of buttons.slice(0, limits.buttons)) {
              let buttonPage;
              let testResult = {
                button: buttonInfo.text,
                page: fullUrl,
                classification: 'unknown',
                errors: [],
                selectionMethod: null,
                responseTime: 0,
                stateChanges: []
              };

              try {
                buttonPage = await browser.newPage();
                await buttonPage.setViewport({ width: 1280, height: 720 });

                // Enhanced error tracking
                const allErrors = [];
                const consoleMessages = [];
                const networkErrors = [];

                buttonPage.on('console', (msg) => {
                  const text = msg.text();
                  consoleMessages.push({ type: msg.type(), text, timestamp: Date.now() });
                  if (msg.type() === 'error') allErrors.push(text);
                });

                buttonPage.on('pageerror', (error) => {
                  allErrors.push(`Page Error: ${error.message}`);
                });

                buttonPage.on('requestfailed', (request) => {
                  networkErrors.push(`Network: ${request.url()} - ${request.failure()?.errorText}`);
                });

                const startTime = Date.now();
                await buttonPage.goto(fullUrl, {
                  timeout: limits.timePerButton,
                  waitUntil: 'domcontentloaded'
                });

                // Wait for dynamic content to load (REDUCED)
                await new Promise(resolve => setTimeout(resolve, 800)); // Reduced from 1500

                // MULTI-STRATEGY BUTTON SELECTION (Priority order)
                let selectedButton = null;
                let selectionMethod = null;

                // Strategy 1: ID-based selection with proper escaping
                if (!selectedButton && buttonInfo.id) {
                  try {
                    // Escape special characters in CSS selectors
                    const escapedId = buttonInfo.id.replace(/([\\:!"#$%&'()*+,.\/:;<=>?@\[\]^`{|}~])/g, '\\\\$1');
                    selectedButton = await buttonPage.$(`#${escapedId}`);
                    if (selectedButton) {
                      selectionMethod = 'escaped-id';
                      testResult.selectionMethod = `ID (escaped): #${escapedId}`;
                    }
                  } catch (idError) {
                    // ID selection failed, try next strategy
                  }
                }

                // Strategy 2: XPath selection
                if (!selectedButton && buttonInfo.xpath) {
                  try {
                    const [xpathElement] = await buttonPage.$x(buttonInfo.xpath);
                    if (xpathElement) {
                      selectedButton = xpathElement;
                      selectionMethod = 'xpath';
                      testResult.selectionMethod = `XPath: ${buttonInfo.xpath.substring(0, 100)}`;
                    }
                  } catch (xpathError) {
                    // XPath selection failed, try next strategy
                  }
                }

                // Strategy 3: CSS Path selection
                if (!selectedButton && buttonInfo.cssPath) {
                  try {
                    selectedButton = await buttonPage.$(buttonInfo.cssPath);
                    if (selectedButton) {
                      selectionMethod = 'css-path';
                      testResult.selectionMethod = `CSS Path: ${buttonInfo.cssPath.substring(0, 100)}`;
                    }
                  } catch (cssError) {
                    // CSS path selection failed, try next strategy
                  }
                }

                // Strategy 4: Text-based selection
                if (!selectedButton && buttonInfo.text) {
                  try {
                    const textSelectors = [
                      `button:contains("${buttonInfo.text}")`,
                      `[role="button"]:contains("${buttonInfo.text}")`,
                      `input[value="${buttonInfo.text}"]`,
                      `*[aria-label="${buttonInfo.text}"]`
                    ];

                    for (const selector of textSelectors) {
                      try {
                        const elements = await buttonPage.evaluateHandle((sel, text) => {
                          const xpath = `//button[contains(text(), '${text}')] | //*[@role='button' and contains(text(), '${text}')] | //input[@value='${text}'] | //*[@aria-label='${text}']`;
                          const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                          return result.singleNodeValue;
                        }, selector, buttonInfo.text);

                        if (elements) {
                          selectedButton = elements;
                          selectionMethod = 'text-content';
                          testResult.selectionMethod = `Text-based: "${buttonInfo.text.substring(0, 50)}"`;
                          break;
                        }
                      } catch (e) {
                        // Continue to next selector
                      }
                    }
                  } catch (textError) {
                    // Text selection failed, try next strategy
                  }
                }

                // Strategy 5: Position-based selection (last resort)
                if (!selectedButton && buttonInfo.position) {
                  try {
                    const positionSelector = `${buttonInfo.tagName.toLowerCase()}[style*="position"]`;
                    const candidates = await buttonPage.$(positionSelector);

                    for (const candidate of candidates) {
                      const rect = await candidate.boundingBox();
                      if (rect &&
                        Math.abs(rect.x - buttonInfo.position.x) < 10 &&
                        Math.abs(rect.y - buttonInfo.position.y) < 10) {
                        selectedButton = candidate;
                        selectionMethod = 'position';
                        testResult.selectionMethod = `Position: (${buttonInfo.position.x}, ${buttonInfo.position.y})`;
                        break;
                      }
                    }
                  } catch (positionError) {
                    // Position selection failed
                  }
                }

                if (!selectedButton) {
                  testResult.classification = 'scanner_limitation';
                  testResult.errors = ['Could not locate button element with any selection strategy'];
                  buttonResults.scanner_limitation.push(testResult);
                  continue;
                }

                // PRE-CLICK STATE CAPTURE
                const preClickState = await buttonPage.evaluate(() => ({
                  url: window.location.href,
                  title: document.title,
                  activeElement: document.activeElement?.tagName,
                  modalCount: document.querySelectorAll('.modal, [role="dialog"]').length,
                  overlayCount: document.querySelectorAll('.overlay, .backdrop').length,
                  loadingCount: document.querySelectorAll('.loading, .spinner').length
                }));

                // ENHANCED BUTTON INTERACTION
                const isVisible = await selectedButton.isIntersectingViewport();
                if (!isVisible) {
                  await selectedButton.scrollIntoViewIfNeeded();
                  await new Promise(resolve => setTimeout(resolve, 500));
                }

                // Clear previous errors before clicking
                allErrors.length = 0;
                consoleMessages.length = 0;
                networkErrors.length = 0;

                // PERFORM CLICK with timeout
                try {
                  await Promise.race([
                    selectedButton.click(),
                    new Promise((_, reject) =>
                      setTimeout(() => reject(new Error('Click timeout')), limits.timePerButton)
                    )
                  ]);
                } catch (clickError) {
                  if (clickError.message === 'Click timeout') {
                    testResult.classification = 'network_timeout';
                    testResult.errors = ['Button click timed out'];
                    buttonResults.network_timeout.push(testResult);
                    continue;
                  }
                  throw clickError;
                }

                // OPTIMIZED STATE CHANGE DETECTION (Reduced from progressive waits)
                const maxWaitTime = limits.maxWaitTime || 500;
                let finalState = null;
                let stateChangeDetected = false;

                // Single quick check instead of progressive waits
                await new Promise(resolve => setTimeout(resolve, 300)); // Quick initial wait

                try {
                  const currentState = await buttonPage.evaluate(() => ({
                    url: window.location.href,
                    title: document.title,
                    modalCount: document.querySelectorAll('.modal, [role="dialog"]').length,
                    overlayCount: document.querySelectorAll('.overlay, .backdrop').length,
                    hasNewContent: document.querySelector('.toast, .notification, .alert, .success, .error') !== null
                  }));

                  // Quick state change detection
                  const stateChanges = [];
                  if (currentState.url !== preClickState.url) {
                    stateChanges.push(`URL changed: ${preClickState.url} -> ${currentState.url}`);
                    stateChangeDetected = true;
                  }
                  if (currentState.title !== preClickState.title) {
                    stateChanges.push(`Title changed: "${preClickState.title}" -> "${currentState.title}"`);
                    stateChangeDetected = true;
                  }
                  if (currentState.modalCount > preClickState.modalCount) {
                    stateChanges.push(`Modal opened (${currentState.modalCount - preClickState.modalCount})`);
                    stateChangeDetected = true;
                  }
                  if (currentState.overlayCount > preClickState.overlayCount) {
                    stateChanges.push(`Overlay appeared (${currentState.overlayCount - preClickState.overlayCount})`);
                    stateChangeDetected = true;
                  }
                  if (currentState.hasNewContent) {
                    stateChanges.push('New notification/alert content appeared');
                    stateChangeDetected = true;
                  }

                  testResult.stateChanges = stateChanges;
                  finalState = currentState;

                  // If no immediate changes and time allows, wait a bit more
                  if (!stateChangeDetected && maxWaitTime > 400) {
                    await new Promise(resolve => setTimeout(resolve, Math.min(maxWaitTime - 300, 400)));

                    // One final check
                    const finalCheck = await buttonPage.evaluate(() => ({
                      url: window.location.href,
                      title: document.title,
                      hasNewContent: document.querySelector('.toast, .notification, .alert, .success, .error') !== null
                    }));

                    if (finalCheck.url !== currentState.url || finalCheck.title !== currentState.title || finalCheck.hasNewContent) {
                      testResult.stateChanges.push('Delayed state change detected');
                      stateChangeDetected = true;
                    }
                  }

                } catch (stateError) {
                  // State checking failed, continue with what we have
                  testResult.stateChanges = [];
                }

                testResult.responseTime = Date.now() - startTime;

                // ERROR CLASSIFICATION
                const authKeywords = ['401', '403', 'unauthorized', 'forbidden', 'login required', 'access denied'];
                const networkKeywords = ['network', 'timeout', 'connection', 'fetch', 'cors', 'net::', 'dns'];
                const jsKeywords = ['javascript', 'script error', 'undefined', 'null', 'reference error', 'type error'];

                const allErrorText = [...allErrors, ...networkErrors].join(' ').toLowerCase();

                if (allErrors.length === 0 && networkErrors.length === 0) {
                  if (testResult.stateChanges.length > 0) {
                    testResult.classification = 'working';
                    buttonResults.working.push(testResult);
                    buttonResults.state_changes.push({
                      ...testResult,
                      changes: testResult.stateChanges
                    });
                  } else {
                    // No errors, but no visible state changes either
                    testResult.classification = 'working';
                    testResult.notes = 'Button click succeeded but no visible state changes detected';
                    buttonResults.working.push(testResult);
                  }
                } else if (authKeywords.some(keyword => allErrorText.includes(keyword))) {
                  testResult.classification = 'auth_required';
                  testResult.errors = allErrors.filter(error =>
                    authKeywords.some(keyword => error.toLowerCase().includes(keyword))
                  );
                  buttonResults.auth_required.push(testResult);
                } else if (networkKeywords.some(keyword => allErrorText.includes(keyword))) {
                  testResult.classification = 'network_timeout';
                  testResult.errors = [...allErrors, ...networkErrors].filter(error =>
                    networkKeywords.some(keyword => error.toLowerCase().includes(keyword))
                  );
                  buttonResults.network_timeout.push(testResult);
                } else if (jsKeywords.some(keyword => allErrorText.includes(keyword))) {
                  testResult.classification = 'javascript_error';
                  testResult.errors = allErrors.filter(error =>
                    jsKeywords.some(keyword => error.toLowerCase().includes(keyword))
                  );
                  buttonResults.javascript_error.push(testResult);
                } else {
                  // Unclassified errors - likely genuine issues
                  testResult.classification = 'genuine_broken';
                  testResult.errors = [...allErrors, ...networkErrors];
                  buttonResults.genuine_broken.push(testResult);
                }

              } catch (error) {
                testResult.classification = 'scanner_limitation';
                testResult.errors = [error.message];
                buttonResults.scanner_limitation.push(testResult);
              } finally {
                if (buttonPage) {
                  try {
                    await buttonPage.close();
                  } catch (e) {
                    // Ignore close errors
                  }
                }
              }
              // AGGREGATE RESULTS with Enhanced Classification
              const buttonSummary = {
                total: buttons.length,
                tested: Math.min(buttons.length, limits.buttons),
                working: buttonResults.working.length,
                genuine_broken: buttonResults.genuine_broken.length,
                scanner_limitation: buttonResults.scanner_limitation.length,
                auth_required: buttonResults.auth_required.length,
                network_timeout: buttonResults.network_timeout.length,
                javascript_error: buttonResults.javascript_error.length,
                with_state_changes: buttonResults.state_changes.length
              };

              // Update legacy format for backward compatibility
              buttonResults.working.forEach(result => {
                allIssues.workingButtons.push({
                  page: result.page,
                  button: result.button,
                  classification: result.classification,
                  selectionMethod: result.selectionMethod,
                  responseTime: result.responseTime,
                  stateChanges: result.stateChanges
                });
              });

              // Add genuinely broken buttons to legacy format
              buttonResults.genuine_broken.forEach(result => {
                allIssues.brokenButtons.push({
                  page: result.page,
                  button: result.button,
                  errors: result.errors,
                  classification: result.classification,
                  selectionMethod: result.selectionMethod
                });
              });

              // Add auth issues to legacy format
              buttonResults.auth_required.forEach(result => {
                allIssues.authErrors.push({
                  page: result.page,
                  button: result.button,
                  errors: result.errors,
                  classification: result.classification
                });
              });

              // Store enhanced results
              if (!allIssues.enhancedButtonResults) {
                allIssues.enhancedButtonResults = [];
              }
              allIssues.enhancedButtonResults.push({
                page: fullUrl,
                complexity: complexityLevel,
                summary: buttonSummary,
                results: buttonResults
              });

              // ENHANCED LOGGING
              if (buttonSummary.tested > 0) {
                const accuracyRate = Math.round((buttonSummary.working / buttonSummary.tested) * 100);
                addLog(` Button Analysis Complete: ${buttonSummary.tested} tested, ${buttonSummary.working} working (${accuracyRate}% success)`, 'info');

                if (buttonSummary.genuine_broken > 0) {
                  addLog(` 🔴 ${buttonSummary.genuine_broken} genuinely broken buttons found`, 'error');
                }
                if (buttonSummary.auth_required > 0) {
                  addLog(` 🟡 ${buttonSummary.auth_required} buttons require authentication`, 'warning');
                }
                if (buttonSummary.scanner_limitation > 0) {
                  addLog(` 🟠 ${buttonSummary.scanner_limitation} buttons had selector issues (not site problems)`, 'warning');
                }
                if (buttonSummary.javascript_error > 0) {
                  addLog(` 🟣 ${buttonSummary.javascript_error} buttons triggered JavaScript errors`, 'warning');
                }
                if (buttonSummary.network_timeout > 0) {
                  addLog(` ⏱️ ${buttonSummary.network_timeout} buttons experienced network timeouts`, 'warning');
                }
                if (buttonSummary.with_state_changes > 0) {
                  addLog(` ✨ ${buttonSummary.with_state_changes} buttons caused visible state changes`, 'success');
                }

                // Update buttons section progress
                updateSectionProgress('buttons',
                  allIssues.brokenButtons.length + allIssues.workingButtons.length,
                  maxButtonsPerPage * Math.min(pageLimit, 10),
                  'running'
                );

                // Complete buttons section when all pages are done
                if (processedPages >= pageLimit || pagesToCrawl.length === 0) {
                  const totalButtonsChecked = allIssues.brokenButtons.length + allIssues.workingButtons.length;
                  completeSectionWithLog('buttons', totalButtonsChecked, allIssues.brokenButtons.length);
                }
              } else {
                addLog(` No buttons were tested due to complexity or limits`, 'info');
              }

            }

            if (options.includeSEO !== false && processedPages <= 100) {
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

                // Update SEO section progress
                updateSectionProgress('seo',
                  allIssues.seoData ? allIssues.seoData.length : 0,
                  Math.min(pageLimit, 20),
                  'running'
                );

                // Complete SEO section when all pages are done
                if (processedPages >= pageLimit || pagesToCrawl.length === 0) {
                  const totalSEOPages = allIssues.seoData ? allIssues.seoData.length : 0;
                  const totalSEOIssues = allIssues.seoIssues ? allIssues.seoIssues.length : 0;
                  completeSectionWithLog('seo', totalSEOPages, totalSEOIssues);
                }

              } catch (error) {
                addLog(` Error checking SEO: ${error.message}`, 'error');
              }
            }

            if (options.includePerformance !== false && processedPages <= 100) { // Test performance on first 10 pages
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

                // Update performance section progress
                updateSectionProgress('performance',
                  allIssues.performanceData ? allIssues.performanceData.length : 0,
                  Math.min(pageLimit, 20),
                  'running'
                );

                // Complete performance section when all pages are done
                if (processedPages >= pageLimit || pagesToCrawl.length === 0) {
                  const totalPerfPages = allIssues.performanceData ? allIssues.performanceData.length : 0;
                  const slowPages = allIssues.performanceData ? allIssues.performanceData.filter(p =>
                    p.firstContentfulPaint > 3000 || p.totalElements > 1500 || p.pageSize > 2000
                  ).length : 0;
                  completeSectionWithLog('performance', totalPerfPages, slowPages);
                }

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

                  // Update forms section progress
                  const totalFormsFound = allIssues.workingLinks ? allIssues.workingLinks.filter(l => l.type === 'form').length : 0;
                  updateSectionProgress('forms', totalFormsFound, 10, 'running');

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

                  // Complete forms section when all pages are done
                  if (processedPages >= pageLimit || pagesToCrawl.length === 0) {
                    const totalFormsChecked = allIssues.workingLinks ? allIssues.workingLinks.filter(l => l.type === 'form').length : 0;
                    const brokenFormActions = allIssues.brokenLinks ? allIssues.brokenLinks.filter(l => l.type === 'form').length : 0;
                    completeSectionWithLog('forms', totalFormsChecked, brokenFormActions);
                  }
                } else {
                  // Complete forms section immediately if no forms found
                  if (processedPages >= pageLimit || pagesToCrawl.length === 0) {
                    completeSectionWithLog('forms', 0, 0);
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
          } // End shouldSkipButtonTesting
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

      // Complete resources section when all pages are done (placeholder for future implementation)
      if (processedPages >= pageLimit || pagesToCrawl.length === 0) {
        const totalResourcesChecked = allIssues.missingResources ? allIssues.missingResources.length : 0;
        const missingResourcesCount = allIssues.missingResources ? allIssues.missingResources.length : 0;
        completeSectionWithLog('resources', totalResourcesChecked, missingResourcesCount);
      }
    }
    // SCAN DEPTH SPECIFIC LIMITS
    const pageLimit = options.maxPages;
    const linkLimit = options.maxLinks;
    const maxButtonsPerPage = options.maxButtons || 5;
    const buttonTimeoutLimit = options.buttonTimeout || 2000;
    const pageTimeoutLimit = options.timeoutPerPage || 8000;

    addLog(` ${options.scanName || 'Scan'} configuration: maxPages=${pageLimit}, maxLinks=${linkLimit}, maxButtons=${maxButtonsPerPage}, depth=${options.scanDepth}`, 'info');

    // DISCOVERY FUNCTION
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
      addLog(` Starting page discovery...`, 'info');
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

    // Crawl pages - SCANNING
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

      // Add memory and time checks with AGGRESSIVE limits for speed
      const memUsage = process.memoryUsage().heapUsed / 1024 / 1024;
      const scanDuration = Date.now() - new Date(scan.startTime).getTime();

      if (memUsage > 800) {
        addLog(` Memory usage high (${Math.round(memUsage)}MB), continuing with caution`, 'warning');
      }

      // AGGRESSIVE TIME LIMIT - Stop after 10 minutes max
      if (scanDuration > 10 * 60 * 1000) {
        addLog(` 🚨 Scan time limit reached (10 minutes), stopping for performance`, 'warning');
        break;
      }

      // Add a smaller delay between pages
      await delay(200); // Reduced from 500

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
      pagesWithErrors: allIssues.pageErrors.length,
      // New metrics
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

    // Increment user's scan count in database
    try {
      await pool.query(
        `UPDATE users SET scans_used_this_month = scans_used_this_month + 1, last_scan_date = CURRENT_DATE WHERE wallet_address = $1`,
        [scan.user]
      );
      addLog(` Scan count incremented for user ${scan.user}`, 'info');
    } catch (dbError) {
      console.error('Error incrementing scan count:', dbError);
      addLog(` Warning: Could not increment scan count`, 'warning');
    }

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

// WALLET AUTHENTICATION ENDPOINTS
app.post('/api/auth/nonce', async (req, res) => {
  try {
    const { walletAddress } = req.body;

    if (!walletAddress) {
      return res.status(400).json({ error: 'Wallet address is required' });
    }

    // Generate a unique nonce
    const nonce = crypto.randomBytes(32).toString('hex');

    // Store nonce in database
    await pool.query(
      `INSERT INTO users (wallet_address, subscription_tier, subscription_status)
       VALUES ($1, 'free', 'active')
       ON CONFLICT (wallet_address) DO NOTHING`,
      [walletAddress.toLowerCase()]
    );

    // Store nonce (we'll use a simple approach for now - in production, consider a separate nonces table)
    const nonceKey = `nonce:${walletAddress.toLowerCase()}`;
    await pool.query(
      `UPDATE users SET subscription_end_date = $1 WHERE wallet_address = $2`,
      [new Date(Date.now() + (5 * 60 * 1000)), walletAddress.toLowerCase()] // Store expiry in subscription_end_date temporarily
    );

    // For nonce storage, we'll use a simple approach - store in a JSON field or separate table
    // For now, we'll use the database to store nonce data
    global.nonceStore = global.nonceStore || new Map();
    global.nonceStore.set(walletAddress.toLowerCase(), {
      nonce,
      timestamp: Date.now(),
      expiresAt: Date.now() + (5 * 60 * 1000) // 5 minutes
    });

    res.json({ nonce });
  } catch (error) {
    console.error('Nonce generation error:', error);
    res.status(500).json({ error: 'Failed to generate nonce' });
  }
});

app.post('/api/auth/verify', async (req, res) => {
  try {
    const { walletAddress, signature, message } = req.body;

    if (!walletAddress || !signature || !message) {
      return res.status(400).json({ error: 'Wallet address, signature, and message are required' });
    }

    // Get stored nonce
    const storedData = global.nonceStore?.get(walletAddress.toLowerCase());
    if (!storedData) {
      return res.status(400).json({ error: 'No nonce found for this wallet' });
    }

    // Check if nonce has expired
    if (Date.now() > storedData.expiresAt) {
      global.nonceStore.delete(walletAddress.toLowerCase());
      return res.status(400).json({ error: 'Nonce has expired' });
    }

    // Verify the signature
    const ethers = await import('ethers');
    const messageHash = ethers.hashMessage(message);
    const recoveredAddress = ethers.recoverAddress(messageHash, signature);

    if (recoveredAddress.toLowerCase() !== walletAddress.toLowerCase()) {
      return res.status(400).json({ error: 'Invalid signature' });
    }

    // Check if message contains the correct nonce
    if (!message.includes(storedData.nonce)) {
      return res.status(400).json({ error: 'Invalid message content' });
    }

    // Clear the used nonce
    global.nonceStore.delete(walletAddress.toLowerCase());

    // Get or create user in database
    const userResult = await pool.query(
      `SELECT * FROM users WHERE wallet_address = $1`,
      [walletAddress.toLowerCase()]
    );

    let user;
    if (userResult.rows.length === 0) {
      // Create new user
      const newUserResult = await pool.query(
        `INSERT INTO users (wallet_address, subscription_tier, subscription_status, monthly_scan_limit)
         VALUES ($1, 'free', 'active', 5)
         RETURNING *`,
        [walletAddress.toLowerCase()]
      );
      user = newUserResult.rows[0];
    } else {
      user = userResult.rows[0];
    }

    // Generate JWT token
    const token = jwt.sign(
      {
        walletAddress: walletAddress.toLowerCase(),
        subscriptionTier: user.subscription_tier,
        authenticatedAt: new Date().toISOString()
      },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({
      token,
      user: {
        walletAddress: walletAddress.toLowerCase(),
        subscriptionTier: user.subscription_tier,
        subscriptionStatus: user.subscription_status,
        scansUsedThisMonth: user.scans_used_this_month,
        monthlyScanLimit: user.monthly_scan_limit,
        authenticatedAt: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('Signature verification error:', error);
    res.status(500).json({ error: 'Failed to verify signature' });
  }
});

// PAYMENT ENDPOINTS (NOWPayments)
app.post('/api/create-payment', authenticateToken, async (req, res) => {
  try {
    const { plan, amount, currency, walletAddress } = req.body;
    const user = req.user;

    if (!plan || !amount || !currency) {
      return res.status(400).json({ error: 'Plan, amount, and currency are required' });
    }

    // Validate user owns the wallet
    if (user.walletAddress !== walletAddress.toLowerCase()) {
      return res.status(403).json({ error: 'Wallet address mismatch' });
    }

    // NOWPayments API configuration
    const NOWPAYMENTS_API_URL = 'https://api.nowpayments.io/v1';
    const NOWPAYMENTS_API_KEY = process.env.NOWPAYMENTS_SECRET_KEY;

    if (!NOWPAYMENTS_API_KEY) {
      return res.status(500).json({ error: 'Payment service not configured' });
    }

    // Create payment invoice
    const paymentData = {
      price_amount: amount,
      price_currency: currency,
      pay_currency: 'BTC', // Changed from USDT to BTC (more widely supported)
      order_id: `webscan-${user.walletAddress}-${Date.now()}`,
      order_description: `WebScan Pro ${plan} subscription`,
      success_url: `${req.protocol}://${req.get('host')}/app?payment=success`,
      cancel_url: `${req.protocol}://${req.get('host')}/?payment=cancelled`,
      ipn_callback_url: `${req.protocol}://${req.get('host')}/api/nowpayments-webhook`
    };

    const response = await fetch(`${NOWPAYMENTS_API_URL}/invoice`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': NOWPAYMENTS_API_KEY
      },
      body: JSON.stringify(paymentData)
    });

    if (!response.ok) {
      const errorData = await response.text();
      console.error('NOWPayments API error:', errorData);
      return res.status(500).json({ error: 'Failed to create payment invoice' });
    }

    const paymentResult = await response.json();

    res.json({
      paymentId: paymentResult.id,
      paymentUrl: paymentResult.invoice_url,
      payAddress: paymentResult.pay_address,
      payAmount: paymentResult.pay_amount,
      payCurrency: paymentResult.pay_currency
    });
  } catch (error) {
    console.error('Payment creation error:', error);
    res.status(500).json({ error: 'Failed to create payment' });
  }
});

// NOWPayments webhook endpoint
app.post('/api/nowpayments-webhook', async (req, res) => {
  try {
    const webhookData = req.body;

    // Verify webhook signature using IPN secret
    const NOWPAYMENTS_IPN_SECRET = process.env.NOWPAYMENTS_IPN_KEY;
    if (NOWPAYMENTS_IPN_SECRET) {
      const expectedSignature = crypto
        .createHmac('sha512', NOWPAYMENTS_IPN_SECRET)
        .update(JSON.stringify(webhookData))
        .digest('hex');

      const receivedSignature = req.headers['x-nowpayments-sig'];

      if (receivedSignature !== expectedSignature) {
        return res.status(400).json({ error: 'Invalid webhook signature' });
      }
    }

    // Process payment status update
    if (webhookData.payment_status === 'finished' || webhookData.payment_status === 'confirmed') {
      const orderId = webhookData.order_id;
      const walletAddress = orderId.split('-')[1]; // Extract wallet address from order_id
      const plan = orderId.split('-')[2]; // Extract plan from order_id

      console.log(`Payment confirmed for wallet: ${walletAddress}, plan: ${plan}`);

      // Update user subscription in PostgreSQL database
      try {
        const subscriptionDetails = {
          pro: {
            tier: 'pro',
            limit: 1000, // Unlimited scans (represented as high number)
            endDate: new Date(Date.now() + (30 * 24 * 60 * 60 * 1000)) // 30 days from now
          }
        };

        const planDetails = subscriptionDetails[plan];
        if (planDetails) {
          await pool.query(
            `UPDATE users
             SET subscription_tier = $1,
                 subscription_status = 'active',
                 subscription_start_date = CURRENT_TIMESTAMP,
                 subscription_end_date = $2,
                 monthly_scan_limit = $3,
                 updated_at = CURRENT_TIMESTAMP
             WHERE wallet_address = $4`,
            [planDetails.tier, planDetails.endDate, planDetails.limit, walletAddress.toLowerCase()]
          );

          console.log(`Updated subscription for ${walletAddress} to ${plan} tier`);
        }

        // Record the payment
        await pool.query(
          `INSERT INTO payments (payment_id, user_wallet_address, plan, amount, currency, payment_status, nowpayments_order_id)
           VALUES ($1, $2, $3, $4, $5, 'completed', $6)
           ON CONFLICT (payment_id) DO UPDATE SET
             payment_status = 'completed',
             updated_at = CURRENT_TIMESTAMP`,
          [webhookData.payment_id, walletAddress.toLowerCase(), plan, webhookData.pay_amount, webhookData.pay_currency, orderId]
        );

      } catch (dbError) {
        console.error('Database update error:', dbError);
        // Don't fail the webhook, just log the error
      }
    }

    res.json({ received: true });
  } catch (error) {
    console.error('Webhook processing error:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// TOKEN VERIFICATION ENDPOINT
app.post('/api/auth/verify-token', authenticateToken, (req, res) => {
  // If middleware passes, token is valid
  res.json({
    valid: true,
    user: {
      walletAddress: req.user.walletAddress,
      subscriptionTier: req.user.subscriptionTier,
      authenticatedAt: req.user.authenticatedAt
    }
  });
});

// ROUTING FOR LANDING PAGE AND APP
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'landing.html'));
});

app.get('/app', (req, res) => {
  // Serve the app - authentication is handled client-side
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Static files middleware (must come after routes to avoid conflicts)
app.use(express.static('public'));

// Protect scan endpoint with authentication
app.post('/api/scan', authenticateToken, async (req, res) => {
  try {
    const user = req.user;

    // Get user's current subscription and scan count from database
    const userResult = await pool.query(
      `SELECT subscription_tier, subscription_status, scans_used_this_month, monthly_scan_limit, subscription_end_date
       FROM users WHERE wallet_address = $1`,
      [user.walletAddress]
    );

    if (userResult.rows.length === 0) {
      return res.status(403).json({ error: 'User not found' });
    }

    const userData = userResult.rows[0];

    // Check if subscription is active
    if (userData.subscription_status !== 'active') {
      return res.status(403).json({
        error: 'Subscription is not active',
        subscriptionStatus: userData.subscription_status
      });
    }

    // Check if subscription has expired
    if (userData.subscription_end_date && new Date(userData.subscription_end_date) < new Date()) {
      // Update status to expired
      await pool.query(
        `UPDATE users SET subscription_status = 'expired' WHERE wallet_address = $1`,
        [user.walletAddress]
      );
      return res.status(403).json({ error: 'Subscription has expired' });
    }

    // Check scan limits
    if (userData.scans_used_this_month >= userData.monthly_scan_limit) {
      return res.status(429).json({
        error: 'Monthly scan limit reached',
        scansUsed: userData.scans_used_this_month,
        monthlyLimit: userData.monthly_scan_limit,
        subscriptionTier: userData.subscription_tier
      });
    }

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

    // Apply subscription-based limits
    const tierLimits = {
      free: { maxPages: 25, maxLinks: 10, maxButtons: 2, scanDepth: 'fast' },
      pro: { maxPages: 150, maxLinks: 50, maxButtons: 10, scanDepth: 'deep' }
    };

    const limits = tierLimits[userData.subscription_tier] || tierLimits.free;

    // Enhanced scan configuration with depth-specific defaults
    const isProduction = process.env.NODE_ENV === 'production';
    const scanDepth = options.scanDepth || limits.scanDepth;

    // Apply scan depth configurations with user limits
    let depthConfig = {};
    switch (scanDepth) {
      case 'fast':
        depthConfig = {
          maxPages: Math.min(options.maxPages || limits.maxPages, limits.maxPages),
          maxLinks: Math.min(options.maxLinks || limits.maxLinks, limits.maxLinks),
          maxButtons: Math.min(options.maxButtons || limits.maxButtons, limits.maxButtons),
          includeButtons: options.includeButtons !== false,
          includeForms: options.includeForms !== undefined ? options.includeForms : false,
          includeResources: options.includeResources !== undefined ? options.includeResources : false,
          includePerformance: options.includePerformance !== undefined ? options.includePerformance : false,
          includeSEO: options.includeSEO !== false,
          timeoutPerPage: options.timeoutPerPage || 5000,
          buttonTimeout: options.buttonTimeout || 1000
        };
        break;
      case 'balanced':
        depthConfig = {
          maxPages: Math.min(options.maxPages || 75, limits.maxPages),
          maxLinks: Math.min(options.maxLinks || 25, limits.maxLinks),
          maxButtons: Math.min(options.maxButtons || 5, limits.maxButtons),
          includeButtons: options.includeButtons !== false,
          includeForms: options.includeForms !== false,
          includeResources: options.includeResources !== false,
          includePerformance: options.includePerformance !== false,
          includeSEO: options.includeSEO !== false,
          timeoutPerPage: options.timeoutPerPage || 8000,
          buttonTimeout: options.buttonTimeout || 2000
        };
        break;
      case 'deep':
        depthConfig = {
          maxPages: Math.min(options.maxPages || 150, limits.maxPages),
          maxLinks: Math.min(options.maxLinks || 50, limits.maxLinks),
          maxButtons: Math.min(options.maxButtons || 10, limits.maxButtons),
          includeButtons: options.includeButtons !== false,
          includeForms: options.includeForms !== false,
          includeResources: options.includeResources !== false,
          includePerformance: options.includePerformance !== false,
          includeSEO: options.includeSEO !== false,
          timeoutPerPage: options.timeoutPerPage || 12000,
          buttonTimeout: options.buttonTimeout || 3000
        };
        break;
    }

    const scanOptions = {
      ...depthConfig,
      useSitemap: options.useSitemap !== false,
      timeout: options.timeout || 30000,
      comprehensive: options.comprehensive !== false,
      testDepth: scanDepth,
      scanDepth: scanDepth,
      scanName: options.scanName || `${scanDepth.charAt(0).toUpperCase() + scanDepth.slice(1)} Scan`
    };

    const scan = {
      id: scanId,
      status: 'running',
      progress: 0,
      url,
      options: scanOptions,
      startTime: new Date(),
      results: null,
      user: user.walletAddress, // Track which user initiated the scan
      // Enhanced section-specific tracking
      sectionProgress: {
        links: { status: 'pending', progress: 0, completed: false, total: 0, tested: 0 },
        buttons: { status: 'pending', progress: 0, completed: false, total: 0, tested: 0 },
        seo: { status: 'pending', progress: 0, completed: false, total: 0, tested: 0 },
        performance: { status: 'pending', progress: 0, completed: false, total: 0, tested: 0 },
        forms: { status: 'pending', progress: 0, completed: false, total: 0, tested: 0 },
        resources: { status: 'pending', progress: 0, completed: false, total: 0, tested: 0 }
      },
      logs: []
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

// STOP/RESUME SCAN ENDPOINTS
app.post('/api/scan/stop', authenticateToken, async (req, res) => {
  try {
    const { scanId } = req.body;
    const user = req.user;

    if (!scanId) {
      return res.status(400).json({ error: 'scanId is required' });
    }

    // Get the scan from active scans
    const scan = activeScans.get(scanId);
    if (!scan) {
      return res.status(404).json({ error: 'Scan not found' });
    }

    // Verify user owns this scan
    if (scan.user !== user.walletAddress) {
      return res.status(403).json({ error: 'Unauthorized to stop this scan' });
    }

    // Update scan status to paused
    scan.status = 'paused';
    scan.pausedAt = new Date();

    // Save the current scan state to database
    await scanStateManager.saveScanSession(scanId, scan);

    // Remove from active scans but keep in database for resumption
    activeScans.delete(scanId);

    res.json({
      success: true,
      message: 'Scan stopped successfully',
      scanId: scanId,
      status: 'paused'
    });
  } catch (error) {
    console.error('Error stopping scan:', error);
    res.status(500).json({ error: 'Failed to stop scan' });
  }
});

app.post('/api/scan/resume', authenticateToken, async (req, res) => {
  try {
    const { scanId } = req.body;
    const user = req.user;

    if (!scanId) {
      return res.status(400).json({ error: 'scanId is required' });
    }

    // First check if scan is already active
    if (activeScans.has(scanId)) {
      const activeScan = activeScans.get(scanId);
      if (activeScan.user === user.walletAddress) {
        return res.json({
          success: true,
          message: 'Scan is already running',
          scanId: scanId,
          status: activeScan.status
        });
      }
    }

    // Try to load from database
    let scan = await scanStateManager.loadScanSession(scanId);
    if (!scan) {
      return res.status(404).json({ error: 'Scan session not found' });
    }

    // Verify user owns this scan
    if (scan.user !== user.walletAddress) {
      return res.status(403).json({ error: 'Unauthorized to resume this scan' });
    }

    // Check if scan is already completed or in error state
    if (scan.status === 'completed' || scan.status === 'error') {
      return res.status(400).json({
        error: 'Cannot resume completed or failed scan',
        status: scan.status
      });
    }

    // If scan was paused, update status and add back to active scans
    if (scan.status === 'paused') {
      scan.status = 'running';
      scan.resumedAt = new Date();

      // Update the scan in database
      await scanStateManager.updateScanStatus(scanId, 'running');

      // Add back to active scans
      activeScans.set(scanId, scan);

      // Resume the scan process if it was originally running
      if (scan.url && scan.options) {
        // Note: In a real implementation, you'd need to resume the actual scanning process
        // For now, we'll just update the status and let the frontend handle the UI
      }
    }

    res.json({
      success: true,
      message: 'Scan resumed successfully',
      scanId: scanId,
      status: scan.status
    });
  } catch (error) {
    console.error('Error resuming scan:', error);
    res.status(500).json({ error: 'Failed to resume scan' });
  }
});

// Enhanced scan status endpoint to handle both active and paused scans
app.get('/api/scan/:scanId', authenticateToken, async (req, res) => {
  try {
    const { scanId } = req.params;
    const user = req.user;

    // First check active scans
    let scan = activeScans.get(scanId);

    if (!scan) {
      // If not in active scans, check database for paused/completed scans
      scan = await scanStateManager.loadScanSession(scanId);

      if (!scan) {
        return res.status(404).json({ error: 'Scan not found' });
      }

      // Verify user owns this scan
      if (scan.user !== user.walletAddress) {
        return res.status(403).json({ error: 'Unauthorized to access this scan' });
      }
    } else {
      // Verify user owns this scan
      if (scan.user !== user.walletAddress) {
        return res.status(403).json({ error: 'Unauthorized to access this scan' });
      }
    }

    res.json(scan);
  } catch (error) {
    console.error('GET /api/scan/:scanId error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ADDED: Also handle query parameter route for frontend compatibility
app.get('/api/scan', authenticateToken, async (req, res) => {
  try {
    const { scanId } = req.query;
    const user = req.user;

    if (!scanId) {
      return res.status(400).json({ error: 'scanId query parameter is required' });
    }

    // First check active scans
    let scan = activeScans.get(scanId);

    if (!scan) {
      // If not in active scans, check database for paused/completed scans
      scan = await scanStateManager.loadScanSession(scanId);

      if (!scan) {
        return res.status(404).json({ error: 'Scan not found' });
      }

      // Verify user owns this scan
      if (scan.user !== user.walletAddress) {
        return res.status(403).json({ error: 'Unauthorized to access this scan' });
      }
    } else {
      // Verify user owns this scan
      if (scan.user !== user.walletAddress) {
        return res.status(403).json({ error: 'Unauthorized to access this scan' });
      }
    }

    res.json(scan);
  } catch (error) {
    console.error('GET /api/scan error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});
