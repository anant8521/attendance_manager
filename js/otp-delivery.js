// js/otp-delivery.js
//
// Real delivery channels for the Admin "Forgot Password" one-time code —
// see js/app.js ADMIN FORGOT PASSWORD section for where these are called
// from. The OTP itself is generated and hashed in app.js and is NEVER
// passed to or displayed by anything here; this file's only job is to hand
// the plaintext code to a real delivery channel and report success/failure.
//
// EMAIL — uses EmailJS (https://www.emailjs.com), a hosted service made
// specifically for sending real email straight from client-side JavaScript
// with no backend server required — the same reason this app already uses
// Firebase for cloud sync (see firebase/firebase-config.js) rather than
// standing up its own server. Free tier is enough for a single class.
//
//   1. Create a free account at emailjs.com
//   2. Add an Email Service (e.g. Gmail) and an Email Template with two
//      template variables: {{to_email}}, {{to_name}}, {{otp_code}}
//   3. Paste your Public Key / Service ID / Template ID below
//   4. Set EMAILJS_ENABLED to true
//   5. Add the EmailJS CDN <script> tag to index.html (see README)
//
// SMS — sending real SMS from a purely static, backend-less app isn't
// possible with a drop-in client library the way email/Firestore are (SMS
// gateways such as Twilio, MSG91, Fast2SMS etc. all require a server-side
// secret key that must never be exposed in browser JS). Real SMS delivery
// therefore needs a small backend call — most simply, a single Firebase
// Cloud Function that receives {mobile, otp} and forwards it to your SMS
// gateway of choice. sendSmsOtp() below is the one hook to wire that up —
// point SMS_ENDPOINT at that Cloud Function URL and set SMS_GATEWAY_ENABLED
// to true. Until that's done, the app is upfront about it (see
// stepMethod/stepVerify in js/app.js) rather than pretending to send
// something that never arrives — the OTP is still never shown on screen.
/* ===========================================================
   Email OTP Service (GitHub Pages + EmailJS)
=========================================================== */

const EMAILJS_CONFIG = {
    enabled: true,

    // Your EmailJS Credentials
    publicKey: "8ySM3dtUtj7g9BZaR",
    serviceId: "service_t75o0hk",

    // Replace this with your real Template ID
    templateId: "template_ujho8nu"
};

let emailInitialized = false;

function initEmailJS() {

    if (!EMAILJS_CONFIG.enabled) return false;
    if (emailInitialized) return true;

    if (typeof emailjs === "undefined") {
        console.error("EmailJS SDK not loaded.");
        return false;
    }

    try {
        emailjs.init({
            publicKey: EMAILJS_CONFIG.publicKey
        });

        emailInitialized = true;
        return true;

    } catch (error) {
        console.error(error);
        return false;
    }
}

// Send OTP Email
// NOTE: the OTP is generated exactly once, in js/app.js (sendOtp()), which
// hashes it and keeps that hash for verification. This function must only
// ever relay that same plaintext code to EmailJS — it must NEVER generate
// its own OTP, or the code that's emailed will no longer match the code
// verification checks against.
async function sendEmailOtp(email, otp, fullName) {

    if (!initEmailJS()) {
        return {
            ok: false,
            reason: "EmailJS not initialized"
        };
    }

    try {

        await emailjs.send(
            EMAILJS_CONFIG.serviceId,
            EMAILJS_CONFIG.templateId,
            {
                to_email: email,
                to_name: fullName,
                otp_code: otp
            }
        );

        return {
            ok: true,
            otp
        };

    } catch (error) {

        console.error(error);

        return {
            ok: false,
            reason: error.text || error.message
        };
    }
}

// SMS Disabled
async function sendSmsOtp() {

    return {
        ok: false,
        reason: "SMS OTP is disabled."
    };

}

window.OtpDelivery = {

    sendEmailOtp,
    sendSmsOtp,

    get emailEnabled() {
        return true;
    },

    get smsEnabled() {
        return false;
    }

};