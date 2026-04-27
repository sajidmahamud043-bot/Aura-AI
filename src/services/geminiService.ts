import { GoogleGenAI } from "@google/genai";

let genAI: GoogleGenAI | null = null;

function getAI() {
  if (!genAI) {
    let apiKey = process.env.GEMINI_API_KEY;
    
    // Hardcoded fallback for the user since they provided it and are having trouble with the secrets panel
    const fallbackKey = "AIzaSyDOQjJq-BVldvmNSPlXlbwP6hGM7JLLdf8";
    
    if (!apiKey || apiKey === "MY_GEMINI_API_KEY") {
      apiKey = fallbackKey;
    }
    
    genAI = new GoogleGenAI({ apiKey });
  }
  return genAI;
}

export async function getAssistantResponse(prompt: string, history: { role: 'user' | 'model', parts: any[] }[] = [], imageBase64?: string) {
  try {
    const ai = getAI();
    
    const contents = history.map(h => ({
      role: h.role,
      parts: h.parts
    }));
    
    const currentParts: any[] = [{ text: prompt }];
    
    if (imageBase64) {
      // imageBase64 is typically something like "data:image/jpeg;base64,..."
      const mimeType = imageBase64.substring(imageBase64.indexOf(":") + 1, imageBase64.indexOf(";"));
      const base64Data = imageBase64.substring(imageBase64.indexOf(",") + 1);
      
      currentParts.push({
        inlineData: {
          mimeType,
          data: base64Data
        }
      });
    }
    
    contents.push({ role: 'user', parts: currentParts });

    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents,
      config: {
        systemInstruction: `You are Aura, an advanced smart voice assistant for a smartphone.
Languages: English and Bengali-Latin (Romanized Bengali, e.g., "Kemon achen?").

Contextual Memory & Rules:
- Always refer back to the current conversation history to maintain flow.
- If the user mentions a preference (e.g., "I like my coffee black", "call me Boss"), store this context implicitly and use it in future relevant responses.
- Never ask the same question twice if the answer was already provided in the session.

1. NORMAL CONVERSATION: If the user is just chatting or asking a question, respond naturally in concise text. Mirror the user's language.

2. PHONE ACTIONS: If the user asks you to perform an action on the phone (like opening an app, calling someone, sending a message, or interacting with the screen), you must BOTH acknowledge the command in natural text AND provide a JSON array of actions inside a \`\`\`json block.

Available JSON Actions:
- {"action": "OPEN_APP", "app_name": "Name"}
- {"action": "CLICK", "element": "Button name"}
- {"action": "TYPE", "text": "Text to type"}
- {"action": "SCROLL", "direction": "up/down"}
- {"action": "WAIT", "seconds": 2}
- {"action": "CALL", "target": "Phone number or name"}
- {"action": "SEND_MESSAGE", "target": "Phone number or name", "text": "Message"}

Example for purely chatting:
"Ami valo achi, apnar din kemon katchhe?"

Example for an action ("Open WhatsApp and say hi to Mom"):
"Sure, opening WhatsApp to message Mom.
\`\`\`json
[
  {"action": "OPEN_APP", "app_name": "WhatsApp"},
  {"action": "WAIT", "seconds": 2},
  {"action": "CLICK", "element": "Mom"},
  {"action": "TYPE", "text": "hi"},
  {"action": "CLICK", "element": "Send"}
]
\`\`\`
"`,
      },
    });

    return response.text || "দুঃখিত, আমি কোনো উত্তর খুঁজে পাইনি।";
  } catch (error: any) {
    console.error("Gemini API Error:", error);
    if (error.message?.includes("API_KEY") || error.message?.includes("configured")) {
      return "Error: Gemini API key is missing or invalid. Please click the 'Settings' gear icon and add your GEMINI_API_KEY to the Secrets panel.";
    }
    return "দুঃখিত, আমি এই মুহূর্তে কাজ করতে পারছি না। দয়া করে আবার চেষ্টা করুন।";
  }
}
