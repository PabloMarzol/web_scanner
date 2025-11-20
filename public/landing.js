class LandingPage {
    constructor() {
        this.init();
        this.setupScrollEffects();
    }

    init() {
        // UI Elements
        this.connectWalletBtn = document.getElementById('connectWallet');
        this.heroStartBtn = document.getElementById('heroStartBtn');
        this.heroPricingBtn = document.getElementById('heroPricingBtn');
        this.walletModal = document.getElementById('walletModal');
        this.closeWalletModalBtn = document.getElementById('closeWalletModal');
        this.connectMetaMaskBtn = document.getElementById('connectMetaMask');
        this.connectWalletConnectBtn = document.getElementById('connectWalletConnect');
        this.subscribeBtns = document.querySelectorAll('.subscribe-btn');

        // Event Listeners
        if (this.connectWalletBtn) {
            this.connectWalletBtn.addEventListener('click', () => this.openWalletModal());
        }

        if (this.heroStartBtn) {
            this.heroStartBtn.addEventListener('click', () => this.handleStartScanning());
        }

        if (this.heroPricingBtn) {
            this.heroPricingBtn.addEventListener('click', () => {
                const pricingSection = document.getElementById('pricing');
                if (pricingSection) {
                    pricingSection.scrollIntoView({ behavior: 'smooth' });
                }
            });
        }

        if (this.closeWalletModalBtn) {
            this.closeWalletModalBtn.addEventListener('click', () => this.closeWalletModal());
        }

        if (this.walletModal) {
            this.walletModal.addEventListener('click', (e) => {
                if (e.target === this.walletModal) this.closeWalletModal();
            });
        }

        if (this.connectMetaMaskBtn) {
            this.connectMetaMaskBtn.addEventListener('click', () => this.connectMetaMask());
        }

        if (this.connectWalletConnectBtn) {
            this.connectWalletConnectBtn.addEventListener('click', () => {
                alert('WalletConnect support coming soon!');
            });
        }

        this.subscribeBtns.forEach(btn => {
            btn.addEventListener('click', (e) => this.handleSubscription(e));
        });

        // Check for existing connection
        this.checkWalletConnection();
        this.updateScanCounter();
    }

    setupScrollEffects() {
        // Navbar scroll effect
        window.addEventListener('scroll', () => {
            const nav = document.querySelector('nav');
            if (nav) {
                if (window.scrollY > 50) {
                    nav.classList.add('bg-black/90', 'shadow-lg');
                    nav.classList.remove('bg-black/80');
                } else {
                    nav.classList.remove('bg-black/90', 'shadow-lg');
                    nav.classList.add('bg-black/80');
                }
            }
        });

        // Intersection Observer for Showcase Items
        const observerOptions = {
            threshold: 0.2,
            rootMargin: '0px'
        };

        const observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    entry.target.classList.remove('opacity-0', 'translate-y-20');
                    entry.target.classList.add('opacity-100', 'translate-y-0');
                }
            });
        }, observerOptions);

        document.querySelectorAll('.showcase-item').forEach(item => {
            observer.observe(item);
        });

        // Observer for Scan Counter
        const counterObserver = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    entry.target.classList.remove('translate-y-32', 'hidden');
                    entry.target.classList.add('translate-y-0');
                }
            });
        }, { threshold: 0.1 });

        const scanCounter = document.getElementById('scanCounter');
        if (scanCounter) {
            // Show counter after a slight delay or when scrolling down
            setTimeout(() => {
                scanCounter.classList.remove('hidden');
                requestAnimationFrame(() => {
                    scanCounter.classList.remove('translate-y-32');
                });
            }, 2000);
        }
    }

    async updateScanCounter() {
        const scanCounter = document.getElementById('scanCounter');
        const scanCountEl = document.getElementById('scanCount');
        const scanLabelEl = document.getElementById('scanLabel');
        const progressRing = document.getElementById('scanProgressRing');

        if (!scanCounter || !scanCountEl || !scanLabelEl || !progressRing) return;

        const token = localStorage.getItem('webscan_token');

        if (token) {
            try {
                const response = await fetch('/api/user/subscription', {
                    headers: { 'Authorization': `Bearer ${token}` }
                });

                if (response.ok) {
                    const data = await response.json();
                    const { scansUsed, limit, tier } = data;

                    // Calculate remaining
                    let remaining = limit - scansUsed;
                    if (remaining < 0) remaining = 0;

                    // Update UI
                    if (tier === 'pro' || tier === 'epic') {
                        scanCountEl.textContent = '∞';
                        scanLabelEl.textContent = 'Unlimited';
                        scanLabelEl.className = 'text-sm font-medium text-purple-400';
                        progressRing.style.strokeDashoffset = '0'; // Full circle
                        progressRing.classList.remove('text-blue-500');
                        progressRing.classList.add('text-purple-500');
                    } else {
                        scanCountEl.textContent = remaining;
                        scanLabelEl.textContent = `${remaining} Left`;

                        // Calculate progress circle
                        // Circumference is 2 * PI * 20 ≈ 125.6
                        const circumference = 125.6;
                        const offset = circumference - ((remaining / 5) * circumference);
                        progressRing.style.strokeDashoffset = offset;
                    }
                }
            } catch (error) {
                console.error('Error fetching scan count:', error);
            }
        } else {
            // Default for non-logged in users
            scanCountEl.textContent = '5';
            scanLabelEl.textContent = 'Free Scans';
            progressRing.style.strokeDashoffset = '0';
        }
    }

    openWalletModal() {
        if (this.walletModal) {
            this.walletModal.classList.remove('hidden');
            setTimeout(() => {
                this.walletModal.classList.remove('opacity-0');
            }, 10);
        }
    }

    closeWalletModal() {
        if (this.walletModal) {
            this.walletModal.classList.add('opacity-0');
            setTimeout(() => {
                this.walletModal.classList.add('hidden');
            }, 300);
        }
    }

    async handleStartScanning() {
        const isConnected = await this.checkWalletConnection(false);
        if (isConnected) {
            window.location.href = '/app';
        } else {
            this.openWalletModal();
        }
    }

    async connectMetaMask() {
        if (typeof window.ethereum !== 'undefined') {
            try {
                const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
                const account = accounts[0];
                await this.authenticateWithWallet(account);
            } catch (error) {
                console.error('User denied account access', error);
                alert('Failed to connect wallet. Please try again.');
            }
        } else {
            window.open('https://metamask.io/download.html', '_blank');
        }
    }

    async authenticateWithWallet(address) {
        try {
            // 1. Get nonce
            const nonceResponse = await fetch('/api/auth/nonce', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ address })
            });
            const { nonce } = await nonceResponse.json();

            // 2. Sign nonce
            const message = `Sign this message to verify your ownership of the wallet address: ${address}\nNonce: ${nonce}`;
            const signature = await window.ethereum.request({
                method: 'personal_sign',
                params: [message, address]
            });

            // 3. Verify signature
            const authResponse = await fetch('/api/auth/verify', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ address, signature })
            });

            if (authResponse.ok) {
                const data = await authResponse.json();
                localStorage.setItem('webscan_token', data.token);
                localStorage.setItem('walletAddress', address);

                // Check subscription and redirect
                await this.checkSubscriptionAndRedirect(address);
            } else {
                throw new Error('Authentication failed');
            }
        } catch (error) {
            console.error('Auth error:', error);
            alert('Authentication failed. Please try again.');
        }
    }

    async checkSubscriptionAndRedirect(address) {
        try {
            const token = localStorage.getItem('webscan_token');
            const response = await fetch('/api/user/subscription', {
                headers: { 'Authorization': `Bearer ${token}` }
            });

            if (response.ok) {
                const data = await response.json();
                // Store subscription status
                localStorage.setItem('subscriptionTier', data.tier);

                // Redirect logic
                if (data.tier === 'pro' || data.tier === 'business' || data.tier === 'enterprise') {
                    window.location.href = '/app?mode=pro';
                } else {
                    window.location.href = '/app';
                }
            } else {
                window.location.href = '/app';
            }
        } catch (error) {
            console.error('Error checking subscription:', error);
            window.location.href = '/app';
        }
    }

    async checkWalletConnection(updateUI = true) {
        if (typeof window.ethereum !== 'undefined') {
            try {
                const accounts = await window.ethereum.request({ method: 'eth_accounts' });
                if (accounts.length > 0) {
                    if (updateUI) {
                        this.updateUIForConnectedState(accounts[0]);
                    }
                    return true;
                }
            } catch (error) {
                console.error('Error checking wallet connection:', error);
            }
        }
        return false;
    }

    updateUIForConnectedState(address) {
        const shortAddress = `${address.substring(0, 6)}...${address.substring(38)}`;
        if (this.connectWalletBtn) {
            this.connectWalletBtn.innerHTML = `<i class="fas fa-wallet"></i> ${shortAddress} <i class="fas fa-sign-out-alt ml-2"></i>`;
            this.connectWalletBtn.classList.remove('bg-blue-600', 'hover:bg-blue-700');
            this.connectWalletBtn.classList.add('bg-gray-700', 'hover:bg-gray-600');

            // Remove old event listeners to prevent multiple bindings
            const newBtn = this.connectWalletBtn.cloneNode(true);
            this.connectWalletBtn.parentNode.replaceChild(newBtn, this.connectWalletBtn);
            this.connectWalletBtn = newBtn;

            this.connectWalletBtn.addEventListener('click', () => {
                if (confirm('Disconnect wallet?')) {
                    this.disconnectWallet();
                }
            });
        }
    }

    disconnectWallet() {
        localStorage.removeItem('webscan_token');
        localStorage.removeItem('walletAddress');
        localStorage.removeItem('subscriptionTier');

        // Reset UI
        if (this.connectWalletBtn) {
            this.connectWalletBtn.innerHTML = 'Connect Wallet';
            this.connectWalletBtn.classList.remove('bg-gray-700', 'hover:bg-gray-600');
            this.connectWalletBtn.classList.add('bg-blue-600', 'hover:bg-blue-700');

            // Rebind connect listener
            const newBtn = this.connectWalletBtn.cloneNode(true);
            this.connectWalletBtn.parentNode.replaceChild(newBtn, this.connectWalletBtn);
            this.connectWalletBtn = newBtn;

            this.connectWalletBtn.addEventListener('click', () => this.openWalletModal());
        }

        alert('Wallet disconnected.');
    }

    async handleSubscription(e) {
        const btn = e.currentTarget;
        const plan = btn.dataset.plan;

        const isConnected = await this.checkWalletConnection(false);
        if (!isConnected) {
            this.openWalletModal();
            return;
        }

        // Proceed to payment
        this.initiatePayment(plan);
    }

    async initiatePayment(plan) {
        try {
            const token = localStorage.getItem('webscan_token');
            if (!token) {
                alert('Please connect your wallet first.');
                return;
            }

            const response = await fetch('/api/create-payment', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({
                    plan: plan,
                    price_amount: 9.99, // Dynamic based on plan in real app
                    price_currency: 'usd',
                    pay_currency: 'btc' // Default or user selection
                })
            });

            if (response.ok) {
                const data = await response.json();
                if (data.invoice_url) {
                    window.location.href = data.invoice_url;
                } else {
                    alert('Failed to create payment invoice.');
                }
            } else {
                const error = await response.json();
                alert(`Payment creation failed: ${error.message}`);
            }
        } catch (error) {
            console.error('Payment error:', error);
            alert('An error occurred while initiating payment.');
        }
    }
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    new LandingPage();
});
