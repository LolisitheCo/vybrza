[1mdiff --git a/src/bot/bot.js b/src/bot/bot.js[m
[1mindex 37ea7c9..4b9cbb7 100644[m
[1m--- a/src/bot/bot.js[m
[1m+++ b/src/bot/bot.js[m
[36m@@ -147,7 +147,7 @@[m [masync function sendWelcome(ctx) {[m
     }[m
 [m
     const telegramId = String(ctx.from.id);[m
[31m-    await getOrCreateUser(telegramId);[m
[32m+[m[32m    await getOrCreateUser(ctx.from);[m
 [m
     const firstName = escapeMarkdown([m
       cleanText(ctx.from.first_name || "there", 64)[m
[1mdiff --git a/src/bot/paymentBot.js b/src/bot/paymentBot.js[m
[1mindex aa84223..f035f2d 100644[m
[1m--- a/src/bot/paymentBot.js[m
[1m+++ b/src/bot/paymentBot.js[m
[36m@@ -201,21 +201,11 @@[m [mexport function registerPaymentHandlers(bot) {[m
 [m
         callbackAnswered = true;[m
 [m
[31m-        const telegramId = String(ctx.from.id);[m
[32m+[m[32m       if (!ctx.from?.id) {[m
[32m+[m[32m  throw new Error("A valid Telegram user is required.");[m
[32m+[m[32m}[m
 [m
[31m-        const user = await getOrCreateUser([m
[31m-          telegramId[m
[31m-        );[m
[31m-[m
[31m-        if ([m
[31m-          !user ||[m
[31m-          typeof user.id !== "string" ||[m
[31m-          user.id !== telegramId[m
[31m-        ) {[m
[31m-          throw new Error([m
[31m-            "Unable to identify your SA LIVE account."[m
[31m-          );[m
[31m-        }[m
[32m+[m[32mconst user = await getOrCreateUser(ctx.from);[m
 [m
         if ([m
           user.verificationStatus !== "approved"[m
[36m@@ -374,9 +364,11 @@[m [mexport function registerPaymentHandlers(bot) {[m
     try {[m
       await ctx.answerCbQuery();[m
 [m
[31m-      const user = await getOrCreateUser([m
[31m-        String(ctx.from.id)[m
[31m-      );[m
[32m+[m[32m     if (!ctx.from?.id) {[m
[32m+[m[32m  throw new Error("A valid Telegram user is required.");[m
[32m+[m[32m}[m
[32m+[m
[32m+[m[32mconst user = await getOrCreateUser(ctx.from);[m
 [m
       const minutes = Number(user.minutes ?? 0);[m
 [m
[1mdiff --git a/src/services/billingService.js b/src/services/billingService.js[m
[1mnew file mode 100644[m
[1mindex 0000000..b6afc85[m
[1m--- /dev/null[m
[1m+++ b/src/services/billingService.js[m
[36m@@ -0,0 +1,333 @@[m
[32m+[m
[32m+[m[32mimport { db } from "../config/firebase.js";[m
[32m+[m
[32m+[m[32m// ============================================================[m
[32m+[m[32m// SA LIVE BILLING SERVICE[m
[32m+[m[32m// ============================================================[m
[32m+[m[32m// Customer: R6 per billable minute[m
[32m+[m[32m// Host:     R2 per billable minute[m
[32m+[m[32m// SA LIVE:  R4 per billable minute[m
[32m+[m[32m//[m
[32m+[m[32m// IMPORTANT:[m
[32m+[m[32m// Call this service only from trusted backend code after[m
[32m+[m[32m// endCall() has completed. Never expose it as an unrestricted[m
[32m+[m[32m// public endpoint.[m
[32m+[m[32m// ============================================================[m
[32m+[m
[32m+[m[32mconst usersCollection = db.collection("users");[m
[32m+[m[32mconst hostsCollection = db.collection("hosts");[m
[32m+[m[32mconst callsCollection = db.collection("callSessions");[m
[32m+[m[32mconst earningsCollection = db.collection("hostEarnings");[m
[32m+[m
[32m+[m[32mexport const SA_LIVE_PRICING = Object.freeze({[m
[32m+[m[32m  customerPricePerMinute: 6,[m
[32m+[m[32m  hostEarningsPerMinute: 2,[m
[32m+[m[32m  saLiveRevenuePerMinute: 4,[m
[32m+[m[32m});[m
[32m+[m
[32m+[m[32mconst MAX_MINUTES = Number.MAX_SAFE_INTEGER;[m
[32m+[m
[32m+[m[32m// ============================================================[m
[32m+[m[32m// HELPERS[m
[32m+[m[32m// ============================================================[m
[32m+[m
[32m+[m[32mfunction requireId(value, fieldName) {[m
[32m+[m[32m  if ([m
[32m+[m[32m    typeof value !== "string" ||[m
[32m+[m[32m    !value.trim() ||[m
[32m+[m[32m    value.trim().length > 200 ||[m
[32m+[m[32m    value.includes("/") ||[m
[32m+[m[32m    value.includes("\0")[m
[32m+[m[32m  ) {[m
[32m+[m[32m    throw new Error(`${fieldName} is invalid.`);[m
[32m+[m[32m  }[m
[32m+[m
[32m+[m[32m  return value.trim();[m
[32m+[m[32m}[m
[32m+[m
[32m+[m[32mfunction readMinutes(value, fieldName) {[m
[32m+[m[32m  const minutes = value ?? 0;[m
[32m+[m
[32m+[m[32m  if ([m
[32m+[m[32m    !Number.isSafeInteger(minutes) ||[m
[32m+[m[32m    minutes < 0[m
[32m+[m[32m  ) {[m
[32m+[m[32m    throw new Error(`${fieldName} balance is invalid.`);[m
[32m+[m[32m  }[m
[32m+[m
[32m+[m[32m  return minutes;[m
[32m+[m[32m}[m
[32m+[m
[32m+[m[32mfunction readCents(value, fieldName) {[m
[32m+[m[32m  const cents = value ?? 0;[m
[32m+[m
[32m+[m[32m  if ([m
[32m+[m[32m    !Number.isSafeInteger(cents) ||[m
[32m+[m[32m    cents < 0[m
[32m+[m[32m  ) {[m
[32m+[m[32m    throw new Error(`${fieldName} balance is invalid.`);[m
[32m+[m[32m  }[m
[32m+[m
[32m+[m[32m  return cents;[m
[32m+[m[32m}[m
[32m+[m
[32m+[m[32mfunction moneyToCents(rand) {[m
[32m+[m[32m  const cents = rand * 100;[m
[32m+[m
[32m+[m[32m  if (!Number.isSafeInteger(cents)) {[m
[32m+[m[32m    throw new Error("Calculated billing amount is invalid.");[m
[32m+[m[32m  }[m
[32m+[m
[32m+[m[32m  return cents;[m
[32m+[m[32m}[m
[32m+[m
[32m+[m[32m// ============================================================[m
[32m+[m[32m// FINALIZE CALL BILLING[m
[32m+[m[32m// ============================================================[m
[32m+[m[32m// callId must identify an existing completed call.[m
[32m+[m[32m//[m
[32m+[m[32m// The customer's balance is charged no more than their available[m
[32m+[m[32m// minutes. Host earnings and SA LIVE revenue use the minutes[m
[32m+[m[32m// actually charged.[m
[32m+[m[32m//[m
[32m+[m[32m// Repeated calls do not charge the customer again.[m
[32m+[m[32m// ============================================================[m
[32m+[m
[32m+[m[32mexport async function finalizeCallBilling(callId) {[m
[32m+[m[32m  callId = requireId(callId, "Call ID");[m
[32m+[m
[32m+[m[32m  const callRef = callsCollection.doc(callId);[m
[32m+[m
[32m+[m[32m  return db.runTransaction(async (transaction) => {[m
[32m+[m[32m    // 1. Read call.[m
[32m+[m[32m    const callSnapshot = await transaction.get(callRef);[m
[32m+[m
[32m+[m[32m    if (!callSnapshot.exists) {[m
[32m+[m[32m      throw new Error("Call session was not found.");[m
[32m+[m[32m    }[m
[32m+[m
[32m+[m[32m    const call = callSnapshot.data();[m
[32m+[m
[32m+[m[32m    // Idempotency: never charge a finalized call twice.[m
[32m+[m[32m    if (call.billingStatus === "finalized") {[m
[32m+[m[32m      return {[m
[32m+[m[32m        success: true,[m
[32m+[m[32m        alreadyFinalized: true,[m
[32m+[m[32m        callId,[m
[32m+[m[32m        billableMinutes: call.billableMinutes ?? 0,[m
[32m+[m[32m        customerCharged:[m
[32m+[m[32m          (call.customerChargeCents ?? 0) / 100,[m
[32m+[m[32m        hostEarnings:[m
[32m+[m[32m          (call.hostEarningsCents ?? 0) / 100,[m
[32m+[m[32m        saLiveRevenue:[m
[32m+[m[32m          (call.saLiveRevenueCents ?? 0) / 100,[m
[32m+[m[32m      };[m
[32m+[m[32m    }[m
[32m+[m
[32m+[m[32m    if (call.status !== "completed") {[m
[32m+[m[32m      throw new Error([m
[32m+[m[32m        "Only completed calls can be billed."[m
[32m+[m[32m      );[m
[32m+[m[32m    }[m
[32m+[m
[32m+[m[32m    if (call.billingStatus !== "pending") {[m
[32m+[m[32m      throw new Error([m
[32m+[m[32m        "Call billing is not in a billable state."[m
[32m+[m[32m      );[m
[32m+[m[32m    }[m
[32m+[m
[32m+[m[32m    const userId = requireId(call.userId, "User ID");[m
[32m+[m[32m    const hostId = requireId(call.hostId, "Host ID");[m
[32m+[m
[32m+[m[32m    // Prefer the duration saved by endCall().[m
[32m+[m[32m    // Round up partial minutes for billing.[m
[32m+[m[32m    const durationSeconds = call.durationSeconds ?? 0;[m
[32m+[m
[32m+[m[32m    if ([m
[32m+[m[32m      !Number.isSafeInteger(durationSeconds) ||[m
[32m+[m[32m      durationSeconds < 0[m
[32m+[m[32m    ) {[m
[32m+[m[32m      throw new Error("Call duration is invalid.");[m
[32m+[m[32m    }[m
[32m+[m
[32m+[m[32m    const calculatedMinutes = Math.ceil([m
[32m+[m[32m      durationSeconds / 60[m
[32m+[m[32m    );[m
[32m+[m
[32m+[m[32m    if ([m
[32m+[m[32m      calculatedMinutes > MAX_MINUTES ||[m
[32m+[m[32m      !Number.isSafeInteger(calculatedMinutes)[m
[32m+[m[32m    ) {[m
[32m+[m[32m      throw new Error("Call duration is too large.");[m
[32m+[m[32m    }[m
[32m+[m
[32m+[m[32m    const userRef = usersCollection.doc(userId);[m
[32m+[m[32m    const hostRef = hostsCollection.doc(hostId);[m
[32m+[m[32m    const earningRef = earningsCollection.doc(callId);[m
[32m+[m
[32m+[m[32m    // 2. Read all remaining documents before writing.[m
[32m+[m[32m    const [[m
[32m+[m[32m      userSnapshot,[m
[32m+[m[32m      hostSnapshot,[m
[32m+[m[32m      earningSnapshot,[m
[32m+[m[32m    ] = await Promise.all([[m
[32m+[m[32m      transaction.get(userRef),[m
[32m+[m[32m      transaction.get(hostRef),[m
[32m+[m[32m      transaction.get(earningRef),[m
[32m+[m[32m    ]);[m
[32m+[m
[32m+[m[32m    if (!userSnapshot.exists) {[m
[32m+[m[32m      throw new Error("Customer account was not found.");[m
[32m+[m[32m    }[m
[32m+[m
[32m+[m[32m    if (!hostSnapshot.exists) {[m
[32m+[m[32m      throw new Error("Host account was not found.");[m
[32m+[m[32m    }[m
[32m+[m
[32m+[m[32m    // A pre-existing earnings record with pending billing[m
[32m+[m[32m    // indicates inconsistent data. Do not silently credit again.[m
[32m+[m[32m    if (earningSnapshot.exists) {[m
[32m+[m[32m      throw new Error([m
[32m+[m[32m        "Host earnings already exist for an unfinalized call. Review this call before retrying."[m
[32m+[m[32m      );[m
[32m+[m[32m    }[m
[32m+[m
[32m+[m[32m    const availableMinutes = readMinutes([m
[32m+[m[32m      userSnapshot.get("minutes"),[m
[32m+[m[32m      "Customer"[m
[32m+[m[32m    );[m
[32m+[m
[32m+[m[32m    // Never allow the customer's minute balance to go negative.[m
[32m+[m[32m    const billableMinutes = Math.min([m
[32m+[m[32m      calculatedMinutes,[m
[32m+[m[32m      availableMinutes[m
[32m+[m[32m    );[m
[32m+[m
[32m+[m[32m    const customerChargeCents = moneyToCents([m
[32m+[m[32m      billableMinutes *[m
[32m+[m[32m        SA_LIVE_PRICING.customerPricePerMinute[m
[32m+[m[32m    );[m
[32m+[m
[32m+[m[32m    const hostEarningsCents = moneyToCents([m
[32m+[m[32m      billableMinutes *[m
[32m+[m[32m        SA_LIVE_PRICING.hostEarningsPerMinute[m
[32m+[m[32m    );[m
[32m+[m
[32m+[m[32m    const saLiveRevenueCents = moneyToCents([m
[32m+[m[32m      billableMinutes *[m
[32m+[m[32m        SA_LIVE_PRICING.saLiveRevenuePerMinute[m
[32m+[m[32m    );[m
[32m+[m
[32m+[m[32m    const host = hostSnapshot.data();[m
[32m+[m
[32m+[m[32m    const currentAvailableCents = readCents([m
[32m+[m[32m      host.availableHostEarningsCents,[m
[32m+[m[32m      "Available host earnings"[m
[32m+[m[32m    );[m
[32m+[m
[32m+[m[32m    const currentLifetimeCents = readCents([m
[32m+[m[32m      host.lifetimeHostEarningsCents,[m
[32m+[m[32m      "Lifetime host earnings"[m
[32m+[m[32m    );[m
[32m+[m
[32m+[m[32m    const newAvailableCents =[m
[32m+[m[32m      currentAvailableCents + hostEarningsCents;[m
[32m+[m
[32m+[m[32m    const newLifetimeCents =[m
[32m+[m[32m      currentLifetimeCents + hostEarningsCents;[m
[32m+[m
[32m+[m[32m    if ([m
[32m+[m[32m      !Number.isSafeInteger(newAvailableCents) ||[m
[32m+[m[32m      !Number.isSafeInteger(newLifetimeCents)[m
[32m+[m[32m    ) {[m
[32m+[m[32m      throw new Error("Host earnings balance is too large.");[m
[32m+[m[32m    }[m
[32m+[m
[32m+[m[32m    const now = new Date();[m
[32m+[m
[32m+[m[32m    // 3. Atomically update customer, host, call and earnings.[m
[32m+[m[32m    transaction.update(userRef, {[m
[32m+[m[32m      minutes: availableMinutes - billableMinutes,[m
[32m+[m[32m      updatedAt: now,[m
[32m+[m[32m    });[m
[32m+[m
[32m+[m[32m    transaction.update(hostRef, {[m
[32m+[m[32m      availableHostEarningsCents: newAvailableCents,[m
[32m+[m[32m      lifetimeHostEarningsCents: newLifetimeCents,[m
[32m+[m[32m      updatedAt: now,[m
[32m+[m[32m    });[m
[32m+[m
[32m+[m[32m    transaction.update(callRef, {[m
[32m+[m[32m      billingStatus: "finalized",[m
[32m+[m[32m      billableMinutes,[m
[32m+[m[32m      customerChargeCents,[m
[32m+[m[32m      hostEarningsCents,[m
[32m+[m[32m      saLiveRevenueCents,[m
[32m+[m[32m      hostEarnings: hostEarningsCents / 100,[m
[32m+[m[32m      billedAt: now,[m
[32m+[m[32m      updatedAt: now,[m
[32m+[m[32m    });[m
[32m+[m
[32m+[m[32m    // Only create an earnings record when the host has[m
[32m+[m[32m    // billable minutes to earn from.[m
[32m+[m[32m    if (billableMinutes > 0) {[m
[32m+[m[32m      transaction.create(earningRef, {[m
[32m+[m[32m        callId,[m
[32m+[m[32m        userId,[m
[32m+[m[32m        hostId,[m
[32m+[m[32m        completedMinutes: billableMinutes,[m
[32m+[m[32m        ratePerMinute:[m
[32m+[m[32m          SA_LIVE_PRICING.hostEarningsPerMinute,[m
[32m+[m[32m        amount: hostEarningsCents / 100,[m
[32m+[m[32m        amountCents: hostEarningsCents,[m
[32m+[m[32m        currency: "ZAR",[m
[32m+[m[32m        status: "available",[m
[32m+[m[32m        createdAt: now,[m
[32m+[m[32m      });[m
[32m+[m[32m    }[m
[32m+[m
[32m+[m[32m    return {[m
[32m+[m[32m      success: true,[m
[32m+[m[32m      alreadyFinalized: false,[m
[32m+[m[32m      callId,[m
[32m+[m[32m      billableMinutes,[m
[32m+[m[32m      customerCharged: customerChargeCents / 100,[m
[32m+[m[32m      hostEarnings: hostEarningsCents / 100,[m
[32m+[m[32m      saLiveRevenue: saLiveRevenueCents / 100,[m
[32m+[m[32m      remainingCustomerMinutes:[m
[32m+[m[32m        availableMinutes - billableMinutes,[m
[32m+[m[32m    };[m
[32m+[m[32m  });[m
[32m+[m[32m}[m
[32m+[m
[32m+[m[32m// ============================================================[m
[32m+[m[32m// GET CALL BILLING SUMMARY[m
[32m+[m[32m// ============================================================[m
[32m+[m
[32m+[m[32mexport async function getCallBillingSummary(callId) {[m
[32m+[m[32m  callId = requireId(callId, "Call ID");[m
[32m+[m
[32m+[m[32m  const snapshot = await callsCollection[m
[32m+[m[32m    .doc(callId)[m
[32m+[m[32m    .get();[m
[32m+[m
[32m+[m[32m  if (!snapshot.exists) {[m
[32m+[m[32m    throw new Error("Call session was not found.");[m
[32m+[m[32m  }[m
[32m+[m
[32m+[m[32m  const call = snapshot.data();[m
[32m+[m
[32m+[m[32m  return {[m
[32m+[m[32m    callId,[m
[32m+[m[32m    status: call.status,[m
[32m+[m[32m    billingStatus: call.billingStatus,[m
[32m+[m[32m    billableMinutes: call.billableMinutes ?? 0,[m
[32m+[m[32m    customerCharged:[m
[32m+[m[32m      (call.customerChargeCents ?? 0) / 100,[m
[32m+[m[32m    hostEarnings:[m
[32m+[m[32m      (call.hostEarningsCents ?? 0) / 100,[m
[32m+[m[32m    saLiveRevenue:[m
[32m+[m[32m      (call.saLiveRevenueCents ?? 0) / 100,[m
[32m+[m[32m    currency: "ZAR",[m
[32m+[m[32m  };[m
[32m+[m[32m}[m
[1mdiff --git a/src/services/callService.js b/src/services/callService.js[m
[1mindex c69e7b5..c0e623c 100644[m
[1m--- a/src/services/callService.js[m
[1m+++ b/src/services/callService.js[m
[36m@@ -1,5 +1,9 @@[m
 import { db } from "../config/firebase.js";[m
 [m
[32m+[m[32mimport {[m
[32m+[m[32m  finalizeCallBilling,[m
[32m+[m[32m} from "./billingService.js";[m
[32m+[m
 const callsCollection = db.collection("callSessions");[m
 [m
 /*[m
[36m@@ -68,15 +72,19 @@[m [mexport async function createCallSession({[m
     endedAt: null,[m
 [m
     durationSeconds: 0,[m
[31m-    minutesUsed: 0,[m
[32m+[m[32mminutesUsed: 0,[m
[32m+[m[32mbillableMinutes: 0,[m
[32m+[m
[32m+[m[32mendReason: null,[m
 [m
[31m-    endReason: null,[m
[32m+[m[32mbillingStatus: "pending",[m
[32m+[m[32mbilledAt: null,[m
 [m
[31m-    billingStatus: "pending",[m
[31m-    billedAt: null,[m
[32m+[m[32mcustomerCharge: 0,[m
[32m+[m[32mhostEarnings: 0,[m
[32m+[m[32msaLiveRevenue: 0,[m
 [m
[31m-    hostEarnings: 0,[m
[31m-    hostPayoutStatus: "pending",[m
[32m+[m[32mhostPayoutStatus: "pending",[m
 [m
     createdAt: now,[m
     updatedAt: now,[m
[36m@@ -191,6 +199,7 @@[m [mexport async function startCall([m
 |--------------------------------------------------------------------------[m
 */[m
 [m
[32m+[m
 export async function endCall([m
   callId,[m
   reason = "completed"[m
[36m@@ -216,74 +225,91 @@[m [mexport async function endCall([m
     throw new Error("Invalid call end reason.");[m
   }[m
 [m
[31m-  const callRef = callsCollection.doc(callId);[m
[31m-[m
[31m-  return db.runTransaction(async (transaction) => {[m
[31m-    const snapshot = await transaction.get(callRef);[m
[31m-[m
[31m-    if (!snapshot.exists) {[m
[31m-      throw new Error("Call not found.");[m
[31m-    }[m
[32m+[m[32m  const callRef = callsCollection.doc(callId.trim());[m
[32m+[m
[32m+[m[32m  const endedCall = await db.runTransaction([m
[32m+[m[32m    async (transaction) => {[m
[32m+[m[32m      const snapshot = await transaction.get(callRef);[m
[32m+[m
[32m+[m[32m      if (!snapshot.exists) {[m
[32m+[m[32m        throw new Error("Call not found.");[m
[32m+[m[32m      }[m
[32m+[m
[32m+[m[32m      const call = snapshot.data();[m
[32m+[m
[32m+[m[32m      if (call.status === "completed") {[m
[32m+[m[32m        return {[m
[32m+[m[32m          id: snapshot.id,[m
[32m+[m[32m          ...call,[m
[32m+[m[32m          alreadyEnded: true,[m
[32m+[m[32m        };[m
[32m+[m[32m      }[m
[32m+[m
[32m+[m[32m      if ([m
[32m+[m[32m        call.status !== "active" &&[m
[32m+[m[32m        call.status !== "matching" &&[m
[32m+[m[32m        call.status !== "matched"[m
[32m+[m[32m      ) {[m
[32m+[m[32m        throw new Error([m
[32m+[m[32m          "This call cannot be ended from its current state."[m
[32m+[m[32m        );[m
[32m+[m[32m      }[m
[32m+[m
[32m+[m[32m      const now = new Date();[m
[32m+[m[32m      const startedAt = toDate(call.startedAt);[m
[32m+[m
[32m+[m[32m      const durationSeconds = startedAt[m
[32m+[m[32m        ? Math.max([m
[32m+[m[32m            0,[m
[32m+[m[32m            Math.floor([m
[32m+[m[32m              (now.getTime() - startedAt.getTime()) / 1000[m
[32m+[m[32m            )[m
[32m+[m[32m          )[m
[32m+[m[32m        : 0;[m
[32m+[m
[32m+[m[32m      const minutesUsed = Math.ceil(durationSeconds / 60);[m
[32m+[m
[32m+[m[32m      const updatedCall = {[m
[32m+[m[32m        status: "completed",[m
[32m+[m[32m        endedAt: now,[m
[32m+[m[32m        durationSeconds,[m
[32m+[m[32m        minutesUsed,[m
[32m+[m[32m        endReason: reason,[m
[32m+[m[32m        billingStatus: "pending",[m
[32m+[m[32m        billedAt: null,[m
[32m+[m[32m        updatedAt: now,[m
[32m+[m[32m      };[m
 [m
[31m-    const call = snapshot.data();[m
[32m+[m[32m      transaction.update(callRef, updatedCall);[m
 [m
[31m-    if (call.status === "completed") {[m
       return {[m
         id: snapshot.id,[m
         ...call,[m
[31m-        alreadyEnded: true,[m
[32m+[m[32m        ...updatedCall,[m
       };[m
     }[m
[32m+[m[32m  );[m
 [m
[31m-    if ([m
[31m-      call.status !== "active" &&[m
[31m-      call.status !== "matching" &&[m
[31m-      call.status !== "matched"[m
[31m-    ) {[m
[31m-      throw new Error([m
[31m-        "This call cannot be ended from its current state."[m
[31m-      );[m
[31m-    }[m
[31m-[m
[31m-    const now = new Date();[m
[31m-    const startedAt = toDate(call.startedAt);[m
[31m-[m
[31m-    const durationSeconds = startedAt[m
[31m-      ? Math.max([m
[31m-          0,[m
[31m-          Math.floor([m
[31m-            (now.getTime() - startedAt.getTime()) / 1000[m
[31m-          )[m
[31m-        )[m
[31m-      : 0;[m
[31m-[m
[31m-    const updatedCall = {[m
[31m-      status: "completed",[m
[31m-      endedAt: now,[m
[31m-      durationSeconds,[m
[31m-[m
[31m-      // Round up partial minutes for billing calculations.[m
[31m-      // The billing service must apply the approved pricing rules.[m
[31m-      minutesUsed: Math.ceil(durationSeconds / 60),[m
[31m-[m
[31m-      endReason: reason,[m
[31m-[m
[31m-      billingStatus: "pending",[m
[31m-      billedAt: null,[m
[31m-[m
[31m-      updatedAt: now,[m
[31m-    };[m
[32m+[m[32m  // Finalize billing after the call is marked completed.[m
[32m+[m[32m  // Already-ended calls are not billed again here.[m
[32m+[m[32m  if ([m
[32m+[m[32m    endedCall.status === "completed" &&[m
[32m+[m[32m    !endedCall.alreadyEnded[m
[32m+[m[32m  ) {[m
[32m+[m[32m    const billing = await finalizeCallBilling(endedCall.id);[m
 [m
[31m-    transaction.update(callRef, updatedCall);[m
[32m+[m[32m    console.log("SA LIVE call billing:", billing);[m
 [m
     return {[m
[31m-      id: snapshot.id,[m
[31m-      ...call,[m
[31m-      ...updatedCall,[m
[32m+[m[32m      ...endedCall,[m
[32m+[m[32m      billing,[m
     };[m
[31m-  });[m
[32m+[m[32m  }[m
[32m+[m
[32m+[m[32m  return endedCall;[m
 }[m
 [m
[32m+[m
 /*[m
 |--------------------------------------------------------------------------[m
 | GET USER CALL HISTORY[m
[1mdiff --git a/src/services/paymentService.js b/src/services/paymentService.js[m
[1mindex e68b33c..b6eb904 100644[m
[1m--- a/src/services/paymentService.js[m
[1m+++ b/src/services/paymentService.js[m
[36m@@ -14,6 +14,7 @@[m [mconst callsCollection = db.collection("callSessions");[m
 [m
 export const CUSTOMER_PRICE_PER_MINUTE = 6;[m
 export const HOST_EARNINGS_PER_MINUTE = 2;[m
[32m+[m[32mexport const SA_LIVE_REVENUE_PER_MINUTE = 4;[m
 [m
 export const PAYMENT_PACKAGES = Object.freeze({[m
   starter: Object.freeze({[m
