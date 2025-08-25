class WebsiteTester {
    constructor() {
        this.currentScanId = null;
        this.pollInterval = null;
        this.initEventListeners();
        this.addEntranceAnimations();
    }
    
    addEntranceAnimations() {
        // Stagger animations for cards and sections
        const animatedElements = document.querySelectorAll('.animate-slide-up');
        animatedElements.forEach((el, index) => {
            el.style.animationDelay = `${index * 0.1}s`;
        });
    }
    
    initEventListeners() {
        document.getElementById('startScan').addEventListener('click', () => this.startScan());
        document.getElementById('websiteUrl').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.startScan();
        });
        document.getElementById('downloadReport').addEventListener('click', () => this.downloadReport());
        
        // Add input animation
        const urlInput = document.getElementById('websiteUrl');
        urlInput.addEventListener('focus', () => {
            urlInput.parentElement.classList.add('glow');
        });
        urlInput.addEventListener('blur', () => {
            urlInput.parentElement.classList.remove('glow');
        });
    }
    
    showLoadingOverlay() {
        document.getElementById('loadingOverlay').classList.remove('hidden');
    }
    
    hideLoadingOverlay() {
        document.getElementById('loadingOverlay').classList.add('hidden');
    }
    
    async startScan() {
        const url = document.getElementById('websiteUrl').value.trim();
        
        if (!url) {
            this.showNotification('Please enter a website URL', 'error');
            return;
        }
        
        // Validate URL
        try {
            new URL(url);
        } catch {
            this.showNotification('Please enter a valid URL (including http:// or https://)', 'error');
            return;
        }
        
        this.showLoadingOverlay();
        this.currentScanId = 'scan_' + Date.now();
        
        try {
            console.log('Starting scan for:', url);
            
            const response = await fetch('/api/scan', {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                body: JSON.stringify({ url, scanId: this.currentScanId })
            });
            
            console.log('Response status:', response.status);
            console.log('Response headers:', response.headers);
            
            if (!response.ok) {
                const errorText = await response.text();
                console.error('Response error:', errorText);
                throw new Error(`HTTP ${response.status}: ${errorText}`);
            }
            
            const result = await response.json();
            console.log('Scan started:', result);
            
            this.hideLoadingOverlay();
            
            // Show progress section with animation
            document.getElementById('progressSection').classList.remove('hidden');
            document.getElementById('resultsSection').classList.add('hidden');
            
            // Start polling for results
            this.pollForResults();
            
        } catch (error) {
            console.error('Full error details:', error);
            this.hideLoadingOverlay();
            this.showNotification('Error starting scan: ' + error.message, 'error');
        }
    }
    
    showNotification(message, type = 'info') {
        const notification = document.createElement('div');
        notification.className = `fixed top-4 right-4 z-50 glass rounded-2xl p-4 text-white max-w-sm transition-all duration-500 transform translate-x-full`;
        
        const icon = type === 'error' ? 'fas fa-exclamation-circle text-red-400' : 
                    type === 'success' ? 'fas fa-check-circle text-green-400' : 
                    'fas fa-info-circle text-blue-400';
        
        notification.innerHTML = `
            <div class="flex items-center gap-3">
                <i class="${icon}"></i>
                <span>${message}</span>
            </div>
        `;
        
        document.body.appendChild(notification);
        
        // Animate in
        setTimeout(() => {
            notification.style.transform = 'translateX(0)';
        }, 100);
        
        // Animate out and remove
        setTimeout(() => {
            notification.style.transform = 'translateX(100%)';
            setTimeout(() => {
                document.body.removeChild(notification);
            }, 500);
        }, 3000);
    }
    
    async pollForResults() {
        this.pollInterval = setInterval(async () => {
            try {
                // FIXED: Use query parameter instead of path parameter for Vercel
                const response = await fetch(`/api/scan?scanId=${this.currentScanId}`);
                const scan = await response.json();
                
                // Update progress with smooth animation
                const progressBar = document.getElementById('progressBar');
                const progressPercent = document.getElementById('progressPercent');
                
                progressPercent.textContent = Math.round(scan.progress) + '%';
                progressBar.style.width = scan.progress + '%';
                
                // Update real-time logs
                this.updateLogs(scan.logs || []);
                
                if (scan.status === 'running') {
                    document.getElementById('progressStatus').innerHTML = 
                        `<i class="fas fa-circle-notch animate-spin text-blue-400"></i> Scanning pages and testing functionality... ${Math.round(scan.progress)}% complete`;
                } else if (scan.status === 'completed') {
                    clearInterval(this.pollInterval);
                    document.getElementById('progressSection').classList.add('hidden');
                    this.displayResults(scan.results);
                    this.showNotification('Scan completed successfully!', 'success');
                } else if (scan.status === 'error') {
                    clearInterval(this.pollInterval);
                    this.showNotification('Scan failed: ' + scan.error, 'error');
                    document.getElementById('progressSection').classList.add('hidden');
                }
                
            } catch (error) {
                clearInterval(this.pollInterval);
                this.showNotification('Error checking scan status: ' + error.message, 'error');
                document.getElementById('progressSection').classList.add('hidden');
            }
        }, 2000);
    }
    
    updateLogs(logs) {
        const logsContainer = document.getElementById('realTimeLogs');
        
        // Keep track of already displayed logs to avoid duplicates
        if (!this.displayedLogs) {
            this.displayedLogs = new Set();
        }
        
        // Show last 20 logs
        const recentLogs = logs.slice(-20);
        
        // Only add new logs that haven't been displayed yet
        recentLogs.forEach((log, index) => {
            const logKey = `${log.timestamp}-${log.message}`;
            
            // Skip if we've already displayed this log
            if (this.displayedLogs.has(logKey)) {
                return;
            }
            
            // Mark this log as displayed
            this.displayedLogs.add(logKey);
            
            const logElement = document.createElement('div');
            const timestamp = new Date(log.timestamp).toLocaleTimeString();
            
            // Color and icon based on log type
            let textColor = 'text-blue-400';
            let icon = 'fas fa-info-circle';
            
            switch (log.type) {
                case 'success':
                    textColor = 'text-green-400';
                    icon = 'fas fa-check-circle';
                    break;
                case 'warning':
                    textColor = 'text-yellow-400';
                    icon = 'fas fa-exclamation-triangle';
                    break;
                case 'error':
                    textColor = 'text-red-400';
                    icon = 'fas fa-times-circle';
                    break;
            }
            
            logElement.className = `${textColor} text-xs opacity-0 transform translate-y-2 transition-all duration-500 ease-out`;
            logElement.innerHTML = `
                <div class="flex items-start gap-2 py-1">
                    <span class="text-gray-500 text-xs flex-shrink-0">[${timestamp}]</span>
                    <i class="${icon} text-xs mt-0.5 flex-shrink-0"></i>
                    <span class="break-all leading-relaxed">${log.message}</span>
                </div>
            `;
            
            // Add the new log element
            logsContainer.appendChild(logElement);
            
            // Animate in the new log with a slight delay
            requestAnimationFrame(() => {
                setTimeout(() => {
                    logElement.style.opacity = '1';
                    logElement.style.transform = 'translateY(0)';
                }, 50);
            });
            
            // Remove old logs if we have too many (keep performance good)
            const allLogs = logsContainer.children;
            if (allLogs.length > 25) {
                const oldLog = allLogs[0];
                oldLog.style.opacity = '0';
                oldLog.style.transform = 'translateY(-10px)';
                setTimeout(() => {
                    if (oldLog.parentNode) {
                        logsContainer.removeChild(oldLog);
                    }
                }, 300);
            }
        });
        
        // Clean up displayed logs set if it gets too large
        if (this.displayedLogs.size > 100) {
            this.displayedLogs = new Set(Array.from(this.displayedLogs).slice(-50));
        }
        
        // Auto-scroll to bottom with smooth animation only if user hasn't scrolled up
        const isScrolledToBottom = logsContainer.scrollTop + logsContainer.clientHeight >= logsContainer.scrollHeight - 10;
        
        if (isScrolledToBottom) {
            setTimeout(() => {
                logsContainer.scrollTo({
                    top: logsContainer.scrollHeight,
                    behavior: 'smooth'
                });
            }, 100);
        }
    }
    
    displayResults(results) {
        const { summary, issues } = results;
        
        // Animate counters
        this.animateCounter('totalPages', summary.totalPages);
        this.animateCounter('brokenLinks', summary.brokenLinksCount);
        this.animateCounter('brokenButtons', summary.brokenButtonsCount);
        this.animateCounter('authIssues', summary.authIssuesCount);
        
        // Create chart with animation
        setTimeout(() => this.createChart(summary), 500);
        
        // Display issues with staggered animations
        setTimeout(() => this.displayBrokenLinks(issues.brokenLinks), 600);
        setTimeout(() => this.displayBrokenButtons(issues.brokenButtons), 700);
        setTimeout(() => this.displayAuthIssues(issues.authErrors), 800);
        
        // Store results for download
        this.currentResults = results;
        
        // Show results section with animation
        document.getElementById('resultsSection').classList.remove('hidden');
    }
    
    animateCounter(elementId, targetValue) {
        const element = document.getElementById(elementId);
        const startValue = 0;
        const duration = 1000;
        const startTime = performance.now();
        
        const animate = (currentTime) => {
            const elapsedTime = currentTime - startTime;
            const progress = Math.min(elapsedTime / duration, 1);
            
            const currentValue = Math.floor(startValue + (targetValue - startValue) * this.easeOutCubic(progress));
            element.textContent = currentValue;
            
            if (progress < 1) {
                requestAnimationFrame(animate);
            }
        };
        
        requestAnimationFrame(animate);
    }
    
    easeOutCubic(t) {
        return 1 - Math.pow(1 - t, 3);
    }
    
    createChart(summary) {
        const ctx = document.getElementById('issuesChart').getContext('2d');
        
        new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: ['Working Links', 'Broken Links', 'Working Buttons', 'Broken Buttons', 'Auth Issues'],
                datasets: [{
                    data: [
                        summary.totalLinks - summary.brokenLinksCount,
                        summary.brokenLinksCount,
                        summary.totalButtons - summary.brokenButtonsCount,
                        summary.brokenButtonsCount,
                        summary.authIssuesCount
                    ],
                    backgroundColor: [
                        '#10B981', // green
                        '#EF4444', // red
                        '#3B82F6', // blue
                        '#F59E0B', // yellow
                        '#8B5CF6'  // purple
                    ],
                    borderWidth: 0,
                    hoverOffset: 10
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        position: 'bottom',
                        labels: {
                            color: '#ffffff',
                            padding: 20,
                            usePointStyle: true,
                            font: {
                                size: 14
                            }
                        }
                    }
                },
                animation: {
                    animateRotate: true,
                    duration: 2000
                }
            }
        });
    }
    
    displayBrokenLinks(brokenLinks) {
        const container = document.getElementById('brokenLinksList');
        
        if (brokenLinks.length === 0) {
            container.innerHTML = `
                <div class="text-center py-8">
                    <i class="fas fa-check-circle text-6xl text-green-400 mb-4"></i>
                    <p class="text-xl text-green-400 font-semibold">No broken links found!</p>
                    <p class="text-gray-400">All links are working properly.</p>
                </div>
            `;
            return;
        }
        
        container.innerHTML = brokenLinks.slice(0, 10).map((link, index) => `
            <div class="bg-red-500/10 border border-red-500/20 rounded-xl p-4 hover:bg-red-500/20 transition-all duration-300" style="animation-delay: ${index * 100}ms;">
                <div class="flex items-start gap-3">
                    <i class="fas fa-unlink text-red-400 mt-1"></i>
                    <div class="flex-1 min-w-0">
                        <p class="font-medium text-red-300 break-all">${link.link}</p>
                        <p class="text-sm text-gray-400 mt-1">
                            <i class="fas fa-exclamation-triangle text-yellow-400 mr-1"></i>
                            Status: ${link.status} • Found on: ${link.page}
                        </p>
                    </div>
                </div>
            </div>
        `).join('');
        
        if (brokenLinks.length > 10) {
            container.innerHTML += `
                <div class="text-center py-4">
                    <p class="text-gray-400">... and ${brokenLinks.length - 10} more broken links</p>
                </div>
            `;
        }
    }
    
     displayBrokenButtons(brokenButtons) {
        const container = document.getElementById('brokenButtonsList');
        
        if (brokenButtons.length === 0) {
            container.innerHTML = `
                <div class="text-center py-8">
                    <i class="fas fa-check-circle text-6xl text-green-400 mb-4"></i>
                    <p class="text-xl text-green-400 font-semibold">No broken buttons found!</p>
                    <p class="text-gray-400">All buttons are functioning correctly.</p>
                </div>
        `;
           return;
       }
       
       container.innerHTML = brokenButtons.slice(0, 10).map((btn, index) => `
           <div class="bg-orange-500/10 border border-orange-500/20 rounded-xl p-4 hover:bg-orange-500/20 transition-all duration-300" style="animation-delay: ${index * 100}ms;">
               <div class="flex items-start gap-3">
                   <i class="fas fa-exclamation-triangle text-orange-400 mt-1"></i>
                   <div class="flex-1 min-w-0">
                       <p class="font-medium text-orange-300">"${btn.button}"</p>
                       <p class="text-sm text-gray-400 mt-1">
                           <i class="fas fa-map-marker-alt text-blue-400 mr-1"></i>
                           Page: ${btn.page}
                       </p>
                       <p class="text-sm text-red-400 mt-1">
                           <i class="fas fa-bug text-red-400 mr-1"></i>
                           Error: ${btn.errors[0]}
                       </p>
                   </div>
               </div>
           </div>
       `).join('');
       
       if (brokenButtons.length > 10) {
           container.innerHTML += `
               <div class="text-center py-4">
                   <p class="text-gray-400">... and ${brokenButtons.length - 10} more broken buttons</p>
               </div>
           `;
       }
   }
    
   displayAuthIssues(authErrors) {
       const container = document.getElementById('authIssuesList');
       
       if (authErrors.length === 0) {
           container.innerHTML = `
               <div class="text-center py-8">
                   <i class="fas fa-shield-check text-6xl text-green-400 mb-4"></i>
                   <p class="text-xl text-green-400 font-semibold">No authentication issues found!</p>
                   <p class="text-gray-400">All authentication flows are working properly.</p>
               </div>
           `;
           return;
       }
       
       // Group by page
       const groupedByPage = {};
       authErrors.forEach(auth => {
           if (!groupedByPage[auth.page]) {
               groupedByPage[auth.page] = [];
           }
           groupedByPage[auth.page].push(auth);
       });
       
       container.innerHTML = Object.entries(groupedByPage).slice(0, 5).map(([page, auths], index) => `
           <div class="bg-yellow-500/10 border border-yellow-500/20 rounded-xl p-4 hover:bg-yellow-500/20 transition-all duration-300" style="animation-delay: ${index * 100}ms;">
               <div class="flex items-start gap-3">
                   <i class="fas fa-key text-yellow-400 mt-1"></i>
                   <div class="flex-1 min-w-0">
                       <p class="font-medium text-yellow-300 break-all">${page}</p>
                       <p class="text-sm text-gray-400 mt-1">
                           <i class="fas fa-users text-blue-400 mr-1"></i>
                           ${auths.length} buttons with authentication issues
                       </p>
                       <div class="mt-2 p-3 bg-yellow-500/10 rounded-lg">
                           <p class="text-sm text-yellow-300">
                               <i class="fas fa-lightbulb text-yellow-400 mr-1"></i>
                               <strong>Recommendation:</strong> Implement graceful auth error handling and redirect users to login page
                           </p>
                       </div>
                   </div>
               </div>
           </div>
       `).join('');
   }
   
   downloadReport() {
       if (!this.currentResults) {
           this.showNotification('No report available to download', 'error');
           return;
       }
       
       // Add timestamp and metadata to report
       const enhancedReport = {
           ...this.currentResults,
           metadata: {
               generatedAt: new Date().toISOString(),
               tool: 'WebScan Pro',
               version: '1.0.0'
           }
       };
       
       const dataStr = JSON.stringify(enhancedReport, null, 2);
       const dataBlob = new Blob([dataStr], { type: 'application/json' });
       
       const link = document.createElement('a');
       link.href = URL.createObjectURL(dataBlob);
       link.download = `webscan-pro-report-${new Date().toISOString().split('T')[0]}.json`;
       link.click();
       
       this.showNotification('Report downloaded successfully!', 'success');
   }
}

// Initialize the application
document.addEventListener('DOMContentLoaded', () => {
   new WebsiteTester();
});