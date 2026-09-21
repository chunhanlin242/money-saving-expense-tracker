// 國家清單。歐洲為主（實際會走的路線），加上常去的亞洲與轉機點。
//
// currency 是該國「預設」幣別，用來在切換國家時順手把幣別也帶過去。
// 反過來由幣別推國家只在一對一時才做 —— 歐元區有 20 國，猜不得。

export const COUNTRIES = [
  // 英國與愛爾蘭
  { code: "GB", flag: "🇬🇧", name: "英國",       currency: "GBP" },
  { code: "IE", flag: "🇮🇪", name: "愛爾蘭",     currency: "EUR" },

  // 西歐
  { code: "FR", flag: "🇫🇷", name: "法國",       currency: "EUR" },
  { code: "DE", flag: "🇩🇪", name: "德國",       currency: "EUR" },
  { code: "NL", flag: "🇳🇱", name: "荷蘭",       currency: "EUR" },
  { code: "BE", flag: "🇧🇪", name: "比利時",     currency: "EUR" },
  { code: "LU", flag: "🇱🇺", name: "盧森堡",     currency: "EUR" },
  { code: "CH", flag: "🇨🇭", name: "瑞士",       currency: "CHF" },
  { code: "AT", flag: "🇦🇹", name: "奧地利",     currency: "EUR" },

  // 南歐
  { code: "ES", flag: "🇪🇸", name: "西班牙",     currency: "EUR" },
  { code: "PT", flag: "🇵🇹", name: "葡萄牙",     currency: "EUR" },
  { code: "IT", flag: "🇮🇹", name: "義大利",     currency: "EUR" },
  { code: "GR", flag: "🇬🇷", name: "希臘",       currency: "EUR" },
  { code: "MT", flag: "🇲🇹", name: "馬爾他",     currency: "EUR" },
  { code: "HR", flag: "🇭🇷", name: "克羅埃西亞", currency: "EUR" },
  { code: "SI", flag: "🇸🇮", name: "斯洛維尼亞", currency: "EUR" },

  // 北歐
  { code: "SE", flag: "🇸🇪", name: "瑞典",       currency: "SEK" },
  { code: "NO", flag: "🇳🇴", name: "挪威",       currency: "NOK" },
  { code: "DK", flag: "🇩🇰", name: "丹麥",       currency: "DKK" },
  { code: "FI", flag: "🇫🇮", name: "芬蘭",       currency: "EUR" },
  { code: "IS", flag: "🇮🇸", name: "冰島",       currency: "ISK" },
  { code: "EE", flag: "🇪🇪", name: "愛沙尼亞",   currency: "EUR" },
  { code: "LV", flag: "🇱🇻", name: "拉脫維亞",   currency: "EUR" },
  { code: "LT", flag: "🇱🇹", name: "立陶宛",     currency: "EUR" },

  // 中東歐
  { code: "CZ", flag: "🇨🇿", name: "捷克",       currency: "CZK" },
  { code: "PL", flag: "🇵🇱", name: "波蘭",       currency: "PLN" },
  { code: "HU", flag: "🇭🇺", name: "匈牙利",     currency: "HUF" },
  { code: "SK", flag: "🇸🇰", name: "斯洛伐克",   currency: "EUR" },
  { code: "RO", flag: "🇷🇴", name: "羅馬尼亞",   currency: "RON" },
  { code: "BG", flag: "🇧🇬", name: "保加利亞",   currency: "BGN" },
  { code: "RS", flag: "🇷🇸", name: "塞爾維亞",   currency: "RSD" },
  { code: "UA", flag: "🇺🇦", name: "烏克蘭",     currency: "UAH" },
  { code: "TR", flag: "🇹🇷", name: "土耳其",     currency: "TRY" },
  { code: "GE", flag: "🇬🇪", name: "喬治亞",     currency: "GEL" },

  // 亞洲與其他
  { code: "TW", flag: "🇹🇼", name: "台灣",       currency: "TWD" },
  { code: "JP", flag: "🇯🇵", name: "日本",       currency: "JPY" },
  { code: "KR", flag: "🇰🇷", name: "韓國",       currency: "KRW" },
  { code: "HK", flag: "🇭🇰", name: "香港",       currency: "HKD" },
  { code: "SG", flag: "🇸🇬", name: "新加坡",     currency: "SGD" },
  { code: "TH", flag: "🇹🇭", name: "泰國",       currency: "THB" },
  { code: "MY", flag: "🇲🇾", name: "馬來西亞",   currency: "MYR" },
  { code: "VN", flag: "🇻🇳", name: "越南",       currency: "VND" },
  { code: "AE", flag: "🇦🇪", name: "阿聯",       currency: "AED" },
  { code: "US", flag: "🇺🇸", name: "美國",       currency: "USD" },
  { code: "CA", flag: "🇨🇦", name: "加拿大",     currency: "CAD" },
  { code: "AU", flag: "🇦🇺", name: "澳洲",       currency: "AUD" },
  { code: "NZ", flag: "🇳🇿", name: "紐西蘭",     currency: "NZD" },
  { code: "MA", flag: "🇲🇦", name: "摩洛哥",     currency: "MAD" },
  { code: "EG", flag: "🇪🇬", name: "埃及",       currency: "EGP" },
  { code: "IL", flag: "🇮🇱", name: "以色列",     currency: "ILS" },
];

const BY_CODE = Object.fromEntries(COUNTRIES.map((c) => [c.code, c]));

export function country(code) {
  return BY_CODE[code] || null;
}

export function flagOf(code) {
  return BY_CODE[code]?.flag || "";
}

export function nameOf(code) {
  return BY_CODE[code]?.name || code || "";
}

// 幣別 → 國家，只在該幣別剛好只對應一個國家時才回答。
// 歐元有 20 個國家用，這種情況回 null，讓使用者自己維持目前的國家設定。
const soleUser = {};
for (const c of COUNTRIES) {
  soleUser[c.currency] = soleUser[c.currency] === undefined ? c.code : null;
}

export function countryForCurrency(code) {
  return soleUser[code] || null;
}
