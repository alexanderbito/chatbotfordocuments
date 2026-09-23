/**
 * Best-effort language detection for the question a person just typed.
 *
 * Why it exists: the answer should come back in the language the question was
 * asked in. Telling the model "reply in the same language as the question" alone
 * is unreliable, because the retrieved documents sit in the same prompt and
 * often pull the model towards their language instead. Naming the language
 * explicitly in the system prompt is far more stable.
 *
 * This is deliberately not a full language-identification library. It covers
 * the cases that can be decided with confidence from a single short sentence:
 * distinctive scripts, and a handful of Latin-script languages identified by
 * function words that rarely appear in the others. Anything it is unsure about
 * returns null, and the model is then simply asked to mirror the question.
 */

/** Scripts that identify a language on sight. Order matters: first hit wins. */
const SCRIPTS = [
  // Vietnamese goes first, but ONLY on characters no other common Latin-script
  // language uses: the horn vowels, đ, and every vowel carrying a dot below, a
  // hook above, or a stacked tone mark. Plain à á è é â ê ô ã õ are deliberately
  // left out — Spanish "días" and French "congés" would otherwise be read as
  // Vietnamese. Unaccented Vietnamese is caught by the stopword pass below.
  { name: 'Vietnamese', code: 'vi', re: /[ăđơưạảẹẻẽịỉĩọỏụủũỵỷỹầấậẩẫằắặẳẵềếệểễồốộổỗờớợởỡừứựửữỳ]/i },
  { name: 'Japanese',   code: 'ja', re: /[぀-ゟ゠-ヿ]/ },
  { name: 'Korean',     code: 'ko', re: /[가-힯ᄀ-ᇿ]/ },
  { name: 'Chinese',    code: 'zh', re: /[一-鿿]/ },
  { name: 'Thai',       code: 'th', re: /[฀-๿]/ },
  { name: 'Arabic',     code: 'ar', re: /[؀-ۿ]/ },
  { name: 'Hebrew',     code: 'he', re: /[֐-׿]/ },
  { name: 'Greek',      code: 'el', re: /[Ͱ-Ͽ]/ },
  { name: 'Hindi',      code: 'hi', re: /[ऀ-ॿ]/ },
  { name: 'Russian',    code: 'ru', re: /[Ѐ-ӿ]/ },
];

/**
 * Function words for Latin-script languages. These are words that carry no
 * topic meaning, so they appear in almost any sentence of that language while
 * being rare in the others. A question has to hit at least two of them before
 * the guess is trusted, which keeps a stray loan word from deciding the answer.
 */
const STOPWORDS = {
  // Listed without diacritics because the comparison strips them, which also
  // catches Vietnamese typed without tone marks — very common in practice.
  Vietnamese: ['khong', 'nhung', 'duoc', 'nhieu', 'the', 'nao', 'cong', 'viec', 'phai', 'cua', 'gi', 'bao', 'xin', 'chao', 'toi', 'minh'],
  Spanish:    ['que', 'los', 'las', 'del', 'para', 'como', 'cuando', 'donde', 'porque', 'esta', 'cual', 'nuestro'],
  French:     ['que', 'les', 'des', 'pour', 'comment', 'quand', 'quel', 'quelle', 'pourquoi', 'notre', 'avec', 'dans'],
  German:     ['der', 'die', 'das', 'und', 'ist', 'wie', 'wann', 'warum', 'welche', 'unsere', 'nicht', 'mit'],
  Portuguese: ['que', 'para', 'como', 'quando', 'onde', 'porque', 'nossa', 'nosso', 'qual', 'das', 'dos', 'nao', 'uma', 'sao', 'politica', 'ferias'],
  Italian:    ['che', 'per', 'come', 'quando', 'dove', 'perche', 'nostra', 'nostro', 'nostri', 'quale', 'quanti', 'della', 'degli', 'giorni', 'sono', 'non'],
  Indonesian: ['yang', 'dan', 'untuk', 'bagaimana', 'kapan', 'dimana', 'kami', 'kita', 'adalah', 'tidak', 'dengan', 'apa'],
};

const MIN_HITS = 2;

/**
 * @param {string} text the person's question
 * @returns {{ name: string, code: string } | null} null when not confident
 */
export function detectLanguage(text) {
  const s = String(text || '').trim();
  if (s.length < 2) return null;

  for (const { name, code, re } of SCRIPTS) {
    if (re.test(s)) return { name, code };
  }

  // Latin script: decide on function words, comparing against every candidate
  // so that a language is only chosen when it clearly beats the others.
  const words = s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z]+/)
    .filter(Boolean);
  if (!words.length) return null;

  const scores = Object.entries(STOPWORDS)
    .map(([name, list]) => [name, words.filter((w) => list.includes(w)).length])
    .filter(([, n]) => n >= MIN_HITS)
    .sort((a, b) => b[1] - a[1]);

  if (!scores.length) return null;
  // A tie between two languages is not a confident answer.
  if (scores.length > 1 && scores[0][1] === scores[1][1]) return null;

  const name = scores[0][0];
  const code = { Vietnamese: 'vi', Spanish: 'es', French: 'fr', German: 'de', Portuguese: 'pt', Italian: 'it', Indonesian: 'id' }[name];
  return { name, code };
}

/**
 * "Nothing found in your documents" in the languages detectLanguage can name.
 * Shown without calling the model at all, so it has to be translated here.
 */
const NOT_FOUND = {
  en: 'I could not find anything relevant in the documents you have access to.',
  vi: 'Tôi không tìm thấy thông tin liên quan trong những tài liệu bạn được phép truy cập.',
  ja: 'アクセスできる文書の中に、関連する情報は見つかりませんでした。',
  ko: '접근 권한이 있는 문서에서 관련된 내용을 찾지 못했습니다.',
  zh: '在您有权访问的文档中没有找到相关内容。',
  th: 'ไม่พบข้อมูลที่เกี่ยวข้องในเอกสารที่คุณมีสิทธิ์เข้าถึง',
  ar: 'لم أعثر على أي معلومات ذات صلة في المستندات المتاحة لك.',
  he: 'לא מצאתי מידע רלוונטי במסמכים שיש לך גישה אליהם.',
  el: 'Δεν βρήκα σχετικές πληροφορίες στα έγγραφα στα οποία έχετε πρόσβαση.',
  hi: 'आपके पास जिन दस्तावेज़ों तक पहुँच है, उनमें मुझे कोई प्रासंगिक जानकारी नहीं मिली।',
  ru: 'Я не нашёл подходящей информации в документах, к которым у вас есть доступ.',
  es: 'No encontré información relevante en los documentos a los que tienes acceso.',
  fr: "Je n'ai trouvé aucune information pertinente dans les documents auxquels vous avez accès.",
  de: 'In den Dokumenten, auf die Sie Zugriff haben, habe ich nichts Passendes gefunden.',
  pt: 'Não encontrei informações relevantes nos documentos a que você tem acesso.',
  it: 'Non ho trovato informazioni pertinenti nei documenti a cui hai accesso.',
  id: 'Saya tidak menemukan informasi yang relevan dalam dokumen yang dapat Anda akses.',
};

/**
 * The "nothing found" reply, in the language of the question when known.
 * @param {string} question
 * @param {string} [forced] a language name from BOT_REPLY_LANGUAGE, when pinned
 */
export function notFoundMessage(question, forced) {
  if (forced) {
    const byName = Object.entries({
      English: 'en', Vietnamese: 'vi', Japanese: 'ja', Korean: 'ko', Chinese: 'zh',
      Thai: 'th', Arabic: 'ar', Hebrew: 'he', Greek: 'el', Hindi: 'hi', Russian: 'ru',
      Spanish: 'es', French: 'fr', German: 'de', Portuguese: 'pt', Italian: 'it', Indonesian: 'id',
    }).find(([name]) => name.toLowerCase() === String(forced).trim().toLowerCase());
    return NOT_FOUND[byName?.[1]] || NOT_FOUND.en;
  }
  const hit = detectLanguage(question);
  return NOT_FOUND[hit?.code] || NOT_FOUND.en;
}

/**
 * Reads BOT_REPLY_LANGUAGE.
 * @returns {string|null} a pinned language name, or null for automatic matching
 */
export function forcedReplyLanguage() {
  const v = String(process.env.BOT_REPLY_LANGUAGE || 'auto').trim();
  if (!v || v.toLowerCase() === 'auto') return null;
  return v;
}
