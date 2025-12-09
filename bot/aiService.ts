import { config } from 'dotenv';
config();

const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY;
const HAS_PERPLEXITY = Boolean(PERPLEXITY_API_KEY);

const FETCH_TIMEOUT_MS = 6000;
const MAX_AI_WORDS = 26;
const AI_RETRIES = 2;

function capitalizeFirst(str: string) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function normalizeBlock(raw: string) {
  const trimmed = (raw || '').trim();
  if (!trimmed) return '';
  const words = trimmed.split(/\s+/).slice(0, MAX_AI_WORDS);
  let sentence = words.join(' ');
  if (!/[.!?…]$/.test(sentence)) {
    sentence = sentence + '.';
  }
  return capitalizeFirst(sentence);
}

async function fetchWithTimeout(url: string, opts: any, timeout = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(id);
  }
}

function tryParseArray(raw: string): string[] | null {
  if (!raw) return null;
  let cleaned = raw.trim();
  // Убираем обёртки ```json ... ```
  const codeFenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (codeFenceMatch) {
    cleaned = codeFenceMatch[1].trim();
  }
  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed) && parsed.length >= 3) return parsed.slice(0, 3);
  } catch {
    // fallback: попробовать разбить по переводам строк или точкам
    const parts = cleaned
      .split(/\n+/)
      .map(s => s.trim())
      .filter(Boolean);
    if (parts.length >= 3) return parts.slice(0, 3);
    const dotParts = cleaned.split(/[.!?]+/).map(s => s.trim()).filter(Boolean);
    if (dotParts.length >= 3) return dotParts.slice(0, 3);
  }
  return null;
}

async function tryPerplexity(text: string): Promise<string[] | null> {
  if (!HAS_PERPLEXITY) {
    console.warn('AI: PERPLEXITY_API_KEY отсутствует, используем фолбэк.');
    return null;
  }

  try {
    for (let attempt = 1; attempt <= AI_RETRIES; attempt++) {
      try {
        console.log(`AI: Perplexity call attempt ${attempt}`);
        const response = await fetchWithTimeout('https://api.perplexity.ai/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${PERPLEXITY_API_KEY}`,
            'Accept': 'application/json'
          },
          body: JSON.stringify({
            model: 'sonar-pro',
            max_tokens: 800,
            temperature: 0.2,
            messages: [
              {
                role: 'system',
                content: [
                  'Ты редактор новостной ленты. Перепиши исходный текст по-русски в 3 полных абзаца-хронологию по 20–25 слов (допустимо 18–26).',
                  'Сохраняй факты, числа, даты, локации и порядок событий. Не добавляй ничего нового. Не сокращай ключевые детали.',
                  'Пиши нейтрально и ясно, без метафор, без оценок, без клише. Используй цельные предложения без обрывов, без переносов и незаконченных фраз.',
                  'По возможности конкретизируй субъект вместо местоимений. Избегай перечислений без связки, делай связный текст.',
                  'Верни ТОЛЬКО JSON-массив из трёх строк вида ["...", "...", "..."] без пояснений и без форматирования Markdown.'
                ].join(' ')
              },
              { role: 'user', content: text }
            ]
          })
        });

        if (!response.ok) {
          console.error('Perplexity HTTP error', response.status, await response.text());
          continue;
        }

        const data: any = await response.json();
        const rawContent = data?.choices?.[0]?.message?.content?.trim();
        console.log(`Perplexity raw content (attempt ${attempt}):`, rawContent?.slice(0, 200));

        const parsedArr = tryParseArray(rawContent || '');
        if (!parsedArr) continue;
        const normalized = parsedArr.map((s: string) => normalizeBlock(s));
        return normalized;
      } catch (err) {
        console.error(`Perplexity attempt ${attempt} error`, err);
        if (attempt === AI_RETRIES) throw err;
      }
    }
    return null;
  } catch (err) {
    console.error('Perplexity error', err);
    return null;
  }
}

export async function rewriteNewsText(text: string): Promise<string[]> {
  const cleanText = text.replace(/\s+/g, ' ').trim();
  if (!cleanText) return ['', '', ''];

  // Пробуем Perplexity
  const ai = await tryPerplexity(cleanText);
  if (ai && ai.length === 3) {
    const lens = ai.map(p => p.split(' ').filter(Boolean).length);
    console.log('Perplexity success, lengths:', lens);
    return ai.map(normalizeBlock);
  }

  // Надёжный алгоритмический фоллбек: равномерное деление в 3 части, целимся в ~23 слова
  const words = cleanText.split(' ').filter(Boolean);
  const total = words.length;

  if (total === 0) return ['', '', ''];

  const target = 23;
  // Если текст короткий — равномерно
  if (total <= target * 3) {
    const base = Math.floor(total / 3);
    const rem = total % 3;
    const sizes = [
      base + (rem > 0 ? 1 : 0),
      base + (rem > 1 ? 1 : 0),
      base
    ];
    console.log('Fallback split short, lengths:', sizes);
    return [
      words.slice(0, sizes[0]).join(' '),
      words.slice(sizes[0], sizes[0] + sizes[1]).join(' '),
      words.slice(sizes[0] + sizes[1]).join(' ')
    ].map(capitalizeFirst);
  }

  // Длинный текст: делим равномерно, чтобы покрыть весь текст
  const base = Math.floor(total / 3);
  const rem = total % 3;
  const size1 = base + (rem > 0 ? 1 : 0);
  const size2 = base + (rem > 1 ? 1 : 0);
  const size3 = total - size1 - size2;

  const blocks = [
    words.slice(0, size1).join(' '),
    words.slice(size1, size1 + size2).join(' '),
    words.slice(size1 + size2).join(' ')
  ];

  const normalized = blocks.map(normalizeBlock);
  console.log('Fallback split, lengths:', normalized.map(b => b.split(' ').filter(Boolean).length));
  return normalized;
}

