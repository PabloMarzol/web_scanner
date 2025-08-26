import express from 'express';
import cors from 'cors';
// ADD THE SUSPICIOUS IMPORTS
import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// Your exact routes (same as test 6)
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.post('/api/scan', (req, res) => {
  res.json({ message: 'scan endpoint with puppeteer imports' });
});

app.get('/api/scan', (req, res) => {
  res.json({ message: 'get scan endpoint with puppeteer imports' });
});

const server = app.listen(3009, 'localhost', () => console.log('Puppeteer imports test on 3009'));