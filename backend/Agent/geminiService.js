/**
 * Google Gemini provider for the MMGIS AI Agent.
 *
 * Uses the Gemini REST API directly — no additional npm dependencies required.
 * Reads GEMINI_API_KEY and GEMINI_MODEL from the environment.
 *
 * Exports:
 *   generateContent(prompt)          → { text: string }
 *   streamContent(prompt, onChunk)   → AsyncGenerator<string>
 */

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_MODEL = "gemini-2.0-flash";

function getConfig() {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL || DEFAULT_MODEL;
  if (!apiKey) {
    throw new Error(
      "Gemini provider: GEMINI_API_KEY environment variable is not set."
    );
  }
  return { apiKey, model };
}

function buildRequest(prompt) {
  return {
    contents: [
      {
        role: "user",
        parts: [{ text: prompt }],
      },
    ],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 8192,
    },
  };
}

/**
 * Send a single prompt and return the full text response.
 *
 * @param {string} prompt
 * @returns {Promise<{ text: string }>}
 */
async function generateContent(prompt) {
  const { apiKey, model } = getConfig();
  const url = `${GEMINI_API_BASE}/${model}:generateContent`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Pass the key in a header, not the query string, so it can't leak into
      // access logs, proxies, or referrers.
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify(buildRequest(prompt)),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Gemini API error ${response.status}: ${body}`
    );
  }

  const data = await response.json();
  const text =
    data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

  if (!text) {
    throw new Error("Gemini returned an empty response.");
  }

  return { text };
}

/**
 * Stream a prompt response, yielding text chunks as they arrive.
 *
 * @param {string} prompt
 * @yields {string} incremental text chunks
 */
async function* streamContent(prompt) {
  const { apiKey, model } = getConfig();
  const url = `${GEMINI_API_BASE}/${model}:streamGenerateContent?alt=sse`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Pass the key in a header, not the query string, so it can't leak into
      // access logs, proxies, or referrers.
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify(buildRequest(prompt)),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Gemini stream API error ${response.status}: ${body}`
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop(); // keep incomplete last line

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const json = line.slice("data: ".length).trim();
      if (!json || json === "[DONE]") continue;
      try {
        const chunk = JSON.parse(json);
        const text = chunk?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) yield text;
      } catch {
        // malformed SSE chunk — skip
      }
    }
  }
}

module.exports = { generateContent, streamContent };
