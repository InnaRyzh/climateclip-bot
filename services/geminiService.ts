import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

export const generateNewsTickers = async (topic: string): Promise<string[]> => {
  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: `Напиши 3 коротких, сенсационных новостных заголовка (бегущая строка) о климатическом происшествии на тему: "${topic}". 
      Заголовки должны быть на русском языке, без кавычек, каждый с новой строки. Максимум 6-8 слов в заголовке.`,
    });

    const text = response.text || '';
    const lines = text.split('\n').filter(line => line.trim().length > 0).slice(0, 3);
    
    // Fallback if AI fails to return 3 lines
    while (lines.length < 3) {
      lines.push('Срочные новости: климатические изменения');
    }
    return lines;
  } catch (error) {
    console.error("Gemini Error:", error);
    return [
      "Природная аномалия зафиксирована",
      "Экстренное предупреждение служб",
      "Последствия стихии устраняются"
    ];
  }
};
