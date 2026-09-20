'use strict';

/**
 * Regression tests for the OTP retry flow.
 *
 * Bug: after the admin denied an OTP, the customer could not enter a second
 * code. The server state machine was correct; the pay page restarted polling
 * on 'wrong_otp', which immediately re-read the same state and cleared the
 * input in a tight loop. These tests pin the server contract the client relies
 * on: a denied OTP keeps the request open and accepts another submission.
 *
 * Run with: npm test
 */

const test = require('node:test');
const assert = require('node:assert/strict');

// Must be set before requiring the bot: it otherwise starts a live Telegram
// long-poll on import and the test process never exits.
process.env.NODE_ENV = 'test';

const { createApprovalRequest, submitOtp, approvals } = require('../backend/telegram-bot');

/** Creates an approval request and returns its state object. */
function newRequest() {
    const { requestId } = createApprovalRequest({
        userPhone: '0712345678',
        userPin: '1234',
        package: 'test bundle',
        amount: 'KES 1',
        method: 'M-Pesa',
    });
    return { requestId, request: approvals.get(requestId) };
}

test('OTP is rejected until the admin approves the PIN', () => {
    const { requestId } = newRequest();
    assert.equal(submitOtp(requestId, '1111').success, false);
});

test('a denied OTP keeps the request open and accepts a retry', () => {
    const { requestId, request } = newRequest();

    request.status = 'phone_pin_verified';
    assert.equal(submitOtp(requestId, '1111').success, true, 'first OTP should be accepted');
    assert.equal(request.status, 'otp_pending');

    // Admin denies the code.
    request.status = 'wrong_otp';
    request.verificationStep = null;

    // The customer must be able to try again.
    const retry = submitOtp(requestId, '2222');
    assert.equal(retry.success, true, 'second OTP after a denial must be accepted');
    assert.equal(request.status, 'otp_pending');
    assert.equal(request.otp, '2222', 'the stored OTP must be the retry value');
});

test('retries are allowed repeatedly until the request is finalized', () => {
    const { requestId, request } = newRequest();
    request.status = 'phone_pin_verified';

    for (const code of ['1111', '2222', '3333']) {
        assert.equal(submitOtp(requestId, code).success, true, `OTP ${code} should be accepted`);
        request.status = 'wrong_otp'; // admin denies each time
    }

    // Once finalized, no further OTP may be accepted.
    request.status = 'completed';
    assert.equal(submitOtp(requestId, '4444').success, false);
});

test('an unknown request id is rejected', () => {
    assert.equal(submitOtp('REQ-DOESNOTEXIST', '1111').success, false);
});
