class WebsiteTester {
    constructor() {
        this.currentScanId = null;
        this.pollInterval = null;
        this.currentResults = null;
        this.displayedLogs = new Set();
        this.user = null;
        this.checkAuthentication();
        this.checkPaymentStatus();
        this.initEventListeners();
        this.addEntranceAnimations();
        this.initTabs();
        this.initScanDepthSelector();
    }

    async checkAuthentication() {
        try {
            // Check if we have a token in localStorage
            const token = localStorage.getItem('webscan_token');
            if (!token) {
                this.redirectToLanding();
                return;
            }

            // Verify token with server
            const response = await fetch('/api/auth/verify-token', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                }
            });

            if (!response.ok) {
                // Token is invalid, redirect to landing
                localStorage.removeItem('webscan_token');
                this.redirectToLanding();
                return;
            }

            const data = await response.json();
            this.user = data.user;
            this.updateUserInterface();

        } catch (error) {
            console.error('Authentication check failed:', error);
            this.redirectToLanding();
        }
    }

    redirectToLanding() {
        window.location.href = '/';
    }

    disconnectWallet() {
        // Remove token from localStorage
        localStorage.removeItem('webscan_token');

        // Clear user data
        this.user = null;

        // Show notification
        this.showNotification('Wallet disconnected successfully', 'info');

        // Immediately redirect to landing page (remove delay)
        this.redirectToLanding();
    }

    checkPaymentStatus() {
        const urlParams = new URLSearchParams(window.location.search);

        if (urlParams.get('payment') === 'success') {
            // Clear the URL parameter
            const newUrl = window.location.pathname;
            window.history.replaceState({}, document.title, newUrl);

            // Show success message
            setTimeout(() => {
                this.showNotification('🎉 Payment successful! Welcome to WebScan Pro!', 'success');
            }, 1000);

            // Refresh user data to get updated subscription
            setTimeout(() => {
                this.checkAuthentication();
            }, 2000);

        } else if (urlParams.get('payment') === 'cancelled') {
            // Clear the URL parameter
            const newUrl = window.location.pathname;
            window.history.replaceState({}, document.title, newUrl);

            // Show cancellation message
            setTimeout(() => {
                this.showNotification('Payment was cancelled. You can try again anytime.', 'info');
            }, 1000);

            // Refresh user data to ensure correct subscription status
            setTimeout(() => {
                this.checkAuthentication();
            }, 1000);
        }
    }

    updateUserInterface() {
        if (!this.user) return;

        try {
            // Update user info display
            const userInfo = document.getElementById('userInfo');
            if (userInfo) {
                userInfo.innerHTML = `
                    <div class="flex items-center gap-3">
                        <div class="w-8 h-8 bg-gradient-to-r from-blue-500 to-purple-500 rounded-full flex items-center justify-center">
                            <i class="fas fa-user text-white text-sm"></i>
                        </div>
                        <div>
                            <p class="text-sm font-medium text-white">${this.user.subscriptionTier.charAt(0).toUpperCase() + this.user.subscriptionTier.slice(1)} Plan</p>
                            <p class="text-xs text-gray-400">${this.user.scansUsedThisMonth}/${this.user.monthlyScanLimit} scans used</p>
                        </div>
                        <button id="disconnectWalletBtn" class="ml-2 px-3 py-1 bg-red-500/20 hover:bg-red-500/30 text-red-300 rounded-lg transition-colors text-xs" title="Disconnect Wallet">
                            <i class="fas fa-sign-out-alt"></i>
                        </button>
                    </div>
                `;

                // Add disconnect button event listener
                const disconnectBtn = document.getElementById('disconnectWalletBtn');
                if (disconnectBtn) {
                    disconnectBtn.addEventListener('click', () => this.disconnectWallet());
                }
            }

            // Update scan limits display with enhanced interactive counter
            const scanLimits = document.getElementById('scanLimits');
            if (scanLimits) {
                const remaining = this.user.monthlyScanLimit - this.user.scansUsedThisMonth;
                const usagePercentage = (this.user.scansUsedThisMonth / this.user.monthlyScanLimit) * 100;
                
                // Determine color based on usage percentage
                let progressBarColor = 'from-blue-500 to-purple-500';
                let counterColor = 'text-white';
                
                if (usagePercentage >= 90) {
                    progressBarColor = 'from-red-500 to-orange-500';
                    counterColor = 'text-red-400';
                } else if (usagePercentage >= 75) {
                    progressBarColor = 'from-orange-500 to-yellow-500';
                    counterColor = 'text-orange-400';
                } else if (usagePercentage >= 50) {
                    progressBarColor = 'from-yellow-500 to-green-500';
                    counterColor = 'text-yellow-400';
                }

                scanLimits.innerHTML = `
                    <div class="text-center">
                        <div class="relative">
                            <p class="text-3xl font-bold ${counterColor} mb-1 scan-counter">${remaining}</p>
                            <div class="absolute -top-2 -right-2">
                                <i class="fas fa-sync-alt text-xs text-gray-400 animate-spin"></i>
                            </div>
                        <p class="text-sm text-gray-400 mb-2">scans remaining</p>
                        <div class="w-full bg-gray-700 rounded-full h-3 mt-2 relative group">
                            <div class="bg-gradient-to-r ${progressBarColor} h-3 rounded-full transition-all duration-500 ease-out"
                                 style="width: ${usagePercentage}%"
                                 data-remaining="${remaining}"
                                 data-used="${this.user.scansUsedThisMonth}"
                                 data-limit="${this.user.monthlyScanLimit}">
                            </div>
                            <div class="absolute inset-0 bg-black/50 rounded-full opacity-0 group-hover:opacity-100 transition-opacity duration-200 flex items-center justify-center text-xs text-white font-medium">
                                ${Math.round(usagePercentage)}% used
                            </div>
                        <div class="mt-2 text-xs text-gray-500">
                            ${this.user.scansUsedThisMonth} of ${this.user.monthlyScanLimit} used
                        </div>
                    </div>
                `;

                // Add hover effect for scan counter
                const counterElement = scanLimits.querySelector('.scan-counter');
                if (counterElement) {
                    counterElement.addEventListener('mouseenter', () => {
                        counterElement.style.transform = 'scale(1.1)';
                        counterElement.style.transition = 'transform 0.2s ease';
                    });
                    counterElement.addEventListener('mouseleave', () => {
                        counterElement.style.transform = 'scale(1)';
                    });
                }

                // Check if user has reached scan limit and disable scan functionality
                this.checkScanLimit();
            }

            // Disable scan options based on subscription
            this.updateScanOptions();
        } catch (error) {
            console.error('Error updating user interface:', error);
            // Continue without breaking the page
        }
    }

    checkScanLimit() {
        const { scansUsedThisMonth, monthlyScanLimit } = this.user;
        
        // Check if user has reached their scan limit
        if (scansUsedThisMonth >= monthlyScanLimit) {
            // Disable scan button and show upgrade prompt
            const startScanBtn = document.getElementById('startScan');
            const scanButtonContainer = document.getElementById('scanButtonContainer');
            
            if (startScanBtn) {
                startScanBtn.disabled = true;
                startScanBtn.classList.add('opacity-50', 'cursor-not-allowed', 'bg-gray-500');
                startScanBtn.classList.remove('bg-gradient-to-r', 'from-blue-500', 'to-purple-500', 'hover:from-blue-600', 'hover:to-purple-600');
                
                // Change button text to indicate limit reached
                startScanBtn.innerHTML = `
                    <i class="fas fa-lock mr-2"></i>
                    Limit Reached - Upgrade Required
                `;
                
                // Add click handler to redirect to upgrade
                startScanBtn.onclick = () => {
                    this.showNotification('You have reached your monthly scan limit. Please upgrade to continue scanning.', 'info');
                    // You could redirect to upgrade page here
                };
            }

            // Also disable URL input
            const urlInput = document.getElementById('websiteUrl');
            if (urlInput) {
                urlInput.disabled = true;
                urlInput.classList.add('opacity-50', 'cursor-not-allowed');
            }

            // Show limit reached message
            const scanMessage = document.createElement('div');
            scanMessage.id = 'scanLimitMessage';
            scanMessage.className = 'mt-4 p-4 bg-red-500/20 border border-red-500/30 rounded-lg text-center';
            scanMessage.innerHTML = `
                <i class="fas fa-exclamation-triangle text-red-400 mr-2"></i>
                <span class="text-red-300">Monthly scan limit reached (${scansUsedThisMonth}/${monthlyScanLimit}). 
                <button onclick="location.reload()" class="text-blue-400 hover:text-blue-300 underline ml-1">Refresh</button> 
                or upgrade your plan.</span>
            `;
            
            const scanForm = document.querySelector('.scan-form');
            if (scanForm && !document.getElementById('scanLimitMessage')) {
                scanForm.appendChild(scanMessage);
            }

            this.showNotification('You have reached your monthly scan limit. Please upgrade your plan to continue.', 'warning');
        }
    }

    // Enhanced scan counter animation
    animateScanCounter() {
        const counterElement = document.querySelector('.scan-counter');
        if (!counterElement) return;

        const remaining = this.user.monthlyScanLimit - this.user.scansUsedThisMonth;
        const currentCount = parseInt(counterElement.textContent) || 0;

        if (currentCount !== remaining) {
            // Animate the counter change
            const duration = 1000;
            const startTime = performance.now();
            const startValue = currentCount;
            const targetValue = remaining;

            const animate = (currentTime) => {
                const elapsed = currentTime - startTime;
                const progress = Math.min(elapsed / duration, 1);
                const currentValue = Math.floor(startValue + (targetValue - startValue) * progress);

                counterElement.textContent = currentValue;

                if (progress < 1) {
                    requestAnimationFrame(animate);
                } else {
                    counterElement.textContent = targetValue;
                }
            };

            requestAnimationFrame(animate);
        }
    }

    updateScanOptions() {
        if (!this.user) return;

        const scanOptions = document.querySelectorAll('.scan-option');
        const subscriptionTier = this.user.subscriptionTier;

        scanOptions.forEach(option => {
            const depth = option.getAttribute('data-depth');
            const isDisabled = this.isScanDepthDisabled(depth, subscriptionTier);

            if (isDisabled) {
                option.classList.add('disabled');
                option.setAttribute('disabled', 'true');

                // Add upgrade prompt
                const card = option.querySelector('div');
                if (card && !card.querySelector('.upgrade-prompt')) {
                    const prompt = document.createElement('div');
                    prompt.className = 'upgrade-prompt';
                    prompt.innerHTML = `
                        <div class="upgrade-content">
                            <i class="fas fa-lock"></i>
                            <p>Upgrade Required</p>
                            <p>Available in Pro plan</p>
                        </div>
                    `;
                    card.style.position = 'relative';
                    card.appendChild(prompt);
                }
            } else {
                option.classList.remove('disabled');
                option.removeAttribute('disabled');

                // Remove upgrade prompt
                const prompt = option.querySelector('.upgrade-prompt');
                if (prompt) {
                    prompt.remove();
                }
            }
        });

        // Auto-select appropriate scan depth
        const availableDepths = ['fast', 'balanced', 'deep'].filter(depth =>
            !this.isScanDepthDisabled(depth, subscriptionTier)
        );

        if (availableDepths.length > 0) {
            const defaultDepth = availableDepths[availableDepths.length - 1]; // Select the most advanced available
            this.updateScanOptionStyles(defaultDepth);
            this.updateScanUI(defaultDepth);

            // Update radio button
            document.querySelectorAll('input[name="scanDepth"]').forEach(radio => {
                radio.checked = radio.value === defaultDepth;
            });
        }
    }

    isScanDepthDisabled(depth, tier) {
        // Treat 'trial' as 'free' for scan restrictions
        const effectiveTier = tier === 'trial' ? 'free' : tier;
        
        const restrictions = {
            free: ['balanced', 'deep'], // Free users can't use balanced or deep scans
            pro: [], // Pro users can use all depths
            enterprise: [], // Enterprise users can use all depths
            trial: ['balanced', 'deep'] // Trial users can't use balanced or deep scans
        };

        return restrictions[effectiveTier]?.includes(depth) || false;
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
    
    initScanDepthSelector() {
        const scanOptions = document.querySelectorAll('.scan-option');
        const scanButtonText = document.getElementById('scanButtonText');
        const scanDescription = document.getElementById('scanDescription');
        
        // Define scan configurations
        this.scanConfigs = {
            fast: {
                name: 'Fast Scan',
                description: 'Quick overview: basic link checking, minimal button testing, essential SEO checks',
                options: {
                    testDepth: 'fast',
                    maxPages: 25,
                    maxLinks: 10,
                    maxButtons: 2,
                    includeButtons: true,
                    includeForms: false,
                    includeResources: false,
                    includePerformance: false,
                    includeSEO: true,
                    timeoutPerPage: 5000,
                    buttonTimeout: 1000
                }
            },
            balanced: {
                name: 'Balanced Scan',
                description: 'Comprehensive analysis: links, buttons, forms, performance, SEO, and accessibility testing',
                options: {
                    testDepth: 'balanced',
                    maxPages: 75,
                    maxLinks: 25,
                    maxButtons: 5,
                    includeButtons: true,
                    includeForms: true,
                    includeResources: true,
                    includePerformance: true,
                    includeSEO: true,
                    timeoutPerPage: 8000,
                    buttonTimeout: 2000
                }
            },
            deep: {
                name: 'Deep Scan',
                description: 'Thorough enterprise analysis: comprehensive testing of all elements, detailed performance metrics, full accessibility audit',
                options: {
                    testDepth: 'deep',
                    maxPages: 150,
                    maxLinks: 50,
                    maxButtons: 10,
                    includeButtons: true,
                    includeForms: true,
                    includeResources: true,
                    includePerformance: true,
                    includeSEO: true,
                    timeoutPerPage: 12000,
                    buttonTimeout: 3000
                }
            }
        };
        
        // Set initial state based on default selection (balanced)
        this.updateScanUI('balanced');
        
        // Add click handlers for scan options
        scanOptions.forEach(option => {
            option.addEventListener('click', () => {
                const depth = option.getAttribute('data-depth');
                
                // Check if the option is disabled
                if (option.hasAttribute('disabled')) {
                    this.showNotification('This scan option requires a Pro subscription', 'info');
                    return;
                }
                
                // Update radio button selection
                document.querySelectorAll('input[name="scanDepth"]').forEach(radio => {
                    radio.checked = radio.value === depth;
                });
                
                // Update visual selection
                this.updateScanOptionStyles(depth);
                
                // Update scan button and description
                this.updateScanUI(depth);
            });
        });
        
        // Handle radio button changes directly (for accessibility)
        document.querySelectorAll('input[name="scanDepth"]').forEach(radio => {
            radio.addEventListener('change', () => {
                if (radio.checked) {
                    this.updateScanOptionStyles(radio.value);
                    this.updateScanUI(radio.value);
                }
            });
        });
    }
    
    updateScanOptionStyles(selectedDepth) {
        const scanOptions = document.querySelectorAll('.scan-option');
        
        scanOptions.forEach(option => {
            const depth = option.getAttribute('data-depth');
            const cardDiv = option.querySelector('div');
            
            if (depth === selectedDepth) {
                // Selected state
                cardDiv.classList.remove('border-green-500/30', 'border-blue-500/30', 'border-purple-500/30');
                cardDiv.classList.remove('ring-2', 'ring-blue-500/30');
                
                if (depth === 'fast') {
                    cardDiv.classList.add('border-green-500/70', 'ring-2', 'ring-green-500/50');
                } else if (depth === 'balanced') {
                    cardDiv.classList.add('border-blue-500/70', 'ring-2', 'ring-blue-500/50');
                } else if (depth === 'deep') {
                    cardDiv.classList.add('border-purple-500/70', 'ring-2', 'ring-purple-500/50');
                }
            } else {
                // Unselected state
                cardDiv.classList.remove('border-green-500/70', 'border-blue-500/70', 'border-purple-500/70');
                cardDiv.classList.remove('ring-2', 'ring-green-500/50', 'ring-blue-500/50', 'ring-purple-500/50');
                
                if (depth === 'fast') {
                    cardDiv.classList.add('border-green-500/30');
                } else if (depth === 'balanced') {
                    cardDiv.classList.add('border-blue-500/30');
                } else if (depth === 'deep') {
                    cardDiv.classList.add('border-purple-500/30');
                }
            }
        });
    }
    
    updateScanUI(depth) {
        const config = this.scanConfigs[depth];
        const scanButtonText = document.getElementById('scanButtonText');
        const scanDescription = document.getElementById('scanDescription');
        
        if (config) {
            scanButtonText.textContent = `Start ${config.name}`;
            scanDescription.innerHTML = `
                <i class="fas fa-info-circle"></i>
                <span>${config.description}</span>
            `;
        }
    }
    
    getSelectedScanDepth() {
        const checkedRadio = document.querySelector('input[name="scanDepth"]:checked');
        return checkedRadio ? checkedRadio.value : 'balanced';
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
        document.getElementById('stopScan').addEventListener('click', () => this.stopScan());
        document.getElementById('resumeScan').addEventListener('click', () => this.resumeScan());
        document.getElementById('websiteUrl').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.startScan();
        });
        document.getElementById('downloadReport').addEventListener('click', () => this.downloadReport());
        document.getElementById('downloadCSV').addEventListener('click', () => this.downloadCSV());
        
        // Section-specific download buttons
        const sectionButtons = document.querySelectorAll('.section-download-btn');
        sectionButtons.forEach(button => {
            button.addEventListener('click', (e) => {
                const section = e.currentTarget.getAttribute('data-section');
                this.downloadSectionReport(section);
            });
        });
        
        // Add input animation
        const urlInput = document.getElementById('websiteUrl');
        urlInput.addEventListener('focus', () => {
            urlInput.parentElement.classList.add('glow');
        });
        urlInput.addEventListener('blur', () => {
            urlInput.parentElement.classList.remove('glow');
        });
    }
    
    resetSectionProgress() {
        // Reset all progress indicators
        const sections = ['links', 'buttons', 'seo', 'performance', 'forms', 'resources'];
        
        sections.forEach(section => {
            // Reset progress indicators
            const progressElement = document.getElementById(`${section}Progress`);
            if (progressElement) {
                progressElement.textContent = '--';
                progressElement.classList.remove('text-green-400', 'text-blue-400');
            }
            
            // Reset download buttons
            const downloadButton = document.querySelector(`[data-section="${section}"]`);
            if (downloadButton) {
                downloadButton.disabled = true;
                downloadButton.classList.remove('completed');
                
                // Reset button text
                const title = downloadButton.querySelector('.section-title');
                if (title) {
                    title.textContent = section.charAt(0).toUpperCase() + section.slice(1);
                }
                
                // Hide spinner and badge
                const spinner = downloadButton.querySelector('.loading-spinner');
                if (spinner) {
                    spinner.classList.add('hidden');
                }
                
                const badge = downloadButton.querySelector('.completion-badge');
                if (badge) {
                    badge.classList.add('hidden');
                }
                
                // Reset icon wrapper
                const iconWrapper = downloadButton.querySelector('.icon-wrapper');
                if (iconWrapper) {
                    iconWrapper.style.opacity = '1';
                }
            }
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
        
        // Get selected scan depth and configuration
        const selectedDepth = this.getSelectedScanDepth();
        const scanConfig = this.scanConfigs[selectedDepth];
        
        this.showLoadingOverlay();
        this.currentScanId = 'scan_' + Date.now();
        
        // Reset displayed logs and section progress for new scan
        this.displayedLogs = new Set();
        this.resetSectionProgress();
        
        try {
            console.log('Starting scan for:', url);
            console.log('Scan depth:', selectedDepth);
            console.log('Scan configuration:', scanConfig.options);
            
            // Use the selected scan configuration
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
                        ...scanConfig.options,
                        // Add scan metadata
                        scanDepth: selectedDepth,
                        scanName: scanConfig.name
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
            
            // Show stop button and hide resume button
            document.getElementById('stopScan').classList.remove('hidden');
            document.getElementById('resumeScan').classList.add('hidden');
            
            // Start polling for results
            this.pollForResults();
            
        } catch (error) {
            console.error('Full error details:', error);
            this.hideLoadingOverlay();
            this.showNotification('Error starting scan: ' + error.message, 'error');
        }
    }

    async stopScan() {
        if (!this.currentScanId) {
            this.showNotification('No active scan to stop', 'error');
            return;
        }

        try {
            const response = await fetch('/api/scan/stop', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${localStorage.getItem('webscan_token')}`
                },
                body: JSON.stringify({ scanId: this.currentScanId })
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || 'Failed to stop scan');
            }

            const result = await response.json();
            this.showNotification('Scan paused successfully. Partial results available.', 'info');

            // Clear the polling interval
            if (this.pollInterval) {
                clearInterval(this.pollInterval);
                this.pollInterval = null;
            }

            // Show resume button and hide stop button
            document.getElementById('stopScan').classList.add('hidden');
            document.getElementById('resumeScan').classList.remove('hidden');

            // Update UI to show paused state
            document.getElementById('progressStatus').innerHTML = 
                `<i class="fas fa-pause text-yellow-400"></i> Scan paused. Results saved. Click "Resume Scan" to continue.`;

            // Get the current scan state to display partial results
            const scanResponse = await fetch(`/api/scan?scanId=${this.currentScanId}`, {
                headers: {
                    'Authorization': `Bearer ${localStorage.getItem('webscan_token')}`
                }
            });
            const scanData = await scanResponse.json();

            if (scanData.results) {
                document.getElementById('progressSection').classList.add('hidden');
                this.displayResults(scanData.results);
            }

        } catch (error) {
            this.showNotification('Error pausing scan: ' + error.message, 'error');
        }
    }

    async resumeScan() {
        if (!this.currentScanId) {
            this.showNotification('No scan to resume', 'error');
            return;
        }

        try {
            const response = await fetch('/api/scan/resume', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${localStorage.getItem('webscan_token')}`
                },
                body: JSON.stringify({ scanId: this.currentScanId })
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || 'Failed to resume scan');
            }

            const result = await response.json();
            this.showNotification('Scan resumed successfully', 'success');

            // Show stop button and hide resume button
            document.getElementById('stopScan').classList.remove('hidden');
            document.getElementById('resumeScan').classList.add('hidden');

            // Hide results section and show progress
            document.getElementById('resultsSection').classList.add('hidden');
            document.getElementById('progressSection').classList.remove('hidden');

            // Start polling for results again
            this.pollForResults();

        } catch (error) {
            this.showNotification('Error resuming scan: ' + error.message, 'error');
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
                const response = await fetch(`/api/scan?scanId=${this.currentScanId}`, {
                    headers: {
                        'Authorization': `Bearer ${localStorage.getItem('webscan_token')}`
                    }
                });
                const scan = await response.json();
                
                // Update progress with smooth animation
                const progressBar = document.getElementById('progressBar');
                const progressPercent = document.getElementById('progressPercent');
                
                progressPercent.textContent = Math.round(scan.progress) + '%';
                progressBar.style.width = scan.progress + '%';
                
                // Update real-time logs
                this.updateLogs(scan.logs || []);
                
                // Update section progress
                this.updateSectionProgress(scan.sectionProgress || {});
                
                if (scan.status === 'running') {
                    const selectedDepth = this.getSelectedScanDepth();
                    const config = this.scanConfigs[selectedDepth];
                    const scanName = config ? config.name : 'Scanning';
                    
                    document.getElementById('progressStatus').innerHTML = 
                        `<i class="fas fa-circle-notch animate-spin text-blue-400"></i> ${scanName} in progress: analyzing pages, links, and functionality... ${Math.round(scan.progress)}% complete`;
                } else if (scan.status === 'completed') {
                    clearInterval(this.pollInterval);
                    document.getElementById('progressSection').classList.add('hidden');
                    this.displayResults(scan.results);
                    this.showNotification('Scan completed successfully!', 'success');
                } else if (scan.status === 'error') {
                    clearInterval(this.pollInterval);
                    this.showNotification('Scan failed: ' + scan.error, 'error');
                    document.getElementById('progressSection').classList.add('hidden');
                } else if (scan.status === 'paused') {
                    clearInterval(this.pollInterval);
                    // Show paused state
                    document.getElementById('progressStatus').innerHTML = 
                        `<i class="fas fa-pause text-yellow-400"></i> Scan paused. Results saved. Click "Resume Scan" to continue.`;
                    // Show resume button and hide stop button
                    document.getElementById('stopScan').classList.add('hidden');
                    document.getElementById('resumeScan').classList.remove('hidden');
                }
                
            } catch (error) {
                clearInterval(this.pollInterval);
                this.showNotification('Error checking scan status: ' + error.message, 'error');
                document.getElementById('progressSection').classList.add('hidden');
            }
        }, 2000);
    }
    
    updateSectionProgress(sectionProgress) {
        // Update progress indicators in tab buttons
        let completedCount = 0;
        const totalSections = 6;
        
        Object.keys(sectionProgress).forEach(section => {
            const progress = sectionProgress[section];
            const progressElement = document.getElementById(`${section}Progress`);
            
            if (progress.completed) {
                completedCount++;
            }
            
            if (progressElement) {
                if (progress.completed) {
                    progressElement.textContent = '✅';
                    progressElement.classList.add('text-green-400');
                } else if (progress.status === 'running') {
                    progressElement.textContent = `${progress.progress}%`;
                    progressElement.classList.add('text-blue-400');
                } else {
                    progressElement.textContent = '--';
                }
            }
            
            // Enable download button when section is completed
            const downloadButton = document.querySelector(`[data-section="${section}"]`);
            if (downloadButton && progress.completed) {
                downloadButton.disabled = false;
                downloadButton.classList.add('completed');
                
                // Show completion badge
                const badge = downloadButton.querySelector('.completion-badge');
                if (badge) {
                    badge.classList.remove('hidden');
                }
                
                // Add completion animation
                setTimeout(() => {
                    downloadButton.classList.remove('completed');
                }, 2000);
            }
        });
        
        // Update completion counter
        const completedSectionsElement = document.getElementById('completedSections');
        if (completedSectionsElement) {
            completedSectionsElement.textContent = `${completedCount}/${totalSections} Ready`;
            
            if (completedCount === totalSections) {
                completedSectionsElement.classList.add('text-green-300');
                completedSectionsElement.classList.remove('text-green-400');
            }
        }
    }
    
    async downloadSectionReport(section) {
        if (!this.currentScanId) {
            this.showNotification('No scan data available', 'error');
            return;
        }
        
        const button = document.querySelector(`[data-section="${section}"]`);
        const spinner = button.querySelector('.loading-spinner');
        const title = button.querySelector('.section-title');
        const iconWrapper = button.querySelector('.icon-wrapper');
        
        try {
            // Show loading state
            spinner.classList.remove('hidden');
            title.textContent = 'Loading...';
            iconWrapper.style.opacity = '0.5';
            button.disabled = true;
            
            const response = await fetch(`/api/scan/${this.currentScanId}/section/${section}`);
            
            if (!response.ok) {
                throw new Error(`Failed to fetch ${section} report: ${response.statusText}`);
            }
            
            const sectionData = await response.json();
            
            // Create and download the report
            const dataStr = JSON.stringify(sectionData, null, 2);
            const dataBlob = new Blob([dataStr], { type: 'application/json' });
            
            const link = document.createElement('a');
            link.href = URL.createObjectURL(dataBlob);
            link.download = `${section}-report-${new Date().toISOString().split('T')[0]}.json`;
            link.click();
            
            this.showNotification(`${section.charAt(0).toUpperCase() + section.slice(1)} report downloaded!`, 'success');
            
        } catch (error) {
            console.error(`Error downloading ${section} report:`, error);
            this.showNotification(`Error downloading ${section} report: ${error.message}`, 'error');
        } finally {
            // Reset button state
            spinner.classList.add('hidden');
            title.textContent = section.charAt(0).toUpperCase() + section.slice(1);
            iconWrapper.style.opacity = '1';
            button.disabled = false;
        }
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
