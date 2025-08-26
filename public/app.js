class WebsiteTester {
    constructor() {
        this.currentScanId = null;
        this.pollInterval = null;
        this.currentResults = null;
        this.displayedLogs = new Set();
        this.initEventListeners();
        this.addEntranceAnimations();
        this.initTabs();
    }
    
    addEntranceAnimations() {
        const animatedElements = document.querySelectorAll('.animate-slide-up');
        animatedElements.forEach((el, index) => {
            el.style.animationDelay = `${index * 0.1}s`;
        });
    }
    
    initTabs() {
        const tabButtons = document.querySelectorAll('.tab-button');
        tabButtons.forEach(button => {
            button.addEventListener('click', () => {
                const tabName = button.getAttribute('data-tab');
                this.switchTab(tabName);
            });
        });
    }
    
    switchTab(tabName) {
        // Update active button
        document.querySelectorAll('.tab-button').forEach(btn => {
            btn.classList.remove('active', 'bg-blue-500/20', 'text-blue-400', 'border-blue-500/30');
            btn.classList.add('bg-white/5', 'text-gray-400', 'border-white/10');
        });
        
        const activeButton = document.querySelector(`[data-tab="${tabName}"]`);
        activeButton.classList.remove('bg-white/5', 'text-gray-400', 'border-white/10');
        activeButton.classList.add('active', 'bg-blue-500/20', 'text-blue-400', 'border-blue-500/30');
        
        // Show corresponding content
        document.querySelectorAll('.tab-content').forEach(content => {
            content.classList.add('hidden');
        });
        
        document.getElementById(`${tabName}Tab`).classList.remove('hidden');
    }
    
    initEventListeners() {
        document.getElementById('startScan').addEventListener('click', () => this.startScan());
        document.getElementById('websiteUrl').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.startScan();
        });
        document.getElementById('downloadReport').addEventListener('click', () => this.downloadReport());
        document.getElementById('downloadCSV').addEventListener('click', () => this.downloadCSV());
        
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
        
        // Reset displayed logs for new scan
        this.displayedLogs = new Set();
        
        try {
            console.log('Starting scan for:', url);
            
            // Keep your original fetch - just add better error handling
            const response = await fetch('/api/scan', {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                body: JSON.stringify({ 
                    url, 
                    scanId: this.currentScanId,
                    options: {
                        testDepth: 'deep',
                        maxPages: 100,
                        maxLinks: 50,
                        includeButtons: true,
                        includeForms: true,
                        includeResources: true,
                        includePerformance: true,
                        includeSEO: true
                    }
                })
            });
            
            if (!response.ok) {
                const errorText = await response.text();
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
                if (document.body.contains(notification)) {
                    document.body.removeChild(notification);
                }
            }, 500);
        }, 4000);
    }
    
    async pollForResults() {
        this.pollInterval = setInterval(async () => {
            try {
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
                        `<i class="fas fa-circle-notch animate-spin text-blue-400"></i> Deep scanning: pages, links, buttons, forms, performance, SEO... ${Math.round(scan.progress)}% complete`;
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
        
        // Show last 25 logs
        const recentLogs = logs.slice(-25);
        
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
            
            // Remove old logs if we have too many
            const allLogs = logsContainer.children;
            if (allLogs.length > 30) {
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
        if (this.displayedLogs.size > 150) {
            this.displayedLogs = new Set(Array.from(this.displayedLogs).slice(-75));
        }
        
        // Auto-scroll to bottom
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
        
        // Animate all counters
        this.animateCounter('totalPages', summary.totalPages);
        this.animateCounter('brokenLinks', summary.brokenLinksCount);
        this.animateCounter('brokenButtons', summary.brokenButtonsCount);
        this.animateCounter('seoIssues', summary.seoIssuesCount || 0);
        this.animateCounter('performanceIssues', summary.performanceIssuesCount || 0);
        this.animateCounter('formsTested', summary.formsTestedCount || 0);
        this.animateCounter('resourcesTested', summary.resourcesTestedCount || 0);
        
        // Calculate total issues
        const totalIssues = summary.brokenLinksCount + summary.brokenButtonsCount + 
                           summary.authIssuesCount + (summary.seoIssuesCount || 0) + 
                           (summary.performanceIssuesCount || 0);
        this.animateCounter('totalIssues', totalIssues);
        
        // Display performance metrics
        if (summary.averagePageSize) {
            document.getElementById('avgPageSize').textContent = summary.averagePageSize + 'KB';
        }
        if (summary.averageFCP) {
            document.getElementById('avgFCP').textContent = summary.averageFCP + 'ms';
        }
        
        // Create charts
        setTimeout(() => this.createIssuesChart(summary), 500);
        setTimeout(() => this.createPerformanceChart(issues.performanceData || []), 600);
        
        // Display detailed results in tabs
        this.displayBrokenLinks(issues.brokenLinks);
        this.displayBrokenButtons(issues.brokenButtons);
        this.displaySEOIssues(issues.seoIssues || []);
        this.displayPerformanceData(issues.performanceData || []);
        this.displayFormsData(issues.workingLinks?.filter(l => l.type === 'form') || []);
        this.displayResourcesData(issues.missingResources || []);
        
        // Store results for download
        this.currentResults = results;
        
        // Show results section
        document.getElementById('resultsSection').classList.remove('hidden');
    }
    
    animateCounter(elementId, targetValue) {
        const element = document.getElementById(elementId);
        if (!element) return;
        
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
    
    createIssuesChart(summary) {
        const ctx = document.getElementById('issuesChart').getContext('2d');
        
        new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: [
                    'Working Links', 'Broken Links', 'Working Buttons', 'Broken Buttons', 
                    'SEO Issues', 'Performance Issues', 'Auth Issues'
                ],
                datasets: [{
                    data: [
                        summary.totalLinks - summary.brokenLinksCount,
                        summary.brokenLinksCount,
                        summary.totalButtons - summary.brokenButtonsCount,
                        summary.brokenButtonsCount,
                        summary.seoIssuesCount || 0,
                        summary.performanceIssuesCount || 0,
                        summary.authIssuesCount
                    ],
                    backgroundColor: [
                        '#10B981', '#EF4444', '#3B82F6', '#F59E0B', 
                        '#8B5CF6', '#F97316', '#EC4899'
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
                            padding: 15,
                            usePointStyle: true,
                            font: { size: 12 }
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
    
    createPerformanceChart(performanceData) {
        if (!performanceData || performanceData.length === 0) return;
        
        const ctx = document.getElementById('performanceChart').getContext('2d');
        
        const chartData = performanceData.map((data, index) => ({
            x: index + 1,
            y: data.firstContentfulPaint || 0,
            pageSize: data.pageSize || 0,
            page: data.page
        }));
        
        new Chart(ctx, {
            type: 'scatter',
            data: {
                datasets: [{
                    label: 'First Contentful Paint (ms)',
                    data: chartData,
                    backgroundColor: function(context) {
                        const value = context.parsed.y;
                        if (value > 3000) return '#EF4444';
                        if (value > 1500) return '#F59E0B';
                        return '#10B981';
                    },
                    borderColor: '#ffffff',
                    borderWidth: 1,
                    pointRadius: 6
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { labels: { color: '#ffffff' } },
                    tooltip: {
                        callbacks: {
                            title: function(context) {
                                const point = chartData[context[0].dataIndex];
                                return point.page;
                            },
                            label: function(context) {
                                const point = chartData[context.dataIndex];
                                return [
                                    `FCP: ${point.y}ms`,
                                    `Page Size: ${point.pageSize}KB`
                                ];
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        title: { display: true, text: 'Page Number', color: '#ffffff' },
                        ticks: { color: '#ffffff' },
                        grid: { color: 'rgba(255, 255, 255, 0.1)' }
                    },
                    y: {
                        title: { display: true, text: 'First Contentful Paint (ms)', color: '#ffffff' },
                        ticks: { color: '#ffffff' },
                        grid: { color: 'rgba(255, 255, 255, 0.1)' }
                    }
                }
            }
        });
    }
    
    displayBrokenLinks(brokenLinks) {
        const container = document.getElementById('brokenLinksList');
        
        if (!brokenLinks || brokenLinks.length === 0) {
            container.innerHTML = `
                <div class="text-center py-8">
                    <i class="fas fa-check-circle text-6xl text-green-400 mb-4"></i>
                    <p class="text-xl text-green-400 font-semibold">No broken links found!</p>
                    <p class="text-gray-400">All links are working properly.</p>
                </div>
            `;
            return;
        }
        
        container.innerHTML = brokenLinks.slice(0, 20).map((link, index) => `
            <div class="bg-red-500/10 border border-red-500/20 rounded-xl p-4 hover:bg-red-500/20 transition-all duration-300">
                <div class="flex items-start gap-3">
                    <i class="fas fa-unlink text-red-400 mt-1"></i>
                    <div class="flex-1 min-w-0">
                        <p class="font-medium text-red-300 break-all">${link.link}</p>
                        <p class="text-sm text-gray-400 mt-1">
                            <i class="fas fa-exclamation-triangle text-yellow-400 mr-1"></i>
                            Status: ${link.status} ${link.type ? `• Type: ${link.type}` : ''} • Found on: ${link.page}
                        </p>
                        ${link.error ? `<p class="text-xs text-red-400 mt-1">Error: ${link.error}</p>` : ''}
                    </div>
                </div>
            </div>
        `).join('');
    }
    
    displayBrokenButtons(brokenButtons) {
        const container = document.getElementById('brokenButtonsList');
        
        if (!brokenButtons || brokenButtons.length === 0) {
            container.innerHTML = `
                <div class="text-center py-8">
                    <i class="fas fa-check-circle text-6xl text-green-400 mb-4"></i>
                    <p class="text-xl text-green-400 font-semibold">No broken buttons found!</p>
                    <p class="text-gray-400">All interactive elements are functioning correctly.</p>
                </div>
            `;
            return;
        }
        
        container.innerHTML = brokenButtons.slice(0, 15).map((btn, index) => `
            <div class="bg-orange-500/10 border border-orange-500/20 rounded-xl p-4 hover:bg-orange-500/20 transition-all duration-300">
                <div class="flex items-start gap-3">
                    <i class="fas fa-exclamation-triangle text-orange-400 mt-1"></i>
                    <div class="flex-1 min-w-0">
                        <p class="font-medium text-orange-300">"${btn.button}"</p>
                        <p class="text-sm text-gray-400 mt-1">Page: ${btn.page}</p>
                        <p class="text-sm text-red-400 mt-1">Error: ${Array.isArray(btn.errors) ? btn.errors[0] : btn.errors}</p>
                    </div>
                </div>
            </div>
        `).join('');
    }
    
    displaySEOIssues(seoIssues) {
        const container = document.getElementById('seoIssuesList');
        
        if (!seoIssues || seoIssues.length === 0) {
            container.innerHTML = `
                <div class="text-center py-8">
                    <i class="fas fa-trophy text-6xl text-green-400 mb-4"></i>
                    <p class="text-xl text-green-400 font-semibold">Excellent SEO!</p>
                    <p class="text-gray-400">No major SEO issues found across scanned pages.</p>
                </div>
            `;
            return;
        }
        
        container.innerHTML = seoIssues.slice(0, 15).map((seo, index) => `
            <div class="bg-green-500/10 border border-green-500/20 rounded-xl p-4 hover:bg-green-500/20 transition-all duration-300">
                <div class="flex items-start gap-3">
                    <i class="fas fa-search text-green-400 mt-1"></i>
                    <div class="flex-1 min-w-0">
                        <p class="font-medium text-green-300 break-all">${seo.page}</p>
                        <div class="mt-2 space-y-1">
                            ${seo.issues.map(issue => `
                                <p class="text-sm text-yellow-400 flex items-center gap-2">
                                    <i class="fas fa-exclamation-triangle text-xs"></i>
                                    ${issue}
                                </p>
                            `).join('')}
                        </div>
                    </div>
                </div>
            </div>
        `).join('');
    }
    
    displayPerformanceData(performanceData) {
        const container = document.getElementById('performanceList');
        
        if (!performanceData || performanceData.length === 0) {
            container.innerHTML = `
                <div class="text-center py-8">
                    <i class="fas fa-clock text-6xl text-gray-400 mb-4"></i>
                    <p class="text-xl text-gray-400 font-semibold">No performance data</p>
                    <p class="text-gray-500">Performance monitoring was not enabled for this scan.</p>
                </div>
            `;
            return;
        }
        
        const sortedData = performanceData.sort((a, b) => (b.firstContentfulPaint || 0) - (a.firstContentfulPaint || 0));
        
        container.innerHTML = sortedData.slice(0, 15).map((perf, index) => {
            const fcp = perf.firstContentfulPaint || 0;
            const isSlowLoading = fcp > 3000;
            
            return `
                <div class="bg-yellow-500/10 border border-yellow-500/20 rounded-xl p-4 hover:bg-yellow-500/20 transition-all duration-300">
                    <div class="flex items-start gap-3">
                        <i class="fas fa-tachometer-alt text-yellow-400 mt-1"></i>
                        <div class="flex-1 min-w-0">
                            <p class="font-medium text-yellow-300 break-all">${perf.page}</p>
                            <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mt-3 text-sm">
                                <div class="bg-black/20 rounded-lg p-2">
                                    <p class="text-gray-400 text-xs">First Paint</p>
                                    <p class="text-white font-semibold ${isSlowLoading ? 'text-red-400' : 'text-green-400'}">${Math.round(fcp)}ms</p>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            `;
        }).join('');
    }
    
    displayFormsData(formsData) {
        const container = document.getElementById('formsList');
        
        if (!formsData || formsData.length === 0) {
            container.innerHTML = `
                <div class="text-center py-8">
                    <i class="fas fa-file-text text-6xl text-gray-400 mb-4"></i>
                    <p class="text-xl text-gray-400 font-semibold">No forms detected</p>
                    <p class="text-gray-500">No forms were found during the scan.</p>
                </div>
            `;
            return;
        }
        
        container.innerHTML = formsData.slice(0, 10).map((form, index) => `
            <div class="bg-blue-500/10 border border-blue-500/20 rounded-xl p-4 hover:bg-blue-500/20 transition-all duration-300">
                <div class="flex items-start gap-3">
                    <i class="fas fa-file-text text-blue-400 mt-1"></i>
                    <div class="flex-1 min-w-0">
                        <p class="font-medium text-blue-300 break-all">${form.link}</p>
                        <p class="text-sm text-gray-400 mt-1">Found on: ${form.page}</p>
                    </div>
                </div>
            </div>
        `).join('');
    }
    
    displayResourcesData(resourcesData) {
        const container = document.getElementById('resourcesList');
        
        if (!resourcesData || resourcesData.length === 0) {
            container.innerHTML = `
                <div class="text-center py-8">
                    <i class="fas fa-check-circle text-6xl text-green-400 mb-4"></i>
                    <p class="text-xl text-green-400 font-semibold">All resources loading correctly!</p>
                    <p class="text-gray-400">No missing CSS, JavaScript, or image resources found.</p>
                </div>
            `;
            return;
        }
        
        container.innerHTML = resourcesData.slice(0, 10).map((resource, index) => `
            <div class="bg-indigo-500/10 border border-indigo-500/20 rounded-lg p-3 hover:bg-indigo-500/20 transition-all duration-300">
                <div class="flex items-start gap-3">
                    <i class="fas fa-times-circle text-red-400 mt-1"></i>
                    <div class="flex-1 min-w-0">
                        <p class="font-medium text-indigo-300 break-all text-sm">${resource.resource}</p>
                        <p class="text-xs text-gray-400 mt-1">Status: ${resource.status} • Found on: ${resource.page}</p>
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
        
        const enhancedReport = {
            ...this.currentResults,
            metadata: {
                generatedAt: new Date().toISOString(),
                tool: 'WebScan - Pro Edition',
                version: '2.0.0',
                scanType: 'deep'
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
    
    downloadCSV() {
        if (!this.currentResults) {
            this.showNotification('No data available to export', 'error');
            return;
        }
        
        const { summary, issues } = this.currentResults;
        
        // Create CSV summary
        let csvContent = "data:text/csv;charset=utf-8,";
        
        // Summary section
        csvContent += "SCAN SUMMARY\n";
        csvContent += "Metric,Value\n";
        csvContent += `Total Pages Scanned,${summary.totalPages}\n`;
        csvContent += `Total Links Tested,${summary.totalLinks}\n`;
        csvContent += `Broken Links,${summary.brokenLinksCount}\n`;
        csvContent += `Total Buttons Tested,${summary.totalButtons}\n`;
        csvContent += `Broken Buttons,${summary.brokenButtonsCount}\n`;
        csvContent += `SEO Issues,${summary.seoIssuesCount || 0}\n`;
        csvContent += `Performance Issues,${summary.performanceIssuesCount || 0}\n`;
        csvContent += `Forms Tested,${summary.formsTestedCount || 0}\n`;
        csvContent += `Resources Tested,${summary.resourcesTestedCount || 0}\n`;
        csvContent += `Average Page Size (KB),${summary.averagePageSize || 0}\n`;
        csvContent += `Average First Contentful Paint (ms),${summary.averageFCP || 0}\n`;
        csvContent += "\n";
        
        // Broken links section
        if (issues.brokenLinks && issues.brokenLinks.length > 0) {
            csvContent += "BROKEN LINKS DETAILS\n";
            csvContent += "Page,Link,Status,Error,Type\n";
            issues.brokenLinks.forEach(link => {
                csvContent += `"${link.page}","${link.link}","${link.status}","${link.error || ''}","${link.type || 'link'}"\n`;
            });
            csvContent += "\n";
        }
        
        // Performance data section
        if (issues.performanceData && issues.performanceData.length > 0) {
            csvContent += "PERFORMANCE DATA\n";
            csvContent += "Page,First Contentful Paint (ms),DOM Elements,Page Size (KB),Total Images\n";
            issues.performanceData.forEach(perf => {
                csvContent += `"${perf.page}","${perf.firstContentfulPaint || 0}","${perf.totalElements || 0}","${perf.pageSize || 0}","${perf.totalImages || 0}"\n`;
            });
            csvContent += "\n";
        }
        
        // SEO issues section
        if (issues.seoIssues && issues.seoIssues.length > 0) {
            csvContent += "SEO ISSUES\n";
            csvContent += "Page,Issues\n";
            issues.seoIssues.forEach(seo => {
                csvContent += `"${seo.page}","${seo.issues.join('; ')}"\n`;
            });
        }
        
        const encodedUri = encodeURI(csvContent);
        const link = document.createElement('a');
        link.setAttribute('href', encodedUri);
        link.setAttribute('download', `webscan-pro-summary-${new Date().toISOString().split('T')[0]}.csv`);
        link.click();
        
        this.showNotification('CSV summary downloaded successfully!', 'success');
    }
}

// Initialize the application - FIX: Use correct class name
document.addEventListener('DOMContentLoaded', () => {
    new WebsiteTester(); // Changed from ComprehensiveWebsiteTester
});