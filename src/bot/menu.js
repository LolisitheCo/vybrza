export function mainMenu() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "🔐 Request Verification",
            callback_data: "request_verification",
          },
        ],
        [
          {
            text: "📞 Find Someone",
            callback_data: "find_someone",
          },
        ],
        [
          {
            text: "💳 Buy Minutes",
            callback_data: "buy_minutes",
          },
        ],
        [
          {
            text: "👤 My Profile",
            callback_data: "profile",
          },
          {
            text: "💰 My Balance",
            callback_data: "balance",
          },
        ],
        [
          {
            text: "📋 Call History",
            callback_data: "call_history",
          },
        ],
      ],
    },
  };
}

export function backToMenuKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "⬅️ Back to Main Menu",
            callback_data: "back_to_main",
          },
        ],
      ],
    },
  };
}