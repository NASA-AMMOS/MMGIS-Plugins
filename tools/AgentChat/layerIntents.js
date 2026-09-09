// Detects deterministic, config-driven layer questions so they can be
// answered directly from the live layer index (renderers.js:
// buildLayersLineText / buildAnalyzableLayersText) instead of round-tripping
// through the LLM — no generative reasoning is needed to answer "what
// layers exist" or "which layers are analyzable", and the answer always
// comes from the actual current mission config, never a hardcoded list of
// layer names.

// Matches the direct command and its common paraphrases ("what layers are
// available?", "available data layers", "what datasets are available?").
export function detectListLayersIntent(text) {
    if (!text || typeof text !== 'string') return false
    const lower = text.trim().toLowerCase()
    return (
        /^(list|show|display)\s+(the\s+)?(available\s+)?layers\b/.test(lower) ||
        /\b(what|which)\s+layers?\s+(are\s+)?(available|exist|can\s+i\s+see)\b/.test(lower) ||
        /\bavailable\s+(data\s+)?layers\b/.test(lower) ||
        /\bwhat\s+datasets?\s+are\s+available\b/.test(lower)
    )
}

// Matches "which layers can I analyze", "what data supports
// analytics/analysis", and "show me the layers I can calculate statistics
// for" — the actual analyzable/reference classification is derived live
// from each layer's config (STAC/COG/local-data vs. plain reference
// imagery), not a hardcoded list.
export function detectAnalyzableLayersIntent(text) {
    if (!text || typeof text !== 'string') return false
    const lower = text.trim().toLowerCase()
    return (
        /\b(which|what)\s+layers?\s+can\s+i\s+analyz/.test(lower) ||
        /\banalyzable\s+layers?\b/.test(lower) ||
        /\bwhat\s+(data(sets)?|layers?)\s+support(s)?\s+(analysis|analytics|statistics)\b/.test(lower) ||
        /\bwhich\s+layers?\s+(support|can\s+be\s+used\s+for)\s+(analysis|statistics|calculations?)\b/.test(lower) ||
        /\blayers?\s+(that\s+)?(i\s+)?can\s+calculate\s+statistics\s+for\b/.test(lower)
    )
}
