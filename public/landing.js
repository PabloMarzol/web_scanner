// Landing page JavaScript for WebScan Pro
class LandingPage {
    constructor() {
        this.initEventListeners();
        this.initSmoothScrolling();
        this.initPricingScroll();
        this.checkWalletConnection();
    }

    initEventListeners() {
        // Connect wallet button
        const connectWalletBtn = document.getElementById('connectWallet');
        if (connectWalletBtn) {
            connectWalletBtn.addEventListener('click', () => this.showWalletModal());
        }

        // Get started buttons (both hero and pricing section)
        const getStartedHeroBtn = document.getElementById('getStartedHeroBtn');
        if (getStartedHeroBtn) {
            getStartedHeroBtn.addEventListener('click', () => this.handleGetStarted());
        }

        const getStartedPricingBtn = document.getElementById('getStartedBtn');
        if (getStartedPricingBtn) {
            getStartedPricingBtn.addEventListener('click', () => this.handleGetStarted());
        }

        // View pricing button
        const viewPricingBtn = document.getElementById('viewPricingBtn');
        if (viewPricingBtn) {
            viewPricingBtn.addEventListener('click', () => this.scrollToPricing());
        }

        // Subscribe buttons
        const subscribeProBtn = document.getElementById('subscribeProBtn');
        if (subscribeProBtn) {
            subscribeProBtn.addEventListener('click', () => this.handleSubscribe('pro'));
        }

        // Wallet modal buttons
        const closeWalletModalBtn = document.getElementById('closeWalletModal');
        if (closeWalletModalBtn) {
            closeWalletModalBtn.addEventListener('click', () => this.hideWalletModal());
        }

        const connectMetaMaskBtn = document.getElementById('connectMetaMask');
        if (connectMetaMaskBtn) {
            connectMetaMaskBtn.addEventListener('click', () => this.connectMetaMask());
        }

        const connectWalletConnectBtn = document.getElementById('connectWalletConnect');
        if (connectWalletConnectBtn) {
            connectWalletConnectBtn.addEventListener('click', () => this.connectWalletConnect());
        }

        const connectCoinbaseBtn = document.getElementById('connectCoinbase');
        if (connectCoinbaseBtn) {
            connectCoinbaseBtn.addEventListener('click', () => this.connectCoinbase());
        }

        // Close modal on outside click
        const walletModal = document.getElementById('walletModal');
        if (walletModal) {
            walletModal.addEventListener('click', (e) => {
                if (e.target === walletModal) {
                    this.hideWalletModal();
                }
            });
        }
    }

    initSmoothScrolling() {
        // Smooth scrolling for navigation links
        document.querySelectorAll('a[href^="#"]').forEach(anchor => {
            anchor.addEventListener('click', (e) => {
                e.preventDefault();
                const target = document.querySelector(anchor.getAttribute('href'));
                if (target) {
                    target.scrollIntoView({
                        behavior: 'smooth',
                        block: 'start'
                    });
                }
            });
        });
    }

    initPricingScroll() {
        // Auto-scroll to pricing when "View Pricing" is clicked
        const viewPricingBtn = document.getElementById('viewPricingBtn');
        if (viewPricingBtn) {
            viewPricingBtn.addEventListener('click', () => {
                const pricingSection = document.getElementById('pricing');
                if (pricingSection) {
                    pricingSection.scrollIntoView({
                        behavior: 'smooth',
                        block: 'start'
                    });
                }
            });
        }
    }

    showWalletModal() {
        const modal = document.getElementById('walletModal');
        if (modal) {
            modal.classList.remove('hidden');
            document.body.style.overflow = 'hidden';
        }
    }

    hideWalletModal() {
        const modal = document.getElementById('walletModal');
        if (modal) {
            modal.classList.add('hidden');
            document.body.style.overflow = 'auto';
        }
    }

    handleGetStarted() {
        // Check if user is already authenticated
        const token = localStorage.getItem('webscan_token');
        if (token) {
            // Verify subscription status before redirecting
            const subscriptionTier = this.getSubscriptionTierSync(token);
            
            if (subscriptionTier === 'free' || subscriptionTier === 'trial') {
                // Still on free/trial plan - show wallet connection for potential upgrade
                this.showWalletModal();
            } else {
                // Already subscribed to Pro - redirect to app
                window.location.href = '/app';
            }
        } else {
            // For free users, show wallet connection modal
            this.showWalletModal();
        }
    }

    // Synchronous helper method to get user's subscription tier from stored data
    getSubscriptionTierSync(token) {
        try {
            // Check if we have cached subscription info in localStorage
            const cachedData = localStorage.getItem('user_subscription_cache');
            if (cachedData) {
                const cache = JSON.parse(cachedData);
                if (cache.token === token && cache.expires > Date.now()) {
                    return cache.tier;
                }
            }
            return 'free'; // Default to free if no cache or expired
        } catch (error) {
            console.error('Subscription cache error:', error);
            return 'free';
        }
    }

    scrollToPricing() {
        const pricingSection = document.getElementById('pricing');
        if (pricingSection) {
            pricingSection.scrollIntoView({
                behavior: 'smooth',
                block: 'start'
            });
        }
    }

    async handleSubscribe(plan) {
        // Check if user is already authenticated
        const token = localStorage.getItem('webscan_token');
        if (token) {
            // Verify subscription status before redirecting
            const subscriptionTier = await this.getSubscriptionTier(token);
            
            if (subscriptionTier === 'free' || subscriptionTier === 'trial') {
                // Still on free/trial plan - show payment flow
                this.showWalletModal();
                this.pendingSubscription = plan;
            } else {
                // Already subscribed to Pro - redirect to app
                window.location.href = '/app';
            }
        } else {
            // Not authenticated - show wallet modal
            this.showWalletModal();

            // Store the intended plan for after wallet connection
            this.pendingSubscription = plan;
        }
    }

    // Helper method to get user's subscription tier
    async getSubscriptionTier(token) {
        try {
            const response = await fetch('/api/auth/verify-token', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });

            if (response.ok) {
                const data = await response.json();
                return data.user.subscriptionTier;
            }
            return 'free'; // Default to free if verification fails
        } catch (error) {
            console.error('Subscription check error:', error);
            return 'free';
        }
    }

    async connectMetaMask() {
        try {
            if (typeof window.ethereum === 'undefined') {
                this.showNotification('MetaMask is not installed. Please install MetaMask and try again.', 'error');
                return;
            }

            // Request account access
            const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
            const account = accounts[0];

            this.showNotification('MetaMask connected successfully!', 'success');
            this.hideWalletModal();

            // Proceed with authentication
            await this.authenticateWithWallet(account, 'metamask');

        } catch (error) {
            console.error('MetaMask connection error:', error);
            this.showNotification('Failed to connect MetaMask. Please try again.', 'error');
        }
    }

    async connectWalletConnect() {
        try {
            this.showNotification('WalletConnect integration coming soon!', 'info');
            // TODO: Implement WalletConnect integration
        } catch (error) {
            console.error('WalletConnect error:', error);
            this.showNotification('Failed to connect with WalletConnect.', 'error');
        }
    }

    async connectCoinbase() {
        try {
            this.showNotification('Coinbase Wallet integration coming soon!', 'info');
            // TODO: Implement Coinbase Wallet integration
        } catch (error) {
            console.error('Coinbase Wallet error:', error);
            this.showNotification('Failed to connect Coinbase Wallet.', 'error');
        }
    }

    async authenticateWithWallet(walletAddress, walletType) {
        try {
            // Step 1: Get nonce from server
            const nonceResponse = await fetch('/api/auth/nonce', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ walletAddress })
            });

            if (!nonceResponse.ok) {
                throw new Error('Failed to get authentication nonce');
            }

            const { nonce } = await nonceResponse.json();

            // Step 2: Sign the nonce with the wallet
            const message = `WebScan Pro Authentication\n\nWallet: ${walletAddress}\nNonce: ${nonce}\n\nSign this message to authenticate with WebScan Pro.`;
            const signature = await this.signMessage(walletAddress, message);

            // Step 3: Verify signature with server
            const verifyResponse = await fetch('/api/auth/verify', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    walletAddress,
                    signature,
                    message,
                    walletType
                })
            });

            if (!verifyResponse.ok) {
                throw new Error('Authentication failed');
            }

            const authResult = await verifyResponse.json();

            // Store JWT token
            localStorage.setItem('webscan_token', authResult.token);

            // Cache the subscription tier for synchronous access
            this.cacheSubscriptionTier(authResult.token, authResult.user.subscriptionTier);

            // Update UI to show connected wallet
            this.updateWalletDisplay(walletAddress, authResult.user.subscriptionTier);

            this.showNotification('Authentication successful!', 'success');

            // Handle subscription or redirect after a brief delay
            setTimeout(() => {
                if (this.pendingSubscription) {
                    this.handlePayment(this.pendingSubscription, walletAddress);
                } else {
                    this.showNotification('Click your wallet address to access the app!', 'info');
                }
            }, 1000);

        } catch (error) {
            console.error('Authentication error:', error);
            this.showNotification('Authentication failed. Please try again.', 'error');
        }
    }

    async signMessage(walletAddress, message) {
        if (typeof window.ethereum !== 'undefined') {
            try {
                const accounts = await window.ethereum.request({ method: 'eth_accounts' });
                if (accounts[0] !== walletAddress) {
                    throw new Error('Wallet address mismatch');
                }

                const signature = await window.ethereum.request({
                    method: 'personal_sign',
                    params: [message, walletAddress],
                });

                return signature;
            } catch (error) {
                throw new Error('Failed to sign message: ' + error.message);
            }
        } else {
            throw new Error('No Ethereum provider found');
        }
    }

    async handlePayment(plan, walletAddress) {
        try {
            const planDetails = {
                pro: { amount: 9.99, currency: 'USD' }
            };

            const details = planDetails[plan];
            if (!details) {
                throw new Error('Invalid plan selected');
            }

            // Create payment with NOWPayments
            const paymentResponse = await fetch('/api/create-payment', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${localStorage.getItem('webscan_token')}`
                },
                body: JSON.stringify({
                    plan,
                    amount: details.amount,
                    currency: details.currency,
                    walletAddress
                })
            });

            if (!paymentResponse.ok) {
                throw new Error('Failed to create payment');
            }

            const paymentData = await paymentResponse.json();

            // Redirect to NOWPayments payment URL
            window.location.href = paymentData.paymentUrl;

        } catch (error) {
            console.error('Payment creation error:', error);
            this.showNotification('Failed to create payment. Please try again.', 'error');
        }
    }

    checkWalletConnection() {
        // Check if user is already authenticated
        const token = localStorage.getItem('webscan_token');
        if (token) {
            // Verify token with server
            this.verifyTokenAndUpdateUI(token);
        }
    }

    async verifyTokenAndUpdateUI(token) {
        try {
            const response = await fetch('/api/auth/verify-token', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });

            if (response.ok) {
                const data = await response.json();
                // Cache the subscription tier for synchronous access
                this.cacheSubscriptionTier(token, data.user.subscriptionTier);
                this.updateWalletDisplay(data.user.walletAddress, data.user.subscriptionTier);
            } else {
                // Token is invalid, remove it and cache
                localStorage.removeItem('webscan_token');
                localStorage.removeItem('user_subscription_cache');
            }
        } catch (error) {
            console.error('Token verification error:', error);
            localStorage.removeItem('webscan_token');
            localStorage.removeItem('user_subscription_cache');
        }
    }

    // Cache subscription tier for synchronous access
    cacheSubscriptionTier(token, tier) {
        const cache = {
            token: token,
            tier: tier,
            expires: Date.now() + (5 * 60 * 100) // Cache for 5 minutes
        };
        localStorage.setItem('user_subscription_cache', JSON.stringify(cache));
    }

    updateWalletDisplay(walletAddress, subscriptionTier) {
        const connectWalletBtn = document.getElementById('connectWallet');
        if (connectWalletBtn && walletAddress) {
            // Update button to show wallet address with disconnect option
            const shortAddress = `${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}`;
            connectWalletBtn.innerHTML = `
                <i class="fas fa-wallet mr-2"></i>
                <span class="text-green-400">${shortAddress}</span>
                <span class="ml-2 px-2 py-1 bg-${subscriptionTier === 'pro' ? 'green' : 'gray'}-500/20 text-${subscriptionTier === 'pro' ? 'green' : 'gray'}-300 rounded text-xs">
                    ${subscriptionTier.toUpperCase()}
                </span>
                <button id="disconnectBtn" class="ml-2 px-2 py-1 bg-red-500/20 hover:bg-red-500/30 text-red-300 rounded text-xs transition-colors" title="Disconnect Wallet">
                    <i class="fas fa-sign-out-alt"></i>
                </button>
            `;

            // Add click handler to go to app
            connectWalletBtn.onclick = (e) => {
                // Only go to app if not clicking the disconnect button
                if (!e.target.closest('#disconnectBtn')) {
                    window.location.href = '/app';
                }
            };

            // Add disconnect button handler
            const disconnectBtn = document.getElementById('disconnectBtn');
            if (disconnectBtn) {
                disconnectBtn.onclick = (e) => {
                    e.stopPropagation();
                    this.disconnectWallet();
                };
            }

            // Keep right-click menu for additional options
            connectWalletBtn.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                this.showDisconnectMenu(e);
            });
        }
    }

    showDisconnectMenu(event) {
        // Create a simple disconnect menu
        const menu = document.createElement('div');
        menu.className = 'fixed z-50 glass rounded-xl p-2 min-w-32';
        menu.style.left = `${event.clientX}px`;
        menu.style.top = `${event.clientY}px`;

        menu.innerHTML = `
            <button id="disconnectWallet" class="w-full text-left px-3 py-2 text-white hover:bg-white/10 rounded transition-colors">
                <i class="fas fa-sign-out-alt mr-2"></i>Disconnect
            </button>
        `;

        document.body.appendChild(menu);

        // Handle disconnect
        const disconnectBtn = document.getElementById('disconnectWallet');
        disconnectBtn.addEventListener('click', () => {
            this.disconnectWallet();
            document.body.removeChild(menu);
        });

        // Remove menu on outside click
        const removeMenu = (e) => {
            if (!menu.contains(e.target)) {
                document.body.removeChild(menu);
                document.removeEventListener('click', removeMenu);
            }
        };

        setTimeout(() => {
            document.addEventListener('click', removeMenu);
        }, 100);
    }

    disconnectWallet() {
        localStorage.removeItem('webscan_token');
        localStorage.removeItem('user_subscription_cache');
        location.reload(); // Refresh to show connect button again
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
}

// Initialize the landing page when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    new LandingPage();
});
