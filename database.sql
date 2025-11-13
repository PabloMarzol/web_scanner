-- WebScan Pro Database Schema
-- Run this script to set up the PostgreSQL database

-- Create database (run this manually if needed)
-- CREATE DATABASE webscan_pro;

-- Use the database
-- \c webscan_pro;

-- Create users table
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    wallet_address VARCHAR(42) UNIQUE NOT NULL, -- Ethereum addresses are 42 characters (0x + 40 hex)
    subscription_tier VARCHAR(20) NOT NULL DEFAULT 'free' CHECK (subscription_tier IN ('free', 'pro')),
    subscription_status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (subscription_status IN ('active', 'inactive', 'cancelled', 'expired')),
    subscription_start_date TIMESTAMP WITH TIME ZONE,
    subscription_end_date TIMESTAMP WITH TIME ZONE,
    scans_used_this_month INTEGER NOT NULL DEFAULT 0,
    monthly_scan_limit INTEGER NOT NULL DEFAULT 5, -- Free tier: 5 scans/month
    last_scan_date DATE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Create scans table to track user scan history
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

-- Create payments table to track payment transactions
CREATE TABLE IF NOT EXISTS payments (
    id SERIAL PRIMARY KEY,
    payment_id VARCHAR(100) UNIQUE NOT NULL, -- NOWPayments payment ID
    user_wallet_address VARCHAR(42) NOT NULL REFERENCES users(wallet_address) ON DELETE CASCADE,
    plan VARCHAR(20) NOT NULL,
    amount DECIMAL(10,2) NOT NULL,
    currency VARCHAR(10) NOT NULL DEFAULT 'USD',
    payment_status VARCHAR(20) NOT NULL DEFAULT 'pending',
    nowpayments_order_id VARCHAR(100),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_users_wallet_address ON users(wallet_address);
CREATE INDEX IF NOT EXISTS idx_scans_user_wallet ON scans(user_wallet_address);
CREATE INDEX IF NOT EXISTS idx_scans_created_at ON scans(created_at);
CREATE INDEX IF NOT EXISTS idx_payments_user_wallet ON payments(user_wallet_address);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(payment_status);

-- Create function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Create triggers to automatically update updated_at
CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_payments_updated_at BEFORE UPDATE ON payments
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Insert default subscription limits
-- Free tier: 5 scans/month, limited features
-- Pro tier: unlimited scans, full features
-- Enterprise tier: unlimited scans, API access, custom features

-- Function to reset monthly scan counts (run this monthly)
CREATE OR REPLACE FUNCTION reset_monthly_scan_counts()
RETURNS void AS $$
BEGIN
    UPDATE users SET scans_used_this_month = 0, last_scan_date = NULL;
END;
$$ LANGUAGE plpgsql;

-- Function to get user subscription info
CREATE OR REPLACE FUNCTION get_user_subscription(wallet_addr VARCHAR(42))
RETURNS TABLE (
    subscription_tier VARCHAR(20),
    subscription_status VARCHAR(20),
    scans_used_this_month INTEGER,
    monthly_scan_limit INTEGER,
    subscription_end_date TIMESTAMP WITH TIME ZONE
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        u.subscription_tier,
        u.subscription_status,
        u.scans_used_this_month,
        u.monthly_scan_limit,
        u.subscription_end_date
    FROM users u
    WHERE u.wallet_address = wallet_addr;
END;
$$ LANGUAGE plpgsql;

-- Function to check if user can perform scan
CREATE OR REPLACE FUNCTION can_user_scan(wallet_addr VARCHAR(42))
RETURNS BOOLEAN AS $$
DECLARE
    user_record RECORD;
    current_month DATE := DATE_TRUNC('month', CURRENT_DATE);
    last_scan_month DATE;
BEGIN
    -- Get user record
    SELECT * INTO user_record FROM users WHERE wallet_address = wallet_addr;

    IF NOT FOUND THEN
        -- New user, allow free scan
        RETURN TRUE;
    END IF;

    -- Check subscription status
    IF user_record.subscription_status != 'active' THEN
        RETURN FALSE;
    END IF;

    -- Check subscription expiry
    IF user_record.subscription_end_date IS NOT NULL AND user_record.subscription_end_date < CURRENT_TIMESTAMP THEN
        -- Update status to expired
        UPDATE users SET subscription_status = 'expired' WHERE wallet_address = wallet_addr;
        RETURN FALSE;
    END IF;

    -- Check monthly scan limit
    IF user_record.scans_used_this_month >= user_record.monthly_scan_limit THEN
        RETURN FALSE;
    END IF;

    RETURN TRUE;
END;
$$ LANGUAGE plpgsql;

-- Function to increment user's scan count
CREATE OR REPLACE FUNCTION increment_user_scan_count(wallet_addr VARCHAR(42))
RETURNS BOOLEAN AS $$
DECLARE
    current_month DATE := DATE_TRUNC('month', CURRENT_DATE);
    last_scan_month DATE;
BEGIN
    -- Get user's last scan month
    SELECT DATE_TRUNC('month', last_scan_date) INTO last_scan_month
    FROM users WHERE wallet_address = wallet_addr;

    -- Reset count if it's a new month
    IF last_scan_month IS NULL OR last_scan_month != current_month THEN
        UPDATE users
        SET scans_used_this_month = 1, last_scan_date = CURRENT_DATE
        WHERE wallet_address = wallet_addr;
    ELSE
        -- Increment existing count
        UPDATE users
        SET scans_used_this_month = scans_used_this_month + 1, last_scan_date = CURRENT_DATE
        WHERE wallet_address = wallet_addr;
    END IF;

    RETURN TRUE;
END;
$$ LANGUAGE plpgsql;
